import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import { createGateway, mintCapability, rewriteSession, verifyCapability } from "./server.mjs";

const secret = "test-secret-that-is-at-least-thirty-two-bytes-long";
const sessionId = "123e4567-e89b-42d3-a456-426614174000";

test("capabilities authenticate one session until their expiration", () => {
  const token = mintCapability({ sessionId, expiresAt: 20_000 }, secret);
  assert.deepEqual(verifyCapability(token, secret, 10_000), { sessionId, expiresAt: 20_000 });
  assert.equal(verifyCapability(token, secret, 20_000), undefined);
  assert.equal(verifyCapability(`${token.slice(0, -1)}x`, secret, 10_000), undefined);
});

test("live session responses receive neutral capability and scoped CDP URLs", () => {
  const rewritten = rewriteSession(
    {
      id: sessionId,
      status: "live",
      createdAt: "1970-01-01T00:00:10.000Z",
      timeout: 60_000,
      sessionViewerUrl: "http://browser.invalid/",
      debugUrl: "http://browser.invalid/v1/sessions/debug",
      debuggerUrl: "http://browser.invalid/v1/devtools/inspector.html",
      websocketUrl: "ws://browser.invalid/",
    },
    { secret, publicOrigin: "https://session-viewer.test.tlon.systems", maximumTtlMs: 900_000 },
    20_000,
  );

  assert.match(rewritten.sessionViewerUrl, /^https:\/\/session-viewer\.test\.tlon\.systems\/s\//);
  assert.equal(new URL(rewritten.sessionViewerUrl).searchParams.get("clipboardBridge"), "true");
  assert.equal(rewritten.debugUrl, rewritten.sessionViewerUrl);
  assert.equal(rewritten.debuggerUrl, rewritten.sessionViewerUrl);
  const websocket = new URL(rewritten.websocketUrl);
  assert.equal(websocket.protocol, "wss:");
  assert.equal(websocket.pathname, "/cdp");
  assert.equal(websocket.searchParams.get("sessionId"), sessionId);
  const verified = verifyCapability(websocket.searchParams.get("cap"), secret, 20_000);
  assert.deepEqual(verified, { sessionId, expiresAt: 70_000 });
});

test("released sessions are not given viewer capabilities", () => {
  const record = { id: sessionId, status: "released", debugUrl: "internal" };
  assert.equal(
    rewriteSession(record, { secret, publicOrigin: "https://viewer.test", maximumTtlMs: 900_000 }),
    record,
  );
});

test("a zero browser timeout uses the viewer TTL instead of expiring immediately", () => {
  const now = 20_000;
  const rewritten = rewriteSession(
    { id: sessionId, status: "live", createdAt: new Date(now).toISOString(), timeout: 0 },
    { secret, publicOrigin: "https://viewer.test", maximumTtlMs: 900_000 },
    now,
  );
  const entry = new URL(rewritten.sessionViewerUrl);
  const capability = entry.pathname.split("/s/")[1];
  assert.deepEqual(verifyCapability(capability, secret, now), {
    sessionId,
    expiresAt: now + 900_000,
  });
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("the public listener exposes only a capability-scoped viewer", async (context) => {
  let debugRequest;
  const upstream = http.createServer((request, response) => {
    if (request.method === "POST" && request.url === "/v1/sessions") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: sessionId,
          status: "live",
          createdAt: new Date().toISOString(),
          timeout: 60_000,
          sessionViewerUrl: "http://127.0.0.1:3000/",
          debugUrl: `http://127.0.0.1:3000/v1/sessions/debug?sessionId=${sessionId}`,
          debuggerUrl: "http://127.0.0.1:3000/v1/devtools/inspector.html",
          websocketUrl: `ws://127.0.0.1:3000/?sessionId=${sessionId}`,
        }),
      );
      return;
    }
    if (request.method === "GET" && request.url.startsWith("/v1/sessions/debug?")) {
      debugRequest = request;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Scoped viewer</title>");
      return;
    }
    response.writeHead(404).end();
  });
  const upstreamPort = await listen(upstream);
  const config = {
    secret,
    publicOrigin: "https://viewer.example",
    upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
    maximumTtlMs: 900_000,
  };
  const { internal, publicServer } = createGateway(config);
  const [internalPort, publicPort] = await Promise.all([listen(internal), listen(publicServer)]);
  context.after(async () => Promise.all([close(internal), close(publicServer), close(upstream)]));

  const createdResponse = await fetch(`http://127.0.0.1:${internalPort}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json();
  assert.match(created.sessionViewerUrl, /^https:\/\/viewer\.example\/s\//);
  assert.equal(new URL(created.sessionViewerUrl).searchParams.get("clipboardBridge"), "true");
  assert.match(created.websocketUrl, /^wss:\/\/viewer\.example\/cdp\?/);

  const publicBase = `http://127.0.0.1:${publicPort}`;
  const denied = await fetch(`${publicBase}/v1/sessions`);
  assert.equal(denied.status, 404);

  const entryPath = new URL(created.sessionViewerUrl).pathname;
  const viewer = await fetch(`${publicBase}${entryPath}?theme=dark`, {
    headers: {
      authorization: "Bearer must-not-reach-browser",
      "x-api-key": "must-not-reach-browser",
    },
  });
  assert.equal(viewer.status, 200);
  assert.equal(viewer.url, `${publicBase}${entryPath}?theme=dark`);
  assert.equal(viewer.headers.get("location"), null);
  assert.match(await viewer.text(), /Scoped viewer/);
  assert.equal(viewer.headers.get("cache-control"), "no-store");
  assert.equal(viewer.headers.get("referrer-policy"), "no-referrer");
  assert.match(viewer.headers.get("set-cookie"), /^sv_[0-9a-f]+=.+; Path=\/;/);
  assert.match(viewer.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Strict$/);
  assert.equal(debugRequest.headers.cookie, undefined);
  assert.equal(debugRequest.headers.authorization, undefined);
  assert.equal(debugRequest.headers["x-api-key"], undefined);
  const debugUrl = new URL(debugRequest.url, "http://upstream.invalid");
  assert.equal(debugUrl.searchParams.get("sessionId"), sessionId);
  assert.equal(debugUrl.searchParams.get("pageIndex"), "0");
  assert.equal(debugUrl.searchParams.get("interactive"), "true");
  assert.equal(debugUrl.searchParams.get("showControls"), "true");
  assert.equal(debugUrl.searchParams.get("theme"), "dark");
  assert.equal(debugUrl.searchParams.get("clipboardBridge"), null);
});
