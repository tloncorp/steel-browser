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

function secureField(purpose, id = "f0", extra = {}) {
  return {
    id,
    purpose,
    label: purpose,
    inputType: "text",
    required: true,
    ...extra,
  };
}
async function secureGateway(
  context,
  fields,
  kind = "login",
  fillStatus = 200,
) {
  const posted = [];
  const metadata = {
    formId: "bound-form",
    pageId: "page-1",
    frameUrl: "https://account.example/form",
    origin: "https://account.example",
    kind,
    fields,
  };
  const upstream = http.createServer((request, response) => {
    if (request.url !== `/v1/sessions/${sessionId}/credential-form`)
      return response.writeHead(404).end();
    if (request.method === "GET") {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(metadata));
      return;
    }
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      posted.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response
        .writeHead(fillStatus, { "content-type": "application/json" })
        .end(
          JSON.stringify(
            fillStatus === 200
              ? { ok: true, submitted: kind === "login" }
              : { error: "must-not-echo-submitted-value" },
          ),
        );
    });
  });
  const upstreamPort = await listen(upstream);
  const { internal, publicServer } = createGateway({
    secret,
    publicOrigin: "https://viewer.example",
    upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
    maximumTtlMs: 900_000,
  });
  const publicPort = await listen(publicServer);
  context.after(() => Promise.all([close(publicServer), close(upstream)]));
  const capability = mintCapability(
    { sessionId, expiresAt: Date.now() + 60_000 },
    secret,
  );
  const base = `http://127.0.0.1:${publicPort}`;
  const discover = () => fetch(`${base}/credentials/${capability}`);
  const fill = (id, body) =>
    fetch(`${base}/credential-fills/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { metadata, posted, discover, fill, internal, base, publicServer };
}

test("secure handoffs expose metadata and a one-use endpoint, never values or selectors", async (context) => {
  const fields = [
    secureField("username"),
    secureField("current-password", "f1", {
      inputType: "password",
      value: "private-value",
      selector: "#secret",
    }),
  ];
  const gateway = await secureGateway(context, fields);
  const response = await gateway.discover();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  const handoff = await response.json();
  assert.deepEqual(Object.keys(handoff).sort(), [
    "expiresAt",
    "fields",
    "formId",
    "handoffId",
    "kind",
    "origin",
  ]);
  assert.equal(handoff.formId, "bound-form");
  assert.equal(handoff.fields[1].value, undefined);
  assert.equal(handoff.fields[1].selector, undefined);
  const input = {
    values: { f0: "person@example.com", f1: "not-in-chat" },
    submit: true,
  };
  const filled = await gateway.fill(handoff.handoffId, input);
  assert.equal(filled.status, 200);
  assert.deepEqual(await filled.json(), { ok: true, submitted: true });
  const { fields: _fields, ...target } = gateway.metadata;
  assert.deepEqual(gateway.posted, [{ target, ...input }]);
  assert.equal((await gateway.fill(handoff.handoffId, input)).status, 401);
});

test("field contracts reject wrong keys and enforce verification-code length", async (context) => {
  const gateway = await secureGateway(context, [
    secureField("one-time-code", "f0", { exactLength: 6 }),
  ]);
  const handoff = await (await gateway.discover()).json();
  for (const body of [
    { password: "secret" },
    { values: { f0: "123" } },
    { values: { f0: "123456", f1: "extra" } },
    { values: { f0: 42 } },
  ]) {
    assert.equal((await gateway.fill(handoff.handoffId, body)).status, 400);
  }
  assert.equal(gateway.posted.length, 0);
  assert.equal(
    (
      await gateway.fill(handoff.handoffId, {
        values: { f0: "aBc123" },
        submit: true,
      })
    ).status,
    200,
  );
  assert.deepEqual(gateway.posted[0].values, { f0: "aBc123" });
});

test("details handoffs fill card/address values without forwarding submit authorization", async (context) => {
  const gateway = await secureGateway(
    context,
    [
      secureField("cc-number"),
      secureField("street-address", "f1"),
      secureField("country", "f2", {
        inputType: "select",
        options: [{ value: "1", label: "Canada" }],
      }),
    ],
    "details",
  );
  const handoff = await (await gateway.discover()).json();
  const body = {
    values: { f0: "4111111111111111", f1: "1 Test St", f2: "1" },
    submit: true,
  };
  assert.equal((await gateway.fill(handoff.handoffId, body)).status, 200);
  assert.equal(gateway.posted[0].submit, false);
});

test("a new discovery invalidates an earlier public fill handle", async (context) => {
  const gateway = await secureGateway(context, [secureField("username")]);
  const first = await (await gateway.discover()).json();
  const second = await (await gateway.discover()).json();
  assert.equal(first.formId, second.formId);
  assert.notEqual(first.handoffId, second.handoffId);
  assert.equal(
    (await gateway.fill(first.handoffId, { values: { f0: "user" } })).status,
    401,
  );
  assert.equal(gateway.posted.length, 0);
});

test("general form labels and choices pass through without values or submission authorization", async (context) => {
  const gateway = await secureGateway(
    context,
    [
      secureField("field", "f0", { label: "Message", inputType: "textarea" }),
      secureField("field", "f1", {
        label: "Updates",
        inputType: "select",
        options: [
          { value: "0", label: "No" },
          { value: "1", label: "Yes" },
        ],
        value: "private-existing-value",
      }),
    ],
    "details",
  );
  const handoff = await (await gateway.discover()).json();
  assert.equal(handoff.fields[0].label, "Message");
  assert.deepEqual(handoff.fields[1].options, [
    { value: "0", label: "No" },
    { value: "1", label: "Yes" },
  ]);
  assert.ok(!JSON.stringify(handoff).includes("private-existing-value"));
  assert.equal(
    (
      await gateway.fill(handoff.handoffId, {
        values: { f0: "A request", f1: "0" },
        submit: true,
      })
    ).status,
    200,
  );
  assert.deepEqual(gateway.posted[0].values, { f0: "A request", f1: "0" });
  assert.equal(gateway.posted[0].submit, false);
});

test("an uncertain upstream failure consumes the handle and never echoes its body", async (context) => {
  const gateway = await secureGateway(
    context,
    [secureField("current-password")],
    "login",
    500,
  );
  const handoff = await (await gateway.discover()).json();
  const failed = await gateway.fill(handoff.handoffId, {
    values: { f0: "secret" },
    submit: true,
  });
  assert.equal(failed.status, 500);
  assert.ok(!(await failed.text()).includes("must-not-echo"));
  assert.equal(
    (
      await gateway.fill(handoff.handoffId, {
        values: { f0: "secret" },
        submit: true,
      })
    ).status,
    401,
  );
  assert.equal(gateway.posted.length, 1);
});

test("concurrent fills consume a public handle once", async (context) => {
  const gateway = await secureGateway(context, [
    secureField("current-password"),
  ]);
  const handoff = await (await gateway.discover()).json();
  const responses = await Promise.all([
    gateway.fill(handoff.handoffId, { values: { f0: "secret" } }),
    gateway.fill(handoff.handoffId, { values: { f0: "secret" } }),
  ]);
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [200, 401],
  );
  assert.equal(gateway.posted.length, 1);
});

for (const fields of [
  [],
  [secureField("username"), secureField("username")],
  [secureField("country", "f0", { inputType: "select", options: [] })],
  [secureField("one-time-code", "f0", { exactLength: 0 })],
]) {
  test("rejects malformed field metadata", async (context) => {
    const gateway = await secureGateway(context, fields);
    assert.equal((await gateway.discover()).status, 502);
  });
}

test("a fill admitted before its deadline cannot dispatch after a delayed body expires", async (context) => {
  const gateway = await secureGateway(context, [secureField("username")]);
  const handoff = await (await gateway.discover()).json();
  let admitted;
  const firstChunk = new Promise((resolve) => {
    admitted = resolve;
  });
  gateway.publicServer.once("request", (request) =>
    request.once("data", admitted),
  );
  const input = JSON.stringify({ values: { f0: "example" } });
  let request;
  const result = new Promise((resolve, reject) => {
    request = http.request(
      `${gateway.base}/credential-fills/${handoff.handoffId}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(input),
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      },
    );
    request.on("error", reject);
    request.write(input.slice(0, 10));
  });
  await firstChunk;
  context.mock.method(Date, "now", () => handoff.expiresAt + 1);
  request.end(input.slice(10));
  assert.equal(await result, 401);
  assert.deepEqual(gateway.posted, []);
});
