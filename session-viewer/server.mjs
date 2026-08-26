import { createHmac, timingSafeEqual } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { pathToFileURL } from "node:url";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function jsonLog(level, message, fields = {}) {
  process.stdout.write(`${JSON.stringify({ level, message, at: new Date().toISOString(), ...fields })}\n`);
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function signPayload(encodedPayload, secret) {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

export function mintCapability({ sessionId, expiresAt }, secret) {
  if (!SESSION_ID.test(sessionId)) throw new Error("Cannot mint a capability for an invalid session ID.");
  const payload = base64url(
    JSON.stringify({ v: 1, aud: "session-viewer", sid: sessionId, exp: Math.floor(expiresAt / 1000) }),
  );
  return `${payload}.${signPayload(payload, secret)}`;
}

export function verifyCapability(token, secret, now = Date.now()) {
  if (typeof token !== "string" || token.length > 2048) return undefined;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;

  const expected = Buffer.from(signPayload(parts[0], secret));
  const actual = Buffer.from(parts[1]);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (
    payload?.v !== 1 ||
    payload?.aud !== "session-viewer" ||
    !SESSION_ID.test(payload?.sid ?? "") ||
    !Number.isSafeInteger(payload?.exp) ||
    payload.exp <= Math.floor(now / 1000)
  ) {
    return undefined;
  }
  return { sessionId: payload.sid, expiresAt: payload.exp * 1000 };
}

function cookieName(sessionId) {
  return `sv_${sessionId.replaceAll("-", "")}`;
}

function cookies(request) {
  const result = new Map();
  for (const pair of (request.headers.cookie ?? "").split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    result.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
  }
  return result;
}

function sessionExpiry(record, now, maximumTtlMs) {
  const createdAt = Date.parse(record.createdAt);
  const timeout = Number(record.timeout);
  const hardExpiry = Number.isFinite(createdAt) && Number.isFinite(timeout) && timeout > 0
    ? createdAt + timeout
    : Infinity;
  return Math.min(hardExpiry, now + maximumTtlMs);
}

export function rewriteSession(record, config, now = Date.now()) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return record;
  if (!SESSION_ID.test(record.id ?? "") || record.status === "released" || record.status === "failed") return record;

  const expiresAt = sessionExpiry(record, now, config.maximumTtlMs);
  const capability = mintCapability({ sessionId: record.id, expiresAt }, config.secret);
  const entry = new URL(`/s/${capability}`, config.publicOrigin).toString();
  const cdp = new URL("/cdp", config.publicOrigin);
  cdp.protocol = cdp.protocol === "https:" ? "wss:" : "ws:";
  cdp.searchParams.set("sessionId", record.id);
  cdp.searchParams.set("cap", capability);

  return {
    ...record,
    sessionViewerUrl: entry,
    debugUrl: entry,
    debuggerUrl: entry,
    websocketUrl: cdp.toString(),
  };
}

function responseHeaders(headers, { transformed = false, publicResponse = false } = {}) {
  const output = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === "server" || lower === "set-cookie") continue;
    if (transformed && (lower === "content-length" || lower === "content-encoding")) continue;
    output[name] = value;
  }
  if (publicResponse) {
    output["cache-control"] = "no-store";
    output["x-content-type-options"] = "nosniff";
    output["x-frame-options"] = "SAMEORIGIN";
    output["referrer-policy"] = "no-referrer";
  }
  return output;
}

function proxyRequestHeaders(headers, stripCredentials) {
  if (!stripCredentials) return { ...headers };
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => {
      const lower = name.toLowerCase();
      return (
        lower !== "authorization" &&
        lower !== "cookie" &&
        lower !== "forwarded" &&
        lower !== "proxy-authorization" &&
        lower !== "x-api-key" &&
        !lower.startsWith("x-forwarded-")
      );
    }),
  );
}

function proxyHttp(
  request,
  response,
  target,
  { transformJson, publicResponse = false, stripCredentials = false } = {},
) {
  const upstream = http.request(
    {
      hostname: target.hostname,
      port: target.port,
      method: request.method,
      path: target.pathname + target.search,
      headers: {
        ...proxyRequestHeaders(request.headers, stripCredentials),
        ...(transformJson ? { "accept-encoding": "identity" } : {}),
        host: target.host,
        connection: "close",
      },
    },
    (upstreamResponse) => {
      const contentType = String(upstreamResponse.headers["content-type"] ?? "");
      if (!transformJson || !contentType.toLowerCase().includes("application/json")) {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          responseHeaders(upstreamResponse.headers, { publicResponse }),
        );
        upstreamResponse.pipe(response);
        return;
      }

      const chunks = [];
      let bytes = 0;
      upstreamResponse.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes <= 1024 * 1024) chunks.push(chunk);
      });
      upstreamResponse.on("end", () => {
        if (bytes > 1024 * 1024) {
          response.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify({ error: "session response exceeded viewer gateway limit" }));
          return;
        }
        try {
          const body = Buffer.from(JSON.stringify(transformJson(JSON.parse(Buffer.concat(chunks).toString("utf8")))));
          response.writeHead(upstreamResponse.statusCode ?? 502, {
            ...responseHeaders(upstreamResponse.headers, { transformed: true, publicResponse }),
            "content-length": String(body.length),
          });
          response.end(body);
        } catch {
          response.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify({ error: "invalid session response from browser" }));
        }
      });
    },
  );
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain", "cache-control": "no-store" });
    response.end("Browser unavailable.");
  });
  request.pipe(upstream);
}

function isSessionResponse(request) {
  if (request.method === "POST" && request.url === "/v1/sessions") return true;
  return request.method === "GET" && /^\/v1\/sessions\/[0-9a-f-]+$/.test(request.url ?? "");
}

function safeViewerTarget(requestUrl, sessionId, upstreamOrigin) {
  const incoming = new URL(requestUrl, "http://viewer.invalid");
  const target = new URL("/v1/sessions/debug", upstreamOrigin);
  target.searchParams.set("sessionId", sessionId);
  target.searchParams.set("pageIndex", "0");
  target.searchParams.set("interactive", "true");
  target.searchParams.set("showControls", "true");
  if (incoming.searchParams.get("theme") === "dark") target.searchParams.set("theme", "dark");
  return target;
}

function sendPublicError(response, status, message) {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "SAMEORIGIN",
    "referrer-policy": "no-referrer",
  });
  response.end(message);
}

function tokenForSession(request, url, sessionId) {
  return url.searchParams.get("cap") ?? cookies(request).get(cookieName(sessionId));
}

function writeUpgradeError(socket, status, message) {
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function proxyUpgrade(request, socket, head, target, forwardedPath) {
  const upstream = net.connect(Number(target.port), target.hostname);
  upstream.once("connect", () => {
    const lines = [`${request.method} ${forwardedPath} HTTP/${request.httpVersion}`];
    for (const [name, value] of Object.entries(request.headers)) {
      const lower = name.toLowerCase();
      if (lower === "host" || lower === "cookie" || lower.startsWith("x-forwarded-")) continue;
      if (Array.isArray(value)) {
        for (const item of value) lines.push(`${name}: ${item}`);
      } else if (value !== undefined) {
        lines.push(`${name}: ${value}`);
      }
    }
    lines.push(`host: ${target.host}`, "x-forwarded-proto: https", "", "");
    upstream.write(lines.join("\r\n"));
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}

export function createGateway(config) {
  const upstreamOrigin = new URL(config.upstreamOrigin);
  const publicOrigin = new URL(config.publicOrigin);

  const internal = http.createServer((request, response) => {
    const target = new URL(request.url ?? "/", upstreamOrigin);
    const transformJson = isSessionResponse(request)
      ? (body) => rewriteSession(body, config)
      : undefined;
    proxyHttp(request, response, target, { transformJson });
  });

  const publicServer = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", publicOrigin);
    if (request.method === "GET" && url.pathname === "/healthz") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }

    const entry = /^\/s\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && entry) {
      const capability = verifyCapability(entry[1], config.secret);
      if (!capability) return sendPublicError(response, 401, "Viewer link is invalid or expired.");
      const maxAge = Math.max(1, Math.floor((capability.expiresAt - Date.now()) / 1000));
      response.setHeader(
        "set-cookie",
        `${cookieName(capability.sessionId)}=${entry[1]}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`,
      );
      return proxyHttp(request, response, safeViewerTarget(request.url, capability.sessionId, upstreamOrigin), {
        publicResponse: true,
        stripCredentials: true,
      });
    }

    if (request.method === "GET" && url.pathname === "/viewer") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      if (!SESSION_ID.test(sessionId)) return sendPublicError(response, 400, "Invalid session.");
      const capability = verifyCapability(tokenForSession(request, url, sessionId), config.secret);
      if (!capability || capability.sessionId !== sessionId) {
        return sendPublicError(response, 401, "Viewer authorization is invalid or expired.");
      }
      return proxyHttp(request, response, safeViewerTarget(request.url, sessionId, upstreamOrigin), {
        publicResponse: true,
        stripCredentials: true,
      });
    }

    return sendPublicError(response, 404, "Not found.");
  });

  publicServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", publicOrigin);
    const sessionId = url.searchParams.get("sessionId") ?? "";
    if (!SESSION_ID.test(sessionId)) return writeUpgradeError(socket, 400, "Bad Request");
    const capability = verifyCapability(tokenForSession(request, url, sessionId), config.secret);
    if (!capability || capability.sessionId !== sessionId) return writeUpgradeError(socket, 401, "Unauthorized");

    let forwardedPath;
    if (url.pathname === "/cdp") {
      forwardedPath = `/?sessionId=${encodeURIComponent(sessionId)}`;
    } else if (url.pathname === "/v1/sessions/cast") {
      const query = new URLSearchParams({ sessionId });
      for (const name of ["pageId", "pageIndex", "tabInfo"]) {
        const value = url.searchParams.get(name);
        if (value !== null) query.set(name, value);
      }
      forwardedPath = `/v1/sessions/cast?${query}`;
    } else {
      return writeUpgradeError(socket, 404, "Not Found");
    }
    proxyUpgrade(request, socket, head, upstreamOrigin, forwardedPath);
  });

  return { internal, publicServer };
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function port(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a TCP port between 1 and 65535.`);
  }
  return value;
}

export function loadConfig() {
  const secret = required("SESSION_VIEWER_SIGNING_KEY");
  if (Buffer.byteLength(secret) < 32) throw new Error("SESSION_VIEWER_SIGNING_KEY must contain at least 32 bytes.");
  const publicOrigin = new URL(required("SESSION_VIEWER_PUBLIC_ORIGIN"));
  if (publicOrigin.pathname !== "/" || publicOrigin.search || publicOrigin.hash) {
    throw new Error("SESSION_VIEWER_PUBLIC_ORIGIN must be an origin without a path, query, or fragment.");
  }
  if (publicOrigin.protocol !== "http:" && publicOrigin.protocol !== "https:") {
    throw new Error("SESSION_VIEWER_PUBLIC_ORIGIN must use http or https.");
  }
  const upstreamOrigin = new URL(process.env.SESSION_VIEWER_UPSTREAM_ORIGIN ?? "http://127.0.0.1:3000");
  if (
    upstreamOrigin.protocol !== "http:" ||
    upstreamOrigin.pathname !== "/" ||
    upstreamOrigin.search ||
    upstreamOrigin.hash ||
    upstreamOrigin.username ||
    upstreamOrigin.password
  ) {
    throw new Error("SESSION_VIEWER_UPSTREAM_ORIGIN must be an http origin without credentials or a path.");
  }
  const maximumTtlMs = Number.parseInt(process.env.SESSION_VIEWER_MAX_TTL_MS ?? "900000", 10);
  if (!Number.isSafeInteger(maximumTtlMs) || maximumTtlMs < 1_000 || maximumTtlMs > 86_400_000) {
    throw new Error("SESSION_VIEWER_MAX_TTL_MS must be between 1000 and 86400000.");
  }
  return {
    secret,
    publicOrigin: publicOrigin.toString(),
    upstreamOrigin: upstreamOrigin.toString(),
    internalHost: process.env.SESSION_VIEWER_INTERNAL_HOST ?? "127.0.0.1",
    internalPort: port("SESSION_VIEWER_INTERNAL_PORT", 3001),
    publicHost: process.env.SESSION_VIEWER_PUBLIC_HOST ?? "0.0.0.0",
    publicPort: port("SESSION_VIEWER_PUBLIC_PORT", 8080),
    maximumTtlMs,
  };
}

async function main() {
  const config = loadConfig();
  const { internal, publicServer } = createGateway(config);
  await Promise.all([
    new Promise((resolve) => internal.listen(config.internalPort, config.internalHost, resolve)),
    new Promise((resolve) => publicServer.listen(config.publicPort, config.publicHost, resolve)),
  ]);
  jsonLog("info", "session-viewer listening", {
    internal: `${config.internalHost}:${config.internalPort}`,
    public: `${config.publicHost}:${config.publicPort}`,
    upstream: config.upstreamOrigin,
    origin: config.publicOrigin,
  });

  const shutdown = async (signal) => {
    jsonLog("info", "session-viewer shutting down", { signal });
    await Promise.all([
      new Promise((resolve) => internal.close(resolve)),
      new Promise((resolve) => publicServer.close(resolve)),
    ]);
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    jsonLog("error", "session-viewer failed", { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  });
}
