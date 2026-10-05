import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ejs from "ejs";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { WebSocketServer } from "ws";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionService } from "../../services/session.service.js";
import { handleCastSession } from "./casting.handler.js";

const executablePath = process.env.CHROME_EXECUTABLE_PATH || "/usr/bin/google-chrome";
const hasChrome = existsSync(executablePath);
if (!hasChrome)
  console.warn("Skipping live casting tests: set CHROME_EXECUTABLE_PATH to a local Chrome.");

describe.skipIf(!hasChrome)("adaptive streamed viewer in Chrome", () => {
  let browser: Browser;
  let viewerBrowser: Browser;
  let server: Server;
  let wss: WebSocketServer;
  let target: Page;
  let origin: string;
  let pageId: string;
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const errors: string[] = [];
  const session = { id: sessionId, status: "live", dimensions: { width: 1920, height: 1080 } };
  const sessionRuntime = {};

  beforeAll(async () => {
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    viewerBrowser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const connect = puppeteer.connect.bind(puppeteer);
    vi.spyOn(puppeteer, "connect").mockImplementation(async (options) => {
      expect(new URL(options!.browserWSEndpoint!).searchParams.get("sessionId")).toBe(sessionId);
      expect(options!.defaultViewport).toBeNull();
      return connect({ ...options, browserWSEndpoint: browser.wsEndpoint() });
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
          <input id="draft" value="Unsent login text"><script>
          sessionStorage.loads=String(Number(sessionStorage.loads||0)+1);
          </script>`);
      } else {
        response.end(
          await ejs.renderFile(
            fileURLToPath(new URL("../../templates/live-session-streamer.ejs", import.meta.url)),
            {
              theme: "light",
              singlePageMode: true,
              showControls: true,
              interactive: request.url !== "/watch",
              dimensions: session.dimensions,
              wsUrl: `${origin.replace(
                "http:",
                "ws:",
              )}/cast?sessionId=${sessionId}&pageId=${pageId}`,
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
        { sessionId, pageId },
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    target = await browser.newPage();
    target.setDefaultTimeout(5000);
    await target.setViewport({ width: 1920, height: 1080 });
    await target.goto(`${origin}/fixture`);
    const cdp = await target.createCDPSession();
    pageId = (await cdp.send("Target.getTargetInfo")).targetInfo.targetId;
    await cdp.detach();
  });

  afterAll(async () => {
    await viewerBrowser?.close();
    await browser?.close();
    for (const socket of wss?.clients ?? []) socket.terminate();
    wss?.close();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    vi.restoreAllMocks();
  });

  async function viewer(width: number, height: number, route = "/") {
    const page = await viewerBrowser.newPage();
    page.setDefaultTimeout(5000);
    await page.setViewport({ width, height, deviceScaleFactor: 3, hasTouch: true });
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(`${origin}${route}`);
    await page.waitForFunction(
      () =>
        document.querySelector("canvas")!.width > 0 &&
        document.querySelector("canvas")!.style.width !== "",
    );
    return page;
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

    const point = await target.$eval("#tap", (el) => {
      const rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    const canvas = await phone.$eval("canvas", (el) => {
      const rect = el.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    await phone.touchscreen.tap(canvas.x + point.x, canvas.y + point.y);
    await target.waitForFunction(() => document.querySelector("#tap")!.textContent === "Tapped");
    const input = await phone.createCDPSession();
    await input.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: 200, y: 650 }],
    });
    await input.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: 200, y: 350 }],
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
      () =>
        document.querySelector("#viewport-status")!.textContent === "Another viewer has control",
    );
    expect(await target.evaluate(() => innerWidth)).toBe(844);
    await phone.bringToFront();
    await phone.setViewport({ width: 650, height: 500, deviceScaleFactor: 3, hasTouch: true });
    await target.waitForFunction(() => innerWidth === 650);
    await expect
      .poll(() => observer.$eval("canvas", (el) => el.width), { timeout: 5000 })
      .toBe(650);
    await phone.close();
    await target.waitForFunction(() => innerWidth === 1200);
    const readOnly = await viewer(500, 700, "/watch");
    expect(await readOnly.$("#viewport-mode")).toBeNull();
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
});
