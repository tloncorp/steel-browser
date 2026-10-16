import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import puppeteer from "puppeteer-core";
import WebSocket from "ws";
import { describe, expect, it } from "vitest";
import { chromeProxyArgs } from "./chrome-proxy.js";

const executablePath = process.env.CHROME_PATH || "/usr/bin/google-chrome";
if (!existsSync(executablePath) && process.env.CI) throw new Error("Chrome is required");
const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing listener");
      resolve(address.port);
    }),
  );
const close = (server: Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

describe.skipIf(!existsSync(executablePath))("Chrome control-plane isolation", () => {
  it("proxies loopback page requests and rejects page-origin debugger connections", async () => {
    let privateHits = 0;
    let proxyHits = 0;
    const privateApi = createServer((_req, res) => {
      privateHits++;
      res.end("private");
    });
    const proxy = createServer((_req, res) => {
      proxyHits++;
      res.writeHead(403).end("Blocked by egress");
    });
    const privatePort = await listen(privateApi);
    const proxyPort = await listen(proxy);
    const browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        ...chromeProxyArgs(`http://127.0.0.1:${proxyPort}`),
      ],
    });
    try {
      const page = await browser.newPage();
      const response = await page.goto(`http://127.0.0.1:${privatePort}/private-control`);
      expect(response?.status()).toBe(403);
      expect(privateHits).toBe(0);
      expect(proxyHits).toBeGreaterThan(0);
      const status = await new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(browser.wsEndpoint(), {
          origin: "https://untrusted.example",
          handshakeTimeout: 5000,
        });
        socket.on("unexpected-response", (_req, res) => {
          res.resume();
          resolve(res.statusCode!);
          socket.terminate();
        });
        socket.on("open", () => {
          socket.close();
          reject(new Error("Page origin reached CDP"));
        });
        socket.on("error", reject);
      });
      expect(status).toBe(403);
    } finally {
      await browser.close();
      await Promise.all([close(privateApi), close(proxy)]);
    }
  }, 60000);
});
