import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Browser, CDPSession, Page } from "puppeteer-core";
import type { CdpFrame } from "puppeteer-core/internal/cdp/Frame.js";
import WebSocket, { type Server } from "ws";
import { z } from "zod";
import type { SessionService } from "../../services/session.service.js";
import { getPageFavicon, getPageTitle, navigatePage } from "../../utils/casting.js";
import { CastingInput, INPUT_VERSION, ViewerInputError } from "./casting-input.js";
import { getPageViewport, type PageViewport } from "./casting-viewport.js";

const envelope = z.object({
  version: z.literal(INPUT_VERSION),
  type: z.string(),
  generation: z.number().int().nonnegative(),
});
const actionEnvelope = envelope.extend({
  pageId: z.string(),
  viewportGeneration: z.number().int().nonnegative(),
  sequence: z.number().int().positive(),
});
const navigation = actionEnvelope
  .extend({
    type: z.literal("navigation"),
    event: z
      .object({
        url: z.string().url().max(4096).optional(),
        action: z.enum(["back", "forward", "refresh"]).optional(),
      })
      .strict(),
  })
  .strict();

/** A page accepts input from one viewer connection with matching frame geometry. */
export async function handleCastSession(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  wss: Server,
  sessionService: SessionService,
  params: Record<string, string> | undefined,
): Promise<void> {
  const id = params?.sessionId;
  const session = id ? sessionService.getSession(id) : undefined;
  if (!id || !session || session.status !== "live") {
    socket.end("HTTP/1.1 410 Gone\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  const runtime = sessionService.getCDPService(id);
  const query = new URL(request.url ?? "/", "http://viewer.invalid").searchParams;
  const requestedPageId = params?.pageId || query.get("pageId");
  const requestedPageIndex = params?.pageIndex || query.get("pageIndex");
  const discovery =
    query.get("tabInfo") === "true" || (!requestedPageId && requestedPageIndex === null);
  const startedAt = Date.parse(session.createdAt);
  const hardDeadline =
    session.timeout > 0 && Number.isFinite(startedAt)
      ? startedAt + session.timeout
      : Number.MAX_SAFE_INTEGER;
  const forwardedExpiry = Number(request.headers["x-viewer-expires-at"]);
  const expiresAt = Math.min(
    hardDeadline,
    Number.isFinite(forwardedExpiry) && forwardedExpiry > 0 ? forwardedExpiry : hardDeadline,
  );
  if (expiresAt <= Date.now()) {
    socket.end("HTTP/1.1 410 Gone\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    let browser: Browser | undefined;
    let page: Page | undefined;
    let client: CDPSession | undefined;
    let pageId = "";
    let detachListeners = () => {};
    let viewport: ReturnType<PageViewport["attach"]> | undefined;
    let viewportGeneration = 0;
    let frameReady = false;
    let reloadForViewer = false;
    let awaitingNavigation = false;
    let bounds = { width: 0, height: 0 };
    let expected = { width: 0, height: 0 };
    let frameId = 0;
    let lastSequence = 0;
    let negotiated = false;
    let closed = false;
    let messageQueue = Promise.resolve();
    let queued = 0;
    const frames = new Map<
      number,
      { generation: number; viewportGeneration: number; width: number; height: number }
    >();
    let initialize!: () => void;
    const initialized = new Promise<void>((resolve) => {
      initialize = resolve;
    });
    const send = (message: Record<string, unknown>) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    };
    const publishControl = () => {
      const state = viewport?.snapshot();
      if (!state) return;
      if (!state.controlling) frameReady = false;
      send({ type: "controlState", version: INPUT_VERSION, ...state, viewportGeneration });
    };
    const authorize = (message: {
      pageId: string;
      generation: number;
      viewportGeneration: number;
    }) => {
      viewport?.assertControl(message.generation);
      if (message.pageId !== pageId) throw new ViewerInputError("wrong_page");
      if (
        !frameReady ||
        message.viewportGeneration !== viewportGeneration ||
        !viewport?.canControl()
      )
        throw new ViewerInputError("waiting_for_frame");
      return bounds;
    };
    const readAgent = async () => {
      if (!client || !page) throw new ViewerInputError("session_expired");
      const metrics = await client.send("Page.getLayoutMetrics");
      return {
        width: metrics.cssLayoutViewport.clientWidth,
        height: metrics.cssLayoutViewport.clientHeight,
        mobile: page.viewport()?.isMobile ?? session.deviceConfig?.device === "mobile",
      };
    };
    const input = new CastingInput(async (method, parameters) => {
      if (!client) throw new ViewerInputError("session_expired");
      return client.send(method as Parameters<CDPSession["send"]>[0], parameters);
    }, authorize);
    const reset = async () => {
      frameReady = false;
      await input.reset();
    };
    const close = async () => {
      if (closed) return;
      closed = true;
      detachListeners();
      clearInterval(heartbeat);
      clearTimeout(expiryTimer);
      // Revoke immediately, then drain this connection before releasing its CDP attachment.
      const revoked = viewport?.close();
      await messageQueue.catch(() => {});
      await revoked?.catch(() => {});
      await input.reset().catch(() => {});
      await client?.send("Page.stopScreencast").catch(() => {});
      await client?.detach().catch(() => {});
    };
    let expiryTimer: NodeJS.Timeout | undefined;
    const checkExpiry = () => {
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) {
        send({ type: "inputError", code: "session_expired" });
        void close();
        ws.close(4001, "Session expired");
      } else {
        expiryTimer = setTimeout(checkExpiry, Math.min(2_147_483_647, remaining));
        expiryTimer.unref();
      }
    };
    if (expiresAt < Number.MAX_SAFE_INTEGER) {
      expiryTimer = setTimeout(
        checkExpiry,
        Math.max(0, Math.min(2_147_483_647, expiresAt - Date.now())),
      );
      expiryTimer.unref();
    }
    let alive = true;
    ws.on("pong", () => {
      alive = true;
    });
    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, 15_000);
    heartbeat.unref();
    ws.on("close", () => {
      void close();
    });
    ws.on("error", () => {
      void close();
    });

    const handle = async (raw: WebSocket.RawData) => {
      await initialized;
      if (Date.now() >= expiresAt) throw new ViewerInputError("session_expired");
      if (closed || !client || !page || discovery) return;
      const data = JSON.parse(String(raw));
      if (data.type === "hello") {
        if (data.version !== INPUT_VERSION) throw new ViewerInputError("unsupported_input_version");
        negotiated = true;
        send({
          type: "hello",
          version: INPUT_VERSION,
          pageId,
          expiresAt,
          capabilities: ["touch", "mouse", "keyboard", "composition"],
        });
        viewport?.ready();
        return;
      }
      if (!negotiated) throw new ViewerInputError("unsupported_input_version");
      const message = envelope.parse(data);
      if (message.type === "control") {
        if (data.action === "acquire") {
          await viewport?.acquire(async () => {
            const userAgent = request.headers["user-agent"];
            if (
              !page ||
              closed ||
              typeof userAgent !== "string" ||
              !userAgent.trim() ||
              userAgent.length > 2048
            )
              return;
            // A fingerprint can pin an HTTP User-Agent independently of the CDP
            // override. Puppeteer's CDP network manager holds those extra headers.
            const headers = {
              ...(
                page.mainFrame() as unknown as CdpFrame
              )._frameManager.networkManager.extraHTTPHeaders(),
            };
            const previousAgent =
              headers["user-agent"] ?? (await page.evaluate(() => navigator.userAgent));
            if (closed) return;
            delete headers["user-agent"];
            await page.setExtraHTTPHeaders(headers);
            await page.setUserAgent(userAgent);
            reloadForViewer = previousAgent !== userAgent;
          });
          if (closed) await viewport?.close();
        } else if (data.action === "release") {
          viewport?.assertControl(message.generation);
          await viewport?.release();
        } else if (data.action === "pause") {
          viewport?.assertControl(message.generation);
          await viewport?.release();
        } else throw new ViewerInputError("invalid_control_action");
        return;
      }
      viewport?.assertControl(message.generation);
      if (message.type === "cancelInput") {
        await input.reset();
        return;
      }
      if (message.type === "viewport") {
        let reloadPage = reloadForViewer;
        frameReady = false;
        viewportGeneration++;
        frames.clear();
        await input.reset();
        await viewport?.resize(
          data,
          async (next, reload) => {
            if (!client || !page || closed) throw new ViewerInputError("session_expired");
            expected = { width: next.width, height: next.height };
            await client.send("Emulation.setDeviceMetricsOverride", {
              ...expected,
              screenWidth: next.width,
              screenHeight: next.height,
              mobile: next.mobile,
              deviceScaleFactor: 1,
              screenOrientation:
                next.width > next.height
                  ? { angle: 90, type: "landscapePrimary" }
                  : { angle: 0, type: "portraitPrimary" },
            });
            await client.send("Emulation.setTouchEmulationEnabled", {
              enabled: next.mobile,
              maxTouchPoints: 1,
            });
            reloadPage ||= reload;
          },
          readAgent,
        );
        if (reloadPage) {
          // Apply identity and layout together. Navigation completion must not
          // block control; a frame from the committed document enables input.
          awaitingNavigation = true;
          await client.send("Page.reload");
          reloadForViewer = false;
        }
        await client.send("Page.stopScreencast");
        await client.send("Page.startScreencast", {
          format: "jpeg",
          quality: 75,
          maxWidth: 2560,
          maxHeight: 1600,
        });
        publishControl();
        return;
      }
      if (message.type === "frameReady") {
        if (awaitingNavigation) throw new ViewerInputError("waiting_for_frame");
        const frame = frames.get(data.frameId);
        if (
          !frame ||
          frame.generation !== message.generation ||
          frame.viewportGeneration !== viewportGeneration
        )
          throw new ViewerInputError("stale_frame");
        bounds = { width: frame.width, height: frame.height };
        frameReady = true;
        send({
          type: "inputReady",
          generation: message.generation,
          viewportGeneration,
          frameId: data.frameId,
        });
        return;
      }
      const action = actionEnvelope.parse(data);
      if (action.sequence <= lastSequence) throw new ViewerInputError("invalid_sequence");
      lastSequence = action.sequence;
      authorize(action);
      if (message.type === "navigation") {
        const { event } = navigation.parse(data);
        if (event.url && !["http:", "https:"].includes(new URL(event.url).protocol))
          throw new ViewerInputError("invalid_navigation");
        frameReady = false;
        viewportGeneration++;
        await input.reset();
        await navigatePage(event, page);
        publishControl();
      } else if (message.type === "closeTab") {
        await input.reset();
        await page.close();
      } else if (message.type === "getSelectedText") {
        send({
          type: "selectedTextResponse",
          pageId,
          text: await page.evaluate(() => {
            const focused = document.activeElement;
            if (
              (focused instanceof HTMLInputElement && focused.type !== "password") ||
              focused instanceof HTMLTextAreaElement
            ) {
              if (focused.selectionStart !== null && focused.selectionEnd !== null)
                return focused.value.slice(focused.selectionStart, focused.selectionEnd);
            }
            return window.getSelection()?.toString() ?? "";
          }),
        });
      } else {
        await input.dispatch(data);
      }
    };
    ws.on("message", (raw) => {
      if (queued >= 256 || Buffer.byteLength(String(raw)) > 256 * 1024) {
        void close();
        ws.close(1008, "Input queue limit");
        return;
      }
      queued++;
      const operation = messageQueue.then(() => handle(raw));
      messageQueue = operation
        .catch(async (error) => {
          const code = error instanceof ViewerInputError ? error.code : "invalid_input";
          send({
            type: "inputError",
            code,
            generation: viewport?.snapshot().generation ?? 0,
            viewportGeneration,
          });
          // Values and capabilities never enter diagnostics.
          if (code === "unsupported_input_version" || code === "session_expired") {
            void close();
            ws.close(code === "session_expired" ? 4001 : 4002, "Viewer input unavailable");
          }
          if (code !== "stale_frame" && code !== "waiting_for_frame" && viewport?.canControl())
            await input.reset().catch(() => {});
        })
        .finally(() => {
          queued--;
        });
    });

    void (async () => {
      try {
        browser = runtime.getBrowserInstance() ?? undefined;
        if (!browser) throw new Error("Browser unavailable");
        const pages = await browser.pages();
        if (closed) return;
        if (discovery) {
          const sendTabs = async () => {
            if (!browser || closed) return;
            const tabs = await Promise.all(
              (await browser.pages()).map(async (item) => {
                const target = item.target() as ReturnType<Page["target"]> & { _targetId: string };
                return {
                  id: target._targetId,
                  url: item.url(),
                  title: await getPageTitle(item),
                  favicon: await getPageFavicon(item),
                };
              }),
            );
            send({ type: "tabList", tabs, firstTabId: tabs[0]?.id });
          };
          const updateTabs = () => {
            void sendTabs().catch(() => {});
          };
          browser.on("targetcreated", updateTabs);
          browser.on("targetchanged", updateTabs);
          browser.on("targetdestroyed", updateTabs);
          detachListeners = () => {
            browser?.off("targetcreated", updateTabs);
            browser?.off("targetchanged", updateTabs);
            browser?.off("targetdestroyed", updateTabs);
          };
          await sendTabs();
          return;
        }
        page = requestedPageId
          ? pages.find(
              (item) =>
                (item.target() as ReturnType<Page["target"]> & { _targetId: string })._targetId ===
                requestedPageId,
            )
          : pages[Number(requestedPageIndex ?? 0)];
        if (!page) throw new Error("Page unavailable");
        pageId = (page.target() as ReturnType<Page["target"]> & { _targetId: string })._targetId;
        await page.bringToFront();
        client = await page.createCDPSession();
        const initial = session.dimensions ?? { width: 1920, height: 1080 };
        expected = { width: initial.width, height: initial.height };
        viewport = getPageViewport(runtime, pageId, {
          ...initial,
          mobile: page.viewport()?.isMobile ?? session.deviceConfig?.device === "mobile",
        }).attach((message) => {
          send({
            ...message,
            viewportGeneration,
            controlling: viewport?.canControl() && message.controlling,
          });
          publishControl();
        }, reset);
        client.on("Page.screencastFrame", async ({ data, sessionId, metadata }) => {
          if (
            viewport?.mode() === "agent" &&
            (metadata.deviceWidth !== expected.width || metadata.deviceHeight !== expected.height)
          ) {
            expected = { width: metadata.deviceWidth, height: metadata.deviceHeight };
            frameReady = false;
            viewportGeneration++;
            frames.clear();
            await input.reset();
            publishControl();
          }
          const generation = viewport?.snapshot().generation ?? 0;
          const epoch = viewportGeneration;
          await client?.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
          if (
            closed ||
            generation !== (viewport?.snapshot().generation ?? 0) ||
            epoch !== viewportGeneration
          )
            return;
          const frame = ++frameId;
          if (
            metadata.deviceWidth === expected.width &&
            metadata.deviceHeight === expected.height
          ) {
            const scale = metadata.pageScaleFactor || 1;
            frames.set(frame, {
              generation,
              viewportGeneration: epoch,
              width: metadata.deviceWidth / scale,
              height: (metadata.deviceHeight - metadata.offsetTop) / scale,
            });
            if (frames.size > 32) frames.delete(frames.keys().next().value!);
          }
          send({
            pageId,
            url: page?.url(),
            data,
            metadata,
            frameId: frame,
            generation,
            viewportGeneration: epoch,
          });
        });
        const pageClosed = () => {
          send({ type: "targetClosed", pageId });
          ws.close(4001, "Page closed");
        };
        page.on("close", pageClosed);
        detachListeners = () => {
          page?.off("close", pageClosed);
        };
        // Chrome can retain the last capture surface after another CDP client
        // changes emulation metrics. Restart capture on an agent resize instead
        // of relying on a new screencast frame to announce the new geometry.
        let resizeQueued = false;
        client.on("Page.frameNavigated", ({ frame }) => {
          if (frame.parentId || closed) return;
          const operation = messageQueue.then(async () => {
            if (closed || !client) return;
            awaitingNavigation = false;
            frameReady = false;
            viewportGeneration++;
            frames.clear();
            await input.reset();
            await client.send("Page.stopScreencast");
            await client.send("Page.startScreencast", {
              format: "jpeg",
              quality: 75,
              maxWidth: 2560,
              maxHeight: 1600,
            });
            publishControl();
          });
          messageQueue = operation.catch(() => {
            send({ type: "inputError", code: "session_expired" });
            ws.close(4001, "Browser unavailable");
          });
        });
        client.on("Page.frameResized", () => {
          if (closed || resizeQueued) return;
          resizeQueued = true;
          const operation = messageQueue.then(async () => {
            resizeQueued = false;
            if (closed || !client || viewport?.mode() !== "agent") return;
            const next = await readAgent();
            if (next.width === expected.width && next.height === expected.height) return;
            expected = { width: next.width, height: next.height };
            frameReady = false;
            viewportGeneration++;
            frames.clear();
            await input.reset();
            await client.send("Page.stopScreencast");
            await client.send("Page.startScreencast", {
              format: "jpeg",
              quality: 75,
              maxWidth: 2560,
              maxHeight: 1600,
            });
            publishControl();
          });
          messageQueue = operation.catch(() => {
            send({ type: "inputError", code: "session_expired" });
            ws.close(4001, "Browser unavailable");
          });
        });
        await client.send("Page.enable");
        await client.send("Page.startScreencast", {
          format: "jpeg",
          quality: 75,
          maxWidth: 2560,
          maxHeight: 1600,
        });
      } catch {
        send({ type: "inputError", code: "session_expired" });
        ws.close(4001, "Browser unavailable");
      } finally {
        initialize();
        if (closed) {
          detachListeners();
          await client?.detach().catch(() => {});
        }
      }
    })();
  });
}
