import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import {
  createGateway,
  DEFAULT_SESSION_VIEWER_MAX_TTL_MS,
  mintCapability,
  rewriteSession,
  verifyCapability,
} from "./server.mjs";

const secret = "test-secret-that-is-at-least-thirty-two-bytes-long";
const sessionId = "123e4567-e89b-42d3-a456-426614174000";

test("viewer links last through a two-hour session, never beyond its deadline", () => {
  const startedAt = Date.parse("2026-10-03T12:00:00Z");
  const timeout = 7_200_000;
  const now = startedAt + 1_800_000;
  const rewritten = rewriteSession(
    {
      id: sessionId,
      status: "live",
      createdAt: new Date(startedAt).toISOString(),
      timeout,
    },
    {
      secret,
      publicOrigin: "https://viewer.test",
      maximumTtlMs: DEFAULT_SESSION_VIEWER_MAX_TTL_MS,
    },
    now,
  );
  const capability = new URL(rewritten.sessionViewerUrl).pathname.split(
    "/s/",
  )[1];
  assert.deepEqual(verifyCapability(capability, secret, now + 3_600_000), {
    sessionId,
    expiresAt: startedAt + timeout,
  });
  assert.equal(
    verifyCapability(capability, secret, startedAt + timeout),
    undefined,
  );
});

test("viewer link lifetime is capped for sessions longer than the configured maximum", () => {
  const now = 20_000;
  const rewritten = rewriteSession(
    {
      id: sessionId,
      status: "live",
      createdAt: new Date(now).toISOString(),
      timeout: 86_400_000,
    },
    {
      secret,
      publicOrigin: "https://viewer.test",
      maximumTtlMs: DEFAULT_SESSION_VIEWER_MAX_TTL_MS,
    },
    now,
  );
  const capability = new URL(rewritten.sessionViewerUrl).pathname.split(
    "/s/",
  )[1];
  assert.deepEqual(verifyCapability(capability, secret, now), {
    sessionId,
    expiresAt: now + 7_200_000,
  });
});

test("capabilities authenticate one session until their expiration", () => {
  const token = mintCapability({ sessionId, expiresAt: 20_000 }, secret);
  assert.deepEqual(verifyCapability(token, secret, 10_000), {
    sessionId,
    expiresAt: 20_000,
  });
  assert.equal(verifyCapability(token, secret, 20_000), undefined);
  assert.equal(
    verifyCapability(`${token.slice(0, -1)}x`, secret, 10_000),
    undefined,
  );
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
    {
      secret,
      publicOrigin: "https://session-viewer.test.tlon.systems",
      maximumTtlMs: 900_000,
    },
    20_000,
  );

  assert.match(
    rewritten.sessionViewerUrl,
    /^https:\/\/session-viewer\.test\.tlon\.systems\/s\//,
  );
  assert.equal(
    new URL(rewritten.sessionViewerUrl).searchParams.get("clipboardBridge"),
    "true",
  );
  assert.equal(rewritten.debugUrl, rewritten.sessionViewerUrl);
  assert.equal(rewritten.debuggerUrl, rewritten.sessionViewerUrl);
  const websocket = new URL(rewritten.websocketUrl);
  assert.equal(websocket.protocol, "wss:");
  assert.equal(websocket.pathname, "/cdp");
  assert.equal(websocket.searchParams.get("sessionId"), sessionId);
  const verified = verifyCapability(
    websocket.searchParams.get("cap"),
    secret,
    20_000,
  );
  assert.deepEqual(verified, { sessionId, expiresAt: 70_000 });
});

test("released sessions are not given viewer capabilities", () => {
  const record = { id: sessionId, status: "released", debugUrl: "internal" };
  assert.equal(
    rewriteSession(record, {
      secret,
      publicOrigin: "https://viewer.test",
      maximumTtlMs: 900_000,
    }),
    record,
  );
});

test("a zero browser timeout uses the viewer TTL instead of expiring immediately", () => {
  const now = 20_000;
  const rewritten = rewriteSession(
    {
      id: sessionId,
      status: "live",
      createdAt: new Date(now).toISOString(),
      timeout: 0,
    },
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
    if (
      request.method === "GET" &&
      request.url.startsWith("/v1/sessions/debug?")
    ) {
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
  const [internalPort, publicPort] = await Promise.all([
    listen(internal),
    listen(publicServer),
  ]);
  context.after(async () =>
    Promise.all([close(internal), close(publicServer), close(upstream)]),
  );

  const createdResponse = await fetch(
    `http://127.0.0.1:${internalPort}/v1/sessions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    },
  );
  assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json();
  assert.match(created.sessionViewerUrl, /^https:\/\/viewer\.example\/s\//);
  assert.equal(
    new URL(created.sessionViewerUrl).searchParams.get("clipboardBridge"),
    "true",
  );
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
  assert.match(
    viewer.headers.get("set-cookie"),
    /HttpOnly; Secure; SameSite=Strict$/,
  );
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

test("credential handoffs are one-use and return no field values", async (context) => {
  let filledBody;
  const upstream = http.createServer((request, response) => {
    if (
      request.method === "GET" &&
      request.url === `/v1/sessions/${sessionId}/credential-form`
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          pageId: "page-1",
          frameUrl: "https://www.are.na/login",
          origin: "https://www.are.na",
          kind: "password",
          hasUsername: true,
        }),
      );
      return;
    }
    if (
      request.method === "POST" &&
      request.url === `/v1/sessions/${sessionId}/credential-form`
    ) {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        filledBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ ok: true, filledUsername: true, submitted: true }),
        );
      });
      return;
    }
    response.writeHead(404).end();
  });
  const upstreamPort = await listen(upstream);
  const { internal, publicServer } = createGateway({
    secret,
    publicOrigin: "https://viewer.example",
    upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
    maximumTtlMs: 900_000,
  });
  const [internalPort, publicPort] = await Promise.all([
    listen(internal),
    listen(publicServer),
  ]);
  context.after(async () =>
    Promise.all([close(internal), close(publicServer), close(upstream)]),
  );

  const capability = mintCapability(
    { sessionId, expiresAt: Date.now() + 60_000 },
    secret,
  );
  const publicBase = `http://127.0.0.1:${publicPort}`;
  const discoveredResponse = await fetch(
    `${publicBase}/credentials/${capability}`,
  );
  assert.equal(discoveredResponse.status, 200);
  assert.equal(
    discoveredResponse.headers.get("access-control-allow-origin"),
    "*",
  );
  const discovered = await discoveredResponse.json();
  assert.deepEqual(Object.keys(discovered).sort(), [
    "expiresAt",
    "handoffId",
    "hasUsername",
    "kind",
    "origin",
  ]);
  assert.equal(discovered.origin, "https://www.are.na");
  assert.equal(discovered.kind, "password");
  assert.equal(discovered.hasUsername, true);

  const values = {
    username: "person@example.com",
    password: "not-in-a-chat",
    submit: true,
  };
  const fillResponse = await fetch(
    `${publicBase}/credential-fills/${discovered.handoffId}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(values),
    },
  );
  assert.equal(fillResponse.status, 200);
  assert.deepEqual(await fillResponse.json(), { ok: true, submitted: true });
  assert.deepEqual(filledBody, {
    target: {
      pageId: "page-1",
      frameUrl: "https://www.are.na/login",
      origin: "https://www.are.na",
      kind: "password",
    },
    ...values,
  });

  const replay = await fetch(
    `${publicBase}/credential-fills/${discovered.handoffId}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(values),
    },
  );
  assert.equal(replay.status, 401);
  assert.equal(
    JSON.stringify(await replay.json()).includes(values.password),
    false,
  );
  assert.ok(internalPort);
});

test("one-time-code handoffs accept only an OTP value", async (context) => {
  let filledBody;
  const upstream = http.createServer((request, response) => {
    if (
      request.method === "GET" &&
      request.url === `/v1/sessions/${sessionId}/credential-form`
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          pageId: "page-otp",
          frameUrl: "https://accounts.example/verify",
          origin: "https://accounts.example",
          kind: "otp",
          codeLength: 6,
        }),
      );
      return;
    }
    if (
      request.method === "POST" &&
      request.url === `/v1/sessions/${sessionId}/credential-form`
    ) {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        filledBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, submitted: true }));
      });
      return;
    }
    response.writeHead(404).end();
  });
  const upstreamPort = await listen(upstream);
  const { internal, publicServer } = createGateway({
    secret,
    publicOrigin: "https://viewer.example",
    upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
    maximumTtlMs: 900_000,
  });
  const [internalPort, publicPort] = await Promise.all([
    listen(internal),
    listen(publicServer),
  ]);
  context.after(async () =>
    Promise.all([close(internal), close(publicServer), close(upstream)]),
  );

  const capability = mintCapability(
    { sessionId, expiresAt: Date.now() + 60_000 },
    secret,
  );
  const publicBase = `http://127.0.0.1:${publicPort}`;
  const discoveredResponse = await fetch(
    `${publicBase}/credentials/${capability}`,
  );
  assert.equal(discoveredResponse.status, 200);
  const discovered = await discoveredResponse.json();
  assert.deepEqual(discovered, {
    handoffId: discovered.handoffId,
    origin: "https://accounts.example",
    kind: "otp",
    codeLength: 6,
    expiresAt: discovered.expiresAt,
  });

  const rejected = await fetch(
    `${publicBase}/credential-fills/${discovered.handoffId}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "must-not-be-accepted" }),
    },
  );
  assert.equal(rejected.status, 400);

  const fillResponse = await fetch(
    `${publicBase}/credential-fills/${discovered.handoffId}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "123456", submit: true }),
    },
  );
  assert.equal(fillResponse.status, 200);
  assert.deepEqual(filledBody, {
    target: {
      pageId: "page-otp",
      frameUrl: "https://accounts.example/verify",
      origin: "https://accounts.example",
      kind: "otp",
    },
    code: "123456",
    submit: true,
  });
  assert.ok(internalPort);
});
