import { IncomingMessage } from "http";
import puppeteer, { Browser, CDPSession, Page } from "puppeteer-core";
import { Duplex } from "stream";
import WebSocket, { Server } from "ws";

import { env } from "../../env.js";
import { SessionService } from "../../services/session.service.js";
import {
  CloseTabEvent,
  GetSelectedTextEvent,
  InsertTextEvent,
  KeyEvent,
  MouseEvent,
  NavigationEvent,
  PageInfo,
} from "../../types/casting.js";
import { getPageFavicon, getPageTitle, navigatePage } from "../../utils/casting.js";
import { getPageViewport, PageViewport } from "./casting-viewport.js";

export async function handleCastSession(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  wss: Server,
  sessionService: SessionService,
  params: Record<string, string> | undefined,
): Promise<void> {
  const id = params?.sessionId;

  if (!id) {
    console.error("Cast Session ID not found");
    socket.destroy();
    return;
  }

  const session = sessionService.getSession(id);
  if (!session || session.status !== "live") {
    console.error(`Cast Session ${id} not found`);
    socket.destroy();
    return;
  }

  const queryParams = new URLSearchParams(request.url?.split("?")[1] || "");
  const requestedPageId = params?.pageId || queryParams.get("pageId") || null;
  const requestedPageIndex = params?.pageIndex || queryParams.get("pageIndex") || null;

  const tabDiscoveryMode =
    queryParams.get("tabInfo") === "true" || (!requestedPageId && !requestedPageIndex);

  const isMobile = session.deviceConfig?.device === "mobile";
  const defaultDimensions = isMobile ? { width: 508, height: 1074 } : { width: 1920, height: 1080 };
  const { height, width } =
    (session.dimensions as { width: number; height: number }) ?? defaultDimensions;

  wss.handleUpgrade(request, socket, head, async (ws) => {
    let browser: Browser | null = null;
    let targetPage: Page | null = null;
    let targetClient: CDPSession | null = null;
    let targetPageId: string | null = null;
    let viewportClient: ReturnType<PageViewport["attach"]> | null = null;

    const activePages = new Map<string, Page>();

    let heartbeatInterval: NodeJS.Timeout | null = null;

    const handleSessionCleanup = () => {
      viewportClient?.close();
      viewportClient = null;
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }

      if (targetPage) {
        targetPage.removeAllListeners("framenavigated");
      }

      // Clean up screencast
      if (targetClient) {
        try {
          targetClient.send("Page.stopScreencast").catch((err) => {
            // Ignore errors about closed targets
            if (!err.message?.includes("Target closed")) {
              console.error("Error stopping screencast:", err);
            }
          });

          targetClient.detach().catch((err) => {
            // Ignore errors about closed targets
            if (!err.message?.includes("Target closed")) {
              console.error("Error detaching client:", err);
            }
          });

          targetClient = null;
        } catch (err) {
          console.error("Error during screencast cleanup:", err);
        }
      }

      // Disconnect browser
      if (browser) {
        try {
          browser.disconnect().catch((err) => {
            console.error("Error disconnecting browser:", err);
          });
          browser = null;
        } catch (err) {
          console.error("Error during browser disconnect:", err);
        }
      }

      // Force garbage collection if available (Node.js with --expose-gc flag)
      if (global.gc) {
        try {
          global.gc();
        } catch (err) {
          console.error("Error during garbage collection:", err);
        }
      }
    };

    ws.once("close", handleSessionCleanup);

    const sendTabList = async () => {
      try {
        if (ws.readyState !== WebSocket.OPEN || !tabDiscoveryMode) return;

        const tabList: PageInfo[] = [];

        for (const [pageId, page] of activePages.entries()) {
          tabList.push({
            id: pageId,
            url: page.url(),
            title: await getPageTitle(page),
            favicon: await getPageFavicon(page),
          });
        }

        ws.send(
          JSON.stringify({
            type: "tabList",
            tabs: tabList,
            firstTabId: tabList.length > 0 ? tabList[0].id : null,
          }),
        );
      } catch (error) {
        console.error("Error sending tab list:", error);
      }
    };

    const findTargetPage = async (
      pages: Page[],
    ): Promise<{ page: Page; pageId: string } | null> => {
      if (tabDiscoveryMode) return null; // No target page in tab discovery mode

      if (requestedPageId) {
        for (const page of pages) {
          try {
            //@ts-expect-error
            const pageId = page.target()._targetId;
            if (pageId === requestedPageId) {
              return { page, pageId };
            }
          } catch (err) {
            console.error("Error accessing page target ID:", err);
          }
        }
      } else if (requestedPageIndex) {
        const index = parseInt(requestedPageIndex, 10);
        if (index >= 0 && index < pages.length) {
          const page = pages[index];
          //@ts-expect-error
          const pageId = page.target()._targetId;
          return { page, pageId };
        }
      }

      return null;
    };

    try {
      const browserEndpoint = new URL(`ws://${env.HOST}:${env.PORT}`);
      browserEndpoint.searchParams.set("sessionId", id);
      browser = await puppeteer.connect({
        browserWSEndpoint: browserEndpoint.toString(),
        defaultViewport: null,
      });

      if (!browser) {
        console.error("Failed to connect to browser");
        socket.destroy();
        return;
      }
      if (ws.readyState !== WebSocket.OPEN) {
        handleSessionCleanup();
        return;
      }

      const pages = await browser.pages();

      if (tabDiscoveryMode) {
        for (const page of pages) {
          //@ts-expect-error
          const pageId = page.target()._targetId;
          activePages.set(pageId, page);
        }

        // Initial tab list
        await sendTabList();

        // Setup page creation/deletion tracking
        browser.on("targetcreated", async (target) => {
          if (target.type() === "page") {
            try {
              const page = await target.asPage();
              //@ts-expect-error
              const pageId = target._targetId;
              activePages.set(pageId, page);
              await sendTabList();
            } catch (err) {
              console.error("Error handling new target:", err);
            }
          }
        });

        browser.on("targetdestroyed", async (target) => {
          if (target.type() === "page") {
            try {
              //@ts-expect-error
              const pageId = target._targetId;
              if (activePages.has(pageId)) {
                activePages.delete(pageId);

                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(
                    JSON.stringify({
                      type: "tabClosed",
                      pageId,
                    }),
                  );

                  await sendTabList();
                }
              }
            } catch (err) {
              console.error("Error handling destroyed target:", err);
            }
          }
        });

        // Setup heartbeat to detect dead connections
        heartbeatInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.ping();
            } catch (err) {
              console.error("Error sending ping:", err);
              handleSessionCleanup();
            }
          } else {
            handleSessionCleanup();
          }
        }, 30000);

        ws.on("error", (err) => {
          console.error("Tab discovery WebSocket error:", err);
          handleSessionCleanup();
        });

        return;
      } else {
        const targetResult = await findTargetPage(pages);

        if (!targetResult) {
          console.error(
            `Target page not found for ${
              requestedPageId ? `pageId=${requestedPageId}` : `pageIndex=${requestedPageIndex}`
            }`,
          );
          socket.destroy();
          return;
        }

        targetPage = targetResult.page;
        targetPageId = targetResult.pageId;

        await targetPage.bringToFront();

        // Setup screencast for the target page
        targetClient = await targetPage.target().createCDPSession();
        if (ws.readyState !== WebSocket.OPEN) {
          handleSessionCleanup();
          return;
        }
        viewportClient = getPageViewport(sessionService.getCDPService(id), targetPageId, {
          width,
          height,
          mobile: isMobile,
        }).attach((message) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
        });

        ws.on("message", async (message) => {
          try {
            const data:
              | MouseEvent
              | KeyEvent
              | InsertTextEvent
              | NavigationEvent
              | CloseTabEvent
              | GetSelectedTextEvent
              | { type: "viewport" } = JSON.parse(message.toString());
            const { type } = data;

            if (!targetClient || !targetPage) {
              console.error("No target page or client available for input handling");
              return;
            }

            if (type === "viewport") {
              await viewportClient?.resize(data, async (viewport, reload) => {
                if (!targetClient || !targetPage || ws.readyState !== WebSocket.OPEN)
                  throw new Error("Viewer disconnected");
                await targetClient.send("Emulation.setDeviceMetricsOverride", {
                  width: viewport.width,
                  height: viewport.height,
                  screenWidth: viewport.width,
                  screenHeight: viewport.height,
                  mobile: viewport.mobile,
                  deviceScaleFactor: 1,
                  screenOrientation:
                    viewport.width > viewport.height
                      ? { angle: 90, type: "landscapePrimary" }
                      : { angle: 0, type: "portraitPrimary" },
                });
                await targetClient.send("Emulation.setTouchEmulationEnabled", {
                  enabled: viewport.mobile,
                  maxTouchPoints: 1,
                });
                if (reload)
                  await targetPage.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
                await targetClient.send("Page.stopScreencast");
                await targetClient.send("Page.startScreencast", {
                  format: "jpeg",
                  quality: 75,
                  maxWidth: 2560,
                  maxHeight: 1600,
                });
              });
              return;
            }
            if (!viewportClient?.canControl()) return;

            switch (type) {
              case "mouseEvent": {
                const { event } = data as MouseEvent;
                await targetClient.send("Input.dispatchMouseEvent", {
                  type: event.type,
                  x: event.x,
                  y: event.y,
                  button: event.button,
                  buttons: event.button === "none" ? 0 : 1,
                  clickCount: event.clickCount || 1,
                  modifiers: event.modifiers || 0,
                  deltaX: event.deltaX,
                  deltaY: event.deltaY,
                });
                break;
              }
              case "keyEvent": {
                const { event } = data as KeyEvent;
                await targetClient.send("Input.dispatchKeyEvent", {
                  type: event.type,
                  text: event.text,
                  unmodifiedText: event.text ? event.text.toLowerCase() : undefined,
                  code: event.code,
                  key: event.key,
                  windowsVirtualKeyCode: event.keyCode,
                  nativeVirtualKeyCode: event.keyCode,
                  modifiers: event.modifiers || 0,
                  autoRepeat: false,
                  isKeypad: false,
                  isSystemKey: false,
                });
                break;
              }
              case "insertText": {
                const { text } = data as InsertTextEvent;
                await targetClient.send("Input.insertText", { text });
                break;
              }
              case "navigation": {
                const { event } = data as NavigationEvent;
                await navigatePage(event, targetPage);
                break;
              }
              case "closeTab": {
                const { pageId } = data as CloseTabEvent;
                await targetPage?.close();
                if (activePages.has(pageId)) {
                  activePages.delete(pageId);
                }
                break;
              }
              case "getSelectedText": {
                try {
                  const selectedText = await targetPage.evaluate(() => {
                    const selection = window.getSelection();
                    return selection ? selection.toString() : "";
                  });

                  // Send the selected text back to the client
                  ws.send(
                    JSON.stringify({
                      type: "selectedTextResponse",
                      pageId: (data as GetSelectedTextEvent).pageId,
                      text: selectedText,
                    }),
                  );
                } catch (error) {
                  console.error("Failed to get selected text:", error);
                  ws.send(
                    JSON.stringify({
                      type: "selectedTextResponse",
                      pageId: (data as GetSelectedTextEvent).pageId,
                      text: "",
                      error: error instanceof Error ? error.message : "Unknown error",
                    }),
                  );
                }
                break;
              }

              default:
                console.warn("Unknown event type:", type);
            }
          } catch (err) {
            console.error("Error handling WebSocket message:", err);
          }
        });

        // Handle screencast frames
        targetClient.on("Page.screencastFrame", async ({ data, sessionId, metadata }) => {
          try {
            // Acknowledge the frame right away to free up memory
            await targetClient?.send("Page.screencastFrameAck", { sessionId });

            if (ws.readyState === WebSocket.OPEN) {
              // Get page metadata
              const title = await getPageTitle(targetPage!);
              const favicon = await getPageFavicon(targetPage!);

              // Send frame data
              ws.send(
                JSON.stringify({
                  pageId: targetPageId,
                  url: targetPage?.url(),
                  title,
                  favicon,
                  data,
                  metadata,
                }),
              );
            }
          } catch (err) {
            if (targetClient && ws.readyState === WebSocket.OPEN) {
              console.error("Error in Page.screencastFrame handler:", err);
            }
          }
        });

        await targetClient.send("Page.startScreencast", {
          format: "jpeg",
          quality: 75,
          maxWidth: 2560,
          maxHeight: 1600,
        });
        viewportClient.ready();

        // Cleanup when target is destroyed
        browser.on("targetdestroyed", async (target) => {
          if (target.type() === "page") {
            try {
              //@ts-expect-error
              const pageId = target._targetId;

              if (pageId === targetPageId) {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(
                    JSON.stringify({
                      type: "targetClosed",
                      pageId: targetPageId,
                    }),
                  );
                }

                // Cleanup and close connection
                handleSessionCleanup();
                ws.close();
              }
            } catch (err) {
              console.error("Error handling destroyed target:", err);
            }
          }
        });

        // Setup heartbeat to detect dead connections
        heartbeatInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.ping();
            } catch (err) {
              console.error("Error sending ping:", err);
              handleSessionCleanup();
            }
          } else {
            handleSessionCleanup();
          }
        }, 30000);

        // Handle errors
        ws.on("error", (err) => {
          console.error("Cast WebSocket error:", err);
          handleSessionCleanup();
        });
      }
    } catch (err) {
      console.error("Error in cast session:", err);
      handleSessionCleanup();
      socket.destroy();
    }
  });
}
