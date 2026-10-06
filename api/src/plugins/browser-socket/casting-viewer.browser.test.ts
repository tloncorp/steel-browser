import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ejs from "ejs";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { WebSocket, WebSocketServer } from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionService } from "../../services/session.service.js";
import { handleCastSession } from "./casting.handler.js";

const executablePath = process.env.CHROME_EXECUTABLE_PATH || "/usr/bin/google-chrome";
const hasChrome = existsSync(executablePath);
if (!hasChrome)
  console.warn("Skipping live casting tests: set CHROME_EXECUTABLE_PATH to a local Chrome.");

describe.skipIf(!hasChrome)("adaptive streamed viewer in Chrome", () => {
  let browser: Browser;
  const viewerBrowsers: Browser[] = [];
  let publicServer: Server;
  let internalServer: Server;
  let viewerOrigin: string;
  let viewerEntry: string;
  let mintViewerEntry: (expiresAt: number) => string;
  let server: Server;
  let wss: WebSocketServer;
  let target: Page;
  let origin: string;
  let pageId: string;
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const errors: string[] = [];
  const session = { id: sessionId, status: "live", dimensions: { width: 1920, height: 1080 } };
  const sessionRuntime = { getBrowserInstance: () => browser };

  beforeAll(async () => {
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    wss = new WebSocketServer({ noServer: true });
    server = createServer(async (request, response) => {
      response.setHeader("content-type", "text/html");
      if (request.url === "/fixture") {
        response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
          <title>Responsive test page</title><style>
          body { margin:0; font:20px sans-serif; background:#f2f4f8; min-height:2400px; }
          header { background:#17385d; color:white; padding:24px; }
          button,input { font:20px sans-serif; margin:20px; padding:12px; }
          #layout:after {content:'Desktop';} @media(max-width:600px) {#layout:after {content:'Phone';}}
          </style><header id="layout"></header><button id="tap" onclick="this.textContent='Tapped'">Tap here</button>
          <input id="draft" value="Unsent login text">
          <div id="slider" style="margin:20px;width:280px;height:45px;background:#aef;touch-action:none;user-select:none">Drag me</div>
          <button id="hold" style="touch-action:none">Hold me</button>
          <div id="touch-only" style="margin:20px;width:280px;height:45px;background:#fea;touch-action:none">Touch only</div>
          <div id="nested" style="margin:20px;height:100px;overflow:auto;background:#ddd"><div style="height:800px">Nested scroll</div></div>
          <iframe id="framed" src="http://localhost:${
            (server.address() as AddressInfo).port
          }/frame" style="width:300px;height:130px"></iframe>
          <script>
          window.points=[];window.holds=[];window.touchMoves=[];window.enterCount=0;window.keys=[];document.addEventListener("keydown",e=>window.keys.push(e.key));
          document.querySelector('#draft').addEventListener('keydown', e => {if(e.key==='Enter'){window.enterCount++;e.preventDefault();}});
          const slider=document.querySelector('#slider');
          slider.onpointerdown=e=>{slider.setPointerCapture(e.pointerId);window.points.push(['down',e.clientX]);};
          slider.onpointermove=e=>{if(e.buttons)window.points.push(['move',e.clientX]);};
          slider.onpointerup=e=>window.points.push(['up',e.clientX]);
          slider.onpointercancel=e=>window.points.push(['cancel',e.clientX]);
          const hold=document.querySelector('#hold'); let started=0;
          hold.onpointerdown=e=>{started=performance.now();hold.setPointerCapture(e.pointerId);};
          hold.onpointerup=e=>window.holds.push(performance.now()-started);
          const touchOnly=document.querySelector('#touch-only');
          touchOnly.addEventListener('touchstart',e=>e.preventDefault(),{passive:false});
          touchOnly.addEventListener('touchmove',e=>{e.preventDefault();window.touchMoves.push(e.touches[0].clientX);},{passive:false});
          sessionStorage.loads=String(Number(sessionStorage.loads||0)+1);
          </script>`);
      } else if (request.url === "/dashboard") {
        response.end(
          `<iframe src="/?clipboardBridge=true" style="width:800px;height:1000px"></iframe><script>window.messages=[];addEventListener('message',event=>window.messages.push(event.data));</script>`,
        );
      } else if (request.url === "/frame") {
        response.end(
          `<button id="frame-hold" style="width:200px;height:60px;touch-action:none">Hold in frame</button><script>window.held=0;let start=0;let el=document.querySelector('button');el.onpointerdown=e=>{start=performance.now();el.setPointerCapture(e.pointerId)};el.onpointerup=()=>{window.held=performance.now()-start};</script>`,
        );
      } else {
        response.end(
          await ejs.renderFile(
            fileURLToPath(new URL("../../templates/live-session-streamer.ejs", import.meta.url)),
            {
              theme: "light",
              singlePageMode: !request.url?.includes("multi=1"),
              showControls: !request.url?.includes("controls=0"),
              interactive: !request.url?.includes("watch=1"),
              dimensions: session.dimensions,
              wsUrl: `${origin.replace("http:", "ws:")}/v1/sessions/cast?sessionId=${sessionId}${
                request.url?.includes("multi=1") ? "" : `&pageId=${pageId}`
              }`,
            },
          ),
        );
      }
    });
    server.on("upgrade", (request, socket, head) => {
      void handleCastSession(
        request,
        socket,
        head,
        wss,
        {
          getSession: (id: string) => (id === sessionId ? { ...session } : undefined),
          getCDPService: () => sessionRuntime,
        } as unknown as SessionService,
        Object.fromEntries(new URL(request.url!, origin).searchParams),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const gatewayPath = fileURLToPath(
      new URL("../../../../session-viewer/server.mjs", import.meta.url),
    );
    const { createGateway, mintCapability } = await import(gatewayPath);
    const config = {
      secret: "casting-test-signing-key-at-least-thirty-two-bytes",
      upstreamOrigin: origin,
      publicOrigin: "http://127.0.0.1",
      maximumTtlMs: 7_200_000,
    };
    const gateway = createGateway(config);
    publicServer = gateway.publicServer;
    internalServer = gateway.internal;
    await new Promise<void>((resolve) => publicServer.listen(0, "127.0.0.1", resolve));
    viewerOrigin = `http://127.0.0.1:${(publicServer.address() as AddressInfo).port}`;
    config.publicOrigin = viewerOrigin;
    mintViewerEntry = (expiresAt) =>
      `${viewerOrigin}/s/${mintCapability({ sessionId, expiresAt }, config.secret)}`;
    viewerEntry = mintViewerEntry(Date.now() + 600_000);
    target = await browser.newPage();
    target.setDefaultTimeout(5000);
    await target.setViewport({ width: 1920, height: 1080 });
    await target.goto(`${origin}/fixture`);
    const cdp = await target.createCDPSession();
    pageId = (await cdp.send("Target.getTargetInfo")).targetInfo.targetId;
    await cdp.detach();
  });

  afterEach(async () => {
    await Promise.all(viewerBrowsers.splice(0).map((item) => item.close()));
    expect(errors.splice(0)).toEqual([]);
  });

  afterAll(async () => {
    await Promise.all(viewerBrowsers.map((item) => item.close()));
    publicServer?.close();
    internalServer?.close();
    await browser?.close();
    for (const socket of wss?.clients ?? []) socket.terminate();
    wss?.close();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    vi.restoreAllMocks();
  });

  async function viewer(width: number, height: number, route = "/") {
    const viewerBrowser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    viewerBrowsers.push(viewerBrowser);
    const page = await viewerBrowser.newPage();
    page.setDefaultTimeout(5000);
    await page.setViewport({ width, height, deviceScaleFactor: 3, hasTouch: true });
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(
      route === "/watch" ? `${origin}/?watch=1` : route === "/" ? viewerEntry : route,
    );
    await page.waitForFunction(
      () =>
        document.querySelector("canvas")!.width > 0 &&
        document.querySelector("canvas")!.style.width !== "",
    );
    return page;
  }

  async function ready(page: Page) {
    await page.waitForFunction(
      () => document.querySelector("#stage")?.getAttribute("data-ready") === "true",
    );
  }
  async function pointOn(phone: Page, selector: string) {
    const point = await target.$eval(selector, (el) => {
      const rect = el.getBoundingClientRect();
      return {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        width: innerWidth,
        height: innerHeight,
      };
    });
    return phone.$eval(
      "canvas",
      (el, point) => {
        const rect = el.getBoundingClientRect();
        return {
          x: rect.x + (point.x * rect.width) / point.width,
          y: rect.y + (point.y * rect.height) / point.height,
        };
      },
      point,
    );
  }
  async function finger(phone: Page, selector: string, distance: number, hold = 0) {
    const start = await pointOn(phone, selector);
    const cdp = await phone.createCDPSession();
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ ...start, id: 1 }],
    });
    if (hold) await new Promise((resolve) => setTimeout(resolve, hold));
    for (let i = 1; i <= 5 && distance; i++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: start.x + (distance * i) / 5, y: start.y, id: 1 }],
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
  }

  it("reflows without reload, confirms mobile mode, maps touch, rotates, and transfers ownership", async () => {
    const phone = await viewer(390, 844);
    await target.waitForFunction(() => innerWidth === 390);
    await expect.poll(() => phone.$eval("canvas", (el) => el.width), { timeout: 5000 }).toBe(390);
    if (process.env.CASTING_VIEWER_EVIDENCE_DIR) {
      await phone.screenshot({
        path: join(process.env.CASTING_VIEWER_EVIDENCE_DIR, "auto-phone.png"),
      });
    }
    expect(await target.$eval("#layout", (el) => getComputedStyle(el, ":after").content)).toBe(
      '"Phone"',
    );
    await target.$eval("#draft", (el) => {
      (el as HTMLInputElement).value = "Keep my input";
    });
    expect(await target.evaluate(() => sessionStorage.loads)).toBe("1");
    const originalAgent = await target.evaluate(() => navigator.userAgent);

    await phone.select("#viewport-mode", "mobile");
    await phone.waitForSelector("#viewport-confirm[open]");
    await phone.click("#viewport-cancel");
    await expect
      .poll(() => phone.$eval("#viewport-mode", (el) => (el as HTMLSelectElement).value), {
        timeout: 5000,
      })
      .toBe("auto");
    expect(await target.evaluate(() => sessionStorage.loads)).toBe("1");
    expect(await target.$eval("#draft", (el) => (el as HTMLInputElement).value)).toBe(
      "Keep my input",
    );
    await phone.select("#viewport-mode", "mobile");
    await phone.waitForSelector("#viewport-confirm[open]");
    await phone.click("#viewport-reload");
    await target.waitForFunction(() => sessionStorage.loads === "2");
    expect(await target.evaluate(() => navigator.maxTouchPoints)).toBe(1);
    expect(await target.evaluate(() => navigator.userAgent)).toBe(originalAgent);

    await ready(phone);
    const point = await pointOn(phone, "#tap");
    await phone.touchscreen.tap(point.x, point.y);
    await target.waitForFunction(() => document.querySelector("#tap")!.textContent === "Tapped");
    await phone.select("#interaction-mode", "scroll");
    const input = await phone.createCDPSession();
    const scrollPoint = await phone.$eval("canvas", (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width * 0.98, y: r.y + r.height * 0.8, distance: r.height * 0.5 };
    });
    await input.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: scrollPoint.x, y: scrollPoint.y }],
    });
    await input.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: scrollPoint.x, y: scrollPoint.y - scrollPoint.distance }],
    });
    await input.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await target.waitForFunction(() => scrollY > 100);
    await input.detach();

    await phone.select("#viewport-mode", "auto");
    await phone.waitForSelector("#viewport-confirm[open]");
    await phone.click("#viewport-reload");
    await expect
      .poll(() => target.evaluate(() => sessionStorage.loads), { timeout: 5000 })
      .toBe("3");
    await phone.setViewport({ width: 844, height: 390, deviceScaleFactor: 3, hasTouch: true });
    await target.waitForFunction(() => innerWidth === 844);
    expect(await target.evaluate(() => sessionStorage.loads)).toBe("3");
    await target.evaluate(() => scrollTo(0, 0));
    await phone.select("#viewport-mode", "desktop");
    await target.waitForFunction(() => innerWidth === 1920);
    await phone.waitForFunction(() => document.querySelector("canvas")!.width === 1920);
    expect(
      await phone.$eval("canvas", (el) => {
        const rect = el.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
      }),
    ).toBe(true);
    if (process.env.CASTING_VIEWER_EVIDENCE_DIR) {
      await phone.screenshot({
        path: join(process.env.CASTING_VIEWER_EVIDENCE_DIR, "desktop-fit.png"),
      });
    }

    await phone.select("#viewport-mode", "auto");
    await target.waitForFunction(() => innerWidth === 844);
    const observer = await viewer(1200, 800);
    await observer.waitForFunction(
      () => document.querySelector("#status")!.textContent === "Another viewer has control.",
    );
    expect(await target.evaluate(() => innerWidth)).toBe(844);
    await phone.bringToFront();
    await phone.setViewport({ width: 650, height: 500, deviceScaleFactor: 3, hasTouch: true });
    await target.waitForFunction(() => innerWidth === 650);
    await expect
      .poll(() => observer.$eval("canvas", (el) => el.width), { timeout: 5000 })
      .toBe(650);
    await phone.close();
    await observer.waitForFunction(
      () => !(document.querySelector("#control") as HTMLButtonElement).disabled,
    );
    if (await observer.$eval("#control", (el) => el.textContent === "Take control"))
      await observer.click("#control");
    await target.waitForFunction(() => innerWidth === 1200);
    const readOnly = await viewer(500, 700, "/watch");
    expect(await readOnly.$eval("#control", (el) => (el as HTMLButtonElement).hidden)).toBe(true);
    expect(await target.evaluate(() => innerWidth)).toBe(1200);
    expect(errors).toEqual([]);
    await readOnly.close();
    await observer.bringToFront();
    await observer.select("#viewport-mode", "mobile");
    await observer.waitForSelector("#viewport-confirm[open]");
    await observer.click("#viewport-reload");
    await target.waitForFunction(() => sessionStorage.loads === "4");
    await observer.waitForFunction(
      () => !(document.querySelector("#viewport-mode") as HTMLSelectElement).disabled,
    );
    await observer.close();
    const reconnected = await viewer(1200, 800);
    await reconnected.waitForFunction(
      () => (document.querySelector("#viewport-mode") as HTMLSelectElement).value === "mobile",
    );
    await target.waitForFunction(() => innerWidth === 932 && navigator.maxTouchPoints === 1);
    expect(await target.evaluate(() => sessionStorage.loads)).toBe("4");
    expect(errors).toEqual([]);
    await reconnected.close();
  }, 60_000);

  async function setLayout(phone: Page, next: string) {
    await ready(phone);
    if ((await phone.$eval("#viewport-mode", (el) => (el as HTMLSelectElement).value)) === next)
      return;
    await phone.select("#viewport-mode", next);
    await phone.waitForFunction(
      () =>
        (document.querySelector("#viewport-confirm") as HTMLDialogElement).open ||
        document.querySelector("#stage")?.getAttribute("data-ready") === "true",
    );
    if (await phone.$eval("#viewport-confirm", (el) => (el as HTMLDialogElement).open))
      await phone.click("#viewport-reload");
    await ready(phone);
  }
  async function finish(phone: Page) {
    await ready(phone);
    await phone.click("#control");
    await phone.waitForFunction(
      () => document.querySelector("#control")?.textContent === "Take control",
    );
    await phone.close();
  }

  it.each(["auto", "mobile", "desktop"])(
    "delivers native touch drag, timed hold, and one tap with %s layout through the public gateway",
    async (layout) => {
      await target.goto(`${origin}/fixture`);
      const phone = await viewer(390, 900);
      await setLayout(phone, layout);
      await phone.select("#interaction-mode", "touch");
      await finger(phone, "#slider", 45);
      await expect
        .poll(() => target.evaluate('window.points.filter(p=>p[0]==="move").length'))
        .toBeGreaterThan(1);
      await expect.poll(() => target.evaluate("window.points.at(-1)?.[0]")).toBe("up");
      const points = (await target.evaluate("window.points")) as Array<[string, number]>;
      expect(points[0][0]).toBe("down");
      expect(points.at(-1)![0]).toBe("up");
      expect(points.at(-1)![1]).toBeGreaterThan(points[0][1]);
      await finger(phone, "#hold", 0, 240);
      await expect.poll(() => target.evaluate("window.holds[0]")).toBeGreaterThanOrEqual(200);
      await finger(phone, "#touch-only", 30);
      await expect.poll(() => target.evaluate("window.touchMoves.length")).toBeGreaterThan(1);
      await target.$eval("#tap", (el) => {
        el.textContent = "0";
        (el as HTMLButtonElement).onclick = () => {
          el.textContent = String(Number(el.textContent) + 1);
        };
      });
      await finger(phone, "#tap", 0);
      await expect.poll(() => target.$eval("#tap", (el) => el.textContent)).toBe("1");
      await finish(phone);
    },
  );

  it("supports the drag fallback, mouse capture outside the canvas, and native nested scrolling", async () => {
    await target.goto(`${origin}/fixture`);
    const phone = await viewer(390, 1000);
    await setLayout(phone, "auto");
    await phone.select("#interaction-mode", "drag");
    await finger(phone, "#slider", 55);
    await expect.poll(() => target.evaluate("window.points.at(-1)?.[0]")).toBe("up");
    const start = await pointOn(phone, "#slider");
    await phone.mouse.move(start.x, start.y);
    await phone.mouse.down();
    await phone.mouse.move(1, 1, { steps: 5 });
    await phone.mouse.up();
    await expect.poll(() => target.evaluate('window.points.filter(p=>p[0]==="up").length')).toBe(2);
    await phone.select("#interaction-mode", "touch");
    const nested = await pointOn(phone, "#nested");
    const cdp = await phone.createCDPSession();
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ ...nested, id: 1 }],
    });
    for (let i = 1; i <= 5; i++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: nested.x, y: nested.y - i * 12, id: 1 }],
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
    await expect.poll(() => target.$eval("#nested", (el) => el.scrollTop)).toBeGreaterThan(20);
    await finish(phone);
  });

  it("types, deletes, pastes, commits IME text once, and sends Enter through the phone keyboard bridge", async () => {
    await target.goto(`${origin}/fixture`);
    const phone = await viewer(390, 900);
    await setLayout(phone, "auto");
    await target.$eval("#draft", (el) => {
      (el as HTMLInputElement).value = "";
    });
    const field = await pointOn(phone, "#draft");
    await phone.touchscreen.tap(field.x, field.y);
    await phone.click("#keyboard");
    await phone.type("#keyboard-input", "hello");
    await expect
      .poll(() => target.$eval("#draft", (el) => (el as HTMLInputElement).value))
      .toBe("hello");
    await phone.keyboard.press("Backspace");
    await expect
      .poll(() => target.$eval("#draft", (el) => (el as HTMLInputElement).value))
      .toBe("hell");
    await phone.evaluate(() => {
      const data = new DataTransfer();
      data.setData("text/plain", " pasted");
      document
        .querySelector("#keyboard-input")!
        .dispatchEvent(
          new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
        );
    });
    await expect
      .poll(() => target.$eval("#draft", (el) => (el as HTMLInputElement).value))
      .toBe("hell pasted");
    const cdp = await phone.createCDPSession();
    await cdp.send("Input.imeSetComposition", { text: "に", selectionStart: 1, selectionEnd: 1 });
    await cdp.send("Input.insertText", { text: "日本" });
    await cdp.detach();
    await expect
      .poll(() => target.$eval("#draft", (el) => (el as HTMLInputElement).value))
      .toBe("hell pasted日本");
    await phone.keyboard.press("Enter");
    await expect.poll(() => target.evaluate("window.enterCount")).toBe(1);
    await finish(phone);
  });

  it("preserves physical keyboard events, shortcuts, and textarea Enter", async () => {
    await target.goto(`${origin}/fixture`);
    const phone = await viewer(390, 900);
    await setLayout(phone, "auto");
    await target.$eval("#draft", (el) => {
      (el as HTMLInputElement).value = "";
    });
    const point = await pointOn(phone, "#draft");
    await phone.mouse.click(point.x, point.y);
    await phone.keyboard.type("abc");
    await expect
      .poll(() => target.$eval("#draft", (el) => (el as HTMLInputElement).value))
      .toBe("abc");
    expect(await target.evaluate("window.keys")).toEqual(expect.arrayContaining(["a", "b", "c"]));
    await phone.keyboard.down("Control");
    await phone.keyboard.press("a");
    await phone.keyboard.up("Control");
    await phone.keyboard.press("Backspace");
    await expect
      .poll(() => target.$eval("#draft", (el) => (el as HTMLInputElement).value))
      .toBe("");
    await target.evaluate(() => {
      const field = document.createElement("textarea");
      field.id = "multiline";
      document.body.append(field);
      field.focus();
    });
    await phone.keyboard.type("first");
    await phone.keyboard.press("Enter");
    await phone.keyboard.type("second");
    await expect
      .poll(() => target.$eval("#multiline", (el) => (el as HTMLTextAreaElement).value))
      .toBe("first\nsecond");
    await finish(phone);
  });

  it("cancels held input on network loss and reconnects without replay", async () => {
    await target.goto(`${origin}/fixture`);
    const phone = await viewer(390, 900);
    await setLayout(phone, "auto");
    const point = await pointOn(phone, "#hold");
    const cdp = await phone.createCDPSession();
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ ...point, id: 1 }],
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    for (const socket of wss.clients) socket.terminate();
    await phone.waitForFunction(
      () => document.querySelector("#stage")?.getAttribute("data-ready") === "false",
    );
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await ready(phone);
    expect(await target.evaluate("window.holds.length")).toBe(0);
    await finger(phone, "#hold", 0, 220);
    await expect.poll(() => target.evaluate("window.holds.length")).toBe(1);
    await cdp.detach();
    await finish(phone);
  });

  it("delivers a timed touch hold inside a cross-origin iframe", async () => {
    await target.goto(`${origin}/fixture`);
    const phone = await viewer(430, 1100);
    await setLayout(phone, "auto");
    const framed = await (await target.$("#framed"))!.contentFrame();
    await framed!.waitForSelector("#frame-hold");
    const button = await framed!.$eval("#frame-hold", (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    const point = await target.$eval(
      "#framed",
      (el, button) => {
        const r = el.getBoundingClientRect();
        return {
          x: r.x + el.clientLeft + button.x,
          y: r.y + el.clientTop + button.y,
          width: innerWidth,
          height: innerHeight,
        };
      },
      button,
    );
    const local = await phone.$eval(
      "canvas",
      (el, point) => {
        const r = el.getBoundingClientRect();
        return {
          x: r.x + (point.x * r.width) / point.width,
          y: r.y + (point.y * r.height) / point.height,
        };
      },
      point,
    );
    const cdp = await phone.createCDPSession();
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ ...local, id: 1 }],
    });
    await new Promise((resolve) => setTimeout(resolve, 240));
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => framed!.evaluate("window.held")).toBeGreaterThanOrEqual(200);
    await cdp.detach();
    await finish(phone);
  });

  it("cancels held contacts on rotation, backgrounding, and pointer cancellation", async () => {
    await target.goto(`${origin}/fixture`);
    const phone = await viewer(390, 900);
    await setLayout(phone, "auto");
    const cdp = await phone.createCDPSession();
    async function start() {
      const point = await pointOn(phone, "#slider");
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ ...point, id: 1 }],
      });
      await expect.poll(() => target.evaluate("window.points.at(-1)?.[0]")).toBe("down");
    }
    await start();
    await phone.setViewport({ width: 500, height: 950, hasTouch: true, deviceScaleFactor: 3 });
    await expect.poll(() => target.evaluate("window.points.at(-1)?.[0]")).toBe("cancel");
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await ready(phone);
    await start();
    const foreground = await phone.browser().newPage();
    await foreground.bringToFront();
    await expect.poll(() => target.evaluate("window.points.at(-1)?.[0]")).toBe("cancel");
    await phone.bringToFront();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await ready(phone);
    await start();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await expect.poll(() => target.evaluate("window.points.at(-1)?.[0]")).toBe("cancel");
    await cdp.detach();
    await foreground.close();
    await finger(phone, "#slider", 25);
    await expect.poll(() => target.evaluate("window.points.at(-1)?.[0]")).toBe("up");
    await finish(phone);
  });

  it("discovers tabs, switches pages, navigates, and honors hidden controls", async () => {
    await target.goto(`${origin}/fixture`);
    const phone = await viewer(800, 1000, `${origin}/?multi=1`);
    await expect
      .poll(() => phone.$$eval("#tabs option", (els) => els.length))
      .toBeGreaterThanOrEqual(2);
    await phone.select("#tabs", pageId);
    await ready(phone);
    const extra = await browser.newPage();
    await extra.goto(`${origin}/frame`);
    const cdp = await extra.createCDPSession();
    const extraId = (await cdp.send("Target.getTargetInfo")).targetInfo.targetId;
    await cdp.detach();
    await phone.waitForSelector(`#tabs option[value="${extraId}"]`);
    await phone.select("#tabs", extraId);
    await ready(phone);
    expect(await phone.$eval("#url", (el) => (el as HTMLInputElement).value)).toBe(
      `${origin}/frame`,
    );
    await phone.click("#close-tab");
    await phone.waitForFunction(
      (id) => !document.querySelector(`#tabs option[value="${id}"]`),
      {},
      extraId,
    );
    await phone.select("#tabs", pageId);
    await ready(phone);
    await phone.click("#url", { clickCount: 3 });
    await phone.type("#url", `${origin}/frame`);
    await phone.keyboard.press("Enter");
    await target.waitForSelector("#frame-hold");
    await ready(phone);
    await finish(phone);
    const hidden = await viewer(800, 1000, `${origin}/?controls=0`);
    await ready(hidden);
    expect(await hidden.$eval("header", (el) => getComputedStyle(el).display)).toBe("none");
    await hidden.close();
  });

  it("expires a held public viewer connection and rejects an unsupported input version", async () => {
    await target.goto(`${origin}/fixture`);
    const phone = await viewer(390, 900, mintViewerEntry(Date.now() + 3500));
    await setLayout(phone, "auto");
    const cdp = await phone.createCDPSession();
    const point = await pointOn(phone, "#slider");
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ ...point, id: 1 }],
    });
    await expect.poll(() => target.evaluate("window.points.at(-1)?.[0]")).toBe("down");
    await phone.waitForFunction(
      () => document.querySelector("#status")?.textContent?.includes("expired"),
    );
    await expect.poll(() => target.evaluate("window.points.at(-1)?.[0]")).toBe("cancel");
    expect(await phone.$eval("#stage", (el) => el.getAttribute("data-ready"))).toBe("false");
    await cdp.detach();
    await phone.close();
    const url = new URL(`${viewerOrigin.replace("http:", "ws:")}/v1/sessions/cast`);
    url.searchParams.set("sessionId", sessionId);
    url.searchParams.set("pageId", pageId);
    url.searchParams.set("cap", new URL(viewerEntry).pathname.slice(3));
    const ws = new WebSocket(url, { headers: { "x-viewer-expires-at": "1" } });
    const received: Array<{ type?: string; code?: string }> = [];
    ws.on("message", (raw) => received.push(JSON.parse(String(raw))));
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    await new Promise<void>((resolve) => ws.once("open", resolve));
    ws.send(JSON.stringify({ type: "hello", version: 999 }));
    expect(await closed).toBe(4002);
    expect(received).toContainEqual(
      expect.objectContaining({ type: "inputError", code: "unsupported_input_version" }),
    );
  });

  it("keeps the embedded dashboard clipboard bridge bound to its parent", async () => {
    await target.goto(`${origin}/fixture`);
    const viewerBrowser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    viewerBrowsers.push(viewerBrowser);
    const dashboard = await viewerBrowser.newPage();
    dashboard.on("pageerror", (error) => errors.push(String(error)));
    await dashboard.goto(`${origin}/dashboard`);
    const frame = await (await dashboard.$("iframe"))!.contentFrame();
    await frame!.waitForFunction(
      () => document.querySelector("#stage")?.getAttribute("data-ready") === "true",
    );
    await target.$eval("#draft", (el) => {
      const input = el as HTMLInputElement;
      input.value = "";
      input.focus();
    });
    await dashboard.evaluate(() => {
      document
        .querySelector("iframe")!
        .contentWindow!.postMessage({ type: "triggerPaste", text: "from parent" }, location.origin);
    });
    await expect
      .poll(() => target.$eval("#draft", (el) => (el as HTMLInputElement).value))
      .toBe("from parent");
    await frame!.evaluate(() =>
      window.postMessage({ type: "triggerPaste", text: "untrusted" }, location.origin),
    );
    await target.$eval("#draft", (el) => (el as HTMLInputElement).select());
    await dashboard.evaluate(() => {
      document
        .querySelector("iframe")!
        .contentWindow!.postMessage({ type: "triggerCopy" }, location.origin);
    });
    await expect
      .poll(() =>
        dashboard.evaluate(
          'window.messages.find(message=>message.type==="requestClipboardWrite")?.text',
        ),
      )
      .toBe("from parent");
    expect(await target.$eval("#draft", (el) => (el as HTMLInputElement).value)).toBe(
      "from parent",
    );
    await dashboard.close();
  });
});
