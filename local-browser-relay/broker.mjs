import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";

const host = process.env.HOST || "0.0.0.0";
const port = integerEnv("PORT", 8081);
const publicOrigin = parseOrigin(process.env.BROWSER_RELAY_PUBLIC_ORIGIN || "http://127.0.0.1:8081");
const tenantHeader = (process.env.BROWSER_RELAY_TENANT_HEADER || "x-api-key").toLowerCase();
const pairTtlMs = integerEnv("BROWSER_RELAY_PAIR_TTL_MS", 10 * 60_000);
const connectorTtlMs = integerEnv("BROWSER_RELAY_CONNECTOR_TTL_MS", 24 * 60 * 60_000);
const requestTimeoutMs = integerEnv("BROWSER_RELAY_REQUEST_TIMEOUT_MS", 10 * 60_000);
const maxBodyBytes = integerEnv("BROWSER_RELAY_MAX_BODY_BYTES", 64 * 1024 * 1024);
const maxConnectors = integerEnv("BROWSER_RELAY_MAX_CONNECTORS", 1_000);
const tenantIdleTtlMs = integerEnv("BROWSER_RELAY_TENANT_IDLE_TTL_MS", 60 * 60_000);
const connectorSource = fs.readFileSync(new URL("./connector.mjs", import.meta.url), "utf8");

const pairings = new Map();
const connectorTokens = new Map();
const connectorsByTenant = new Map();
const statesByTenant = new Map();
const DENIED_LOCAL_TOOLS = new Set([
  // RCE-equivalent in the local Playwright MCP process.
  "browser_run_code_unsafe",
  // These accept paths on the user's computer. A future handoff flow can add
  // a byte-scoped upload channel without granting arbitrary local file reads.
  "browser_file_upload",
  "browser_drop",
]);

const PAIR_TOOL = {
  name: "browser_pair_local",
  title: "Pair a local browser",
  description:
    "Create a short-lived pairing link for the person whose Chrome or Edge should be used. " +
    "They install the official Playwright extension and run the local companion shown on the page. " +
    "After they approve a tab, refresh this MCP server's tool catalog.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: false, openWorldHint: true },
};

const STATUS_TOOL = {
  name: "browser_local_status",
  title: "Local browser status",
  description: "Report whether this credential currently has a local Playwright browser companion connected.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", publicOrigin);

    if (request.method === "GET" && url.pathname === "/healthz") {
      return sendJson(response, 200, { ok: true, connectors: connectorsByTenant.size });
    }
    if (request.method === "GET" && url.pathname === "/connector.mjs") {
      response.writeHead(200, securityHeaders({
        "content-type": "text/javascript; charset=utf-8",
        "content-length": Buffer.byteLength(connectorSource),
      }));
      response.end(connectorSource);
      return;
    }

    const pairMatch = /^\/pair\/([A-Za-z0-9_-]{32,128})$/.exec(url.pathname);
    if (request.method === "GET" && pairMatch)
      return servePairPage(response, pairMatch[1]);

    if (url.pathname !== "/mcp")
      return sendPublicError(response, 404, "Not found.");

    const apiKey = singleHeader(request.headers[tenantHeader]);
    if (!apiKey)
      return sendJson(response, 401, { error: `missing ${tenantHeader} header` });

    const tenant = sha256(apiKey);
    const state = stateFor(tenant);
    state.lastUsed = Date.now();
    const body = await readBody(request);
    const rpc = parseRpc(body);

    if (request.method === "DELETE") {
      response.writeHead(204).end();
      return;
    }
    if (request.method !== "POST" || !rpc)
      return sendJson(response, 400, { error: "expected one JSON-RPC POST request" });

    if (rpc.method === "initialize")
      return await handleInitialize(response, state, rpc, body, request.headers);

    if (rpc.method === "notifications/initialized") {
      if (connectorFor(tenant))
        await ensureLocalInitialized(state, request.headers);
      response.writeHead(202, { "mcp-session-id": state.sessionId }).end();
      return;
    }

    if (rpc.method === "tools/list")
      return await handleToolsList(response, state, rpc, request.headers);

    if (rpc.method === "tools/call" && rpc.params?.name === PAIR_TOOL.name)
      return handlePairTool(response, state, rpc.id);

    if (rpc.method === "tools/call" && rpc.params?.name === STATUS_TOOL.name)
      return handleStatusTool(response, state, rpc.id);

    if (rpc.method === "tools/call" && DENIED_LOCAL_TOOLS.has(rpc.params?.name)) {
      return sendRpc(response, state, rpcErrorResult(
        rpc.id,
        `Tool ${rpc.params.name} is disabled by the local browser relay because it could access the user's computer outside the approved browser tabs.`,
      ));
    }

    const connector = connectorFor(tenant);
    if (!connector) {
      return sendRpc(response, state, rpcErrorResult(
        rpc.id,
        "No local browser is paired. Call browser_pair_local and have the person complete the pairing page.",
      ));
    }

    const localResponse = await forwardLocal(state, request.method, request.url, request.headers, body);
    relayMcpResponse(response, state, localResponse);
  } catch (error) {
    console.error(JSON.stringify({ level: "error", message: error.message, at: new Date().toISOString() }));
    if (!response.headersSent)
      sendJson(response, error.statusCode || 500, { error: error.statusCode ? error.message : "internal server error" });
    else
      response.destroy(error);
  }
});

const websocketServer = new WebSocketServer({
  noServer: true,
  maxPayload: Math.ceil(maxBodyBytes * 4 / 3) + 64 * 1024,
  handleProtocols(protocols) {
    return protocols.has("tlon-browser-relay.v1") ? "tlon-browser-relay.v1" : false;
  },
});

server.on("upgrade", (request, socket, head) => {
  try {
    const url = new URL(request.url || "/", publicOrigin);
    if (url.pathname !== "/connect")
      return rejectUpgrade(socket, 404, "Not Found");
    const token = connectionToken(request.headers["sec-websocket-protocol"]);
    const authorization = authorizeConnectorToken(token);
    if (!authorization)
      return rejectUpgrade(socket, 401, "Unauthorized");
    if (!connectorsByTenant.has(authorization.tenant) && connectorsByTenant.size >= maxConnectors)
      return rejectUpgrade(socket, 503, "Service Unavailable");
    // Both pairing and resume capabilities are single-use. A successful
    // connection receives a freshly rotated resume capability.
    if (authorization.kind === "pair")
      pairings.delete(authorization.tokenHash);
    else
      connectorTokens.delete(authorization.tokenHash);

    websocketServer.handleUpgrade(request, socket, head, websocket => {
      websocketServer.emit("connection", websocket, request, authorization);
    });
  } catch {
    rejectUpgrade(socket, 400, "Bad Request");
  }
});

websocketServer.on("connection", (websocket, _request, authorization) => {
  const tenant = authorization.tenant;
  if (authorization.kind === "pair")
    revokeConnectorTokens(tenant);

  const resumeToken = randomToken();
  connectorTokens.set(sha256(resumeToken), { tenant, expiresAt: Date.now() + connectorTtlMs });

  const prior = connectorsByTenant.get(tenant);
  if (prior)
    prior.websocket.close(1000, "Replaced by a newly paired companion");

  const connector = { tenant, websocket, pending: new Map() };
  connectorsByTenant.set(tenant, connector);
  resetLocalState(stateFor(tenant));
  websocket.send(JSON.stringify({ type: "paired", resumeToken, expiresAt: Date.now() + connectorTtlMs }));
  console.log(JSON.stringify({ level: "info", message: "local browser companion connected", tenant: tenant.slice(0, 12) }));

  websocket.on("message", data => handleConnectorMessage(connector, data));
  websocket.on("close", () => detachConnector(connector, "companion disconnected"));
  websocket.on("error", error => detachConnector(connector, error.message));
});

const reaper = setInterval(() => {
  const now = Date.now();
  reapMap(pairings, now);
  reapMap(connectorTokens, now);
  for (const [tenant, state] of statesByTenant) {
    if (!connectorFor(tenant) && state.lastUsed < now - tenantIdleTtlMs)
      statesByTenant.delete(tenant);
  }
}, 30_000);
reaper.unref();

server.listen(port, host, () => {
  console.log(JSON.stringify({
    level: "info",
    message: "local browser relay listening",
    address: `${host}:${port}`,
    publicOrigin,
    tenantHeader,
  }));
});

function stateFor(tenant) {
  let state = statesByTenant.get(tenant);
  if (!state) {
    state = {
      tenant,
      sessionId: crypto.randomUUID(),
      backendSessionId: undefined,
      initializeResult: undefined,
      initialized: false,
      pendingInitialization: undefined,
      pairingTokenHash: undefined,
      lastUsed: Date.now(),
    };
    statesByTenant.set(tenant, state);
  }
  return state;
}

function connectorFor(tenant) {
  const connector = connectorsByTenant.get(tenant);
  return connector?.websocket.readyState === WebSocket.OPEN ? connector : undefined;
}

async function handleInitialize(response, state, rpc, body, headers) {
  if (!connectorFor(state.tenant)) {
    const result = syntheticInitializeResult(rpc.params?.protocolVersion);
    return sendRpc(response, state, { jsonrpc: "2.0", id: rpc.id, result });
  }
  await initializeLocal(state, body, headers);
  sendRpc(response, state, { jsonrpc: "2.0", id: rpc.id, result: state.initializeResult });
}

async function handleToolsList(response, state, rpc, headers) {
  if (!connectorFor(state.tenant)) {
    return sendRpc(response, state, {
      jsonrpc: "2.0",
      id: rpc.id,
      result: { tools: [PAIR_TOOL, STATUS_TOOL] },
    });
  }
  await ensureLocalInitialized(state, headers);
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, method: "tools/list", params: rpc.params || {} }));
  const localResponse = await requestThroughConnector(state.tenant, {
    method: "POST",
    path: "/mcp",
    headers: localHeaders(headers, state.backendSessionId),
    body: body.toString("base64"),
  });
  const localRpc = parseRpc(Buffer.from(localResponse.body, "base64"));
  if (!localRpc?.result?.tools)
    throw upstreamError("Local Playwright MCP returned an invalid tool catalog.");
  localRpc.result.tools = [
    ...localRpc.result.tools.filter(tool => !DENIED_LOCAL_TOOLS.has(tool.name)),
    PAIR_TOOL,
    STATUS_TOOL,
  ];
  sendRpc(response, state, localRpc);
}

function handlePairTool(response, state, id) {
  const token = randomToken();
  if (state.pairingTokenHash)
    pairings.delete(state.pairingTokenHash);
  state.pairingTokenHash = sha256(token);
  const expiresAt = Date.now() + pairTtlMs;
  pairings.set(state.pairingTokenHash, { tenant: state.tenant, expiresAt });
  const pairUrl = new URL(`/pair/${token}`, publicOrigin).toString();
  const connected = Boolean(connectorFor(state.tenant));
  sendRpc(response, state, {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{
        type: "text",
        text:
          `${connected ? "A local companion is already connected. This link will replace it. " : ""}` +
          `Open ${pairUrl} on the computer whose Chrome or Edge should be used. ` +
          `The link expires at ${new Date(expiresAt).toISOString()}. After the person approves a tab, refresh this MCP server's tools.`,
      }],
      structuredContent: { pair_url: pairUrl, expires_at: new Date(expiresAt).toISOString(), connected },
    },
  });
}

function handleStatusTool(response, state, id) {
  const connected = Boolean(connectorFor(state.tenant));
  sendRpc(response, state, {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: connected ? "The local browser companion is connected." : "No local browser companion is connected." }],
      structuredContent: { connected },
    },
  });
}

async function initializeLocal(state, requestedBody, headers) {
  if (state.backendSessionId && state.initializeResult)
    return;
  if (state.pendingInitialization)
    return state.pendingInitialization;

  state.pendingInitialization = (async () => {
    const requested = parseRpc(requestedBody);
    const body = requested?.method === "initialize"
      ? requestedBody
      : Buffer.from(JSON.stringify({
          jsonrpc: "2.0",
          id: crypto.randomUUID(),
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "tlon-local-browser-relay", version: "0.1.0" },
          },
        }));
    const localResponse = await requestThroughConnector(state.tenant, {
      method: "POST",
      path: "/mcp",
      headers: localHeaders(headers),
      body: body.toString("base64"),
    });
    const sessionId = headerValue(localResponse.headers, "mcp-session-id");
    const message = parseRpc(Buffer.from(localResponse.body, "base64"));
    if (localResponse.status !== 200 || !sessionId || !message?.result)
      throw upstreamError("Local Playwright MCP rejected initialization.");
    state.backendSessionId = sessionId;
    state.initializeResult = message.result;
    state.initialized = false;
  })();

  try {
    await state.pendingInitialization;
  } finally {
    state.pendingInitialization = undefined;
  }
}

async function ensureLocalInitialized(state, headers) {
  await initializeLocal(state, Buffer.alloc(0), headers);
  if (state.initialized)
    return;
  const notification = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  const localResponse = await requestThroughConnector(state.tenant, {
    method: "POST",
    path: "/mcp",
    headers: localHeaders(headers, state.backendSessionId),
    body: notification.toString("base64"),
  });
  if (![200, 202].includes(localResponse.status))
    throw upstreamError("Local Playwright MCP rejected the initialized notification.");
  state.initialized = true;
}

async function forwardLocal(state, method, path, headers, body, retried = false) {
  await ensureLocalInitialized(state, headers);
  const localResponse = await requestThroughConnector(state.tenant, {
    method,
    path: new URL(path, "http://relay.invalid").pathname,
    headers: localHeaders(headers, state.backendSessionId),
    body: body.toString("base64"),
  });
  if (!retried && [404, 410].includes(localResponse.status)) {
    resetLocalState(state);
    return forwardLocal(state, method, path, headers, body, true);
  }
  return localResponse;
}

function requestThroughConnector(tenant, request) {
  const connector = connectorFor(tenant);
  if (!connector)
    throw upstreamError("The local browser companion disconnected.");
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      connector.pending.delete(id);
      reject(upstreamError("Timed out waiting for the local browser companion."));
    }, requestTimeoutMs);
    connector.pending.set(id, { resolve, reject, timeout });
    connector.websocket.send(JSON.stringify({ type: "request", id, request }));
  });
}

function handleConnectorMessage(connector, data) {
  let message;
  try {
    message = JSON.parse(data.toString());
  } catch {
    connector.websocket.close(1003, "Expected JSON messages");
    return;
  }
  if (message.type !== "response" || typeof message.id !== "string")
    return;
  const pending = connector.pending.get(message.id);
  if (!pending)
    return;
  connector.pending.delete(message.id);
  clearTimeout(pending.timeout);
  if (typeof message.response?.body === "string" && message.response.body.length > Math.ceil(maxBodyBytes * 4 / 3)) {
    pending.reject(upstreamError("Local companion response exceeded the relay size limit."));
    connector.websocket.close(1009, "Response too large");
    return;
  }
  if (message.error)
    pending.reject(upstreamError(`Local companion request failed: ${String(message.error).slice(0, 500)}`));
  else
    pending.resolve(message.response);
}

function detachConnector(connector, reason) {
  if (connectorsByTenant.get(connector.tenant) === connector)
    connectorsByTenant.delete(connector.tenant);
  for (const pending of connector.pending.values()) {
    clearTimeout(pending.timeout);
    pending.reject(upstreamError("The local browser companion disconnected."));
  }
  connector.pending.clear();
  resetLocalState(stateFor(connector.tenant));
  console.log(JSON.stringify({ level: "info", message: reason, tenant: connector.tenant.slice(0, 12) }));
}

function resetLocalState(state) {
  state.backendSessionId = undefined;
  state.initializeResult = undefined;
  state.initialized = false;
  state.pendingInitialization = undefined;
}

function relayMcpResponse(response, state, localResponse) {
  const body = Buffer.from(localResponse.body || "", "base64");
  const headers = copyResponseHeaders(localResponse.headers || {});
  headers["mcp-session-id"] = state.sessionId;
  headers["content-length"] = String(body.length);
  response.writeHead(localResponse.status || 502, headers);
  response.end(body);
}

function sendRpc(response, state, message) {
  const body = Buffer.from(JSON.stringify(message));
  response.writeHead(200, {
    "content-type": "application/json",
    "content-length": body.length,
    "mcp-session-id": state.sessionId,
    "cache-control": "no-store",
  });
  response.end(body);
}

function syntheticInitializeResult(protocolVersion) {
  return {
    protocolVersion: typeof protocolVersion === "string" ? protocolVersion : "2025-03-26",
    capabilities: { tools: { listChanged: true } },
    serverInfo: { name: "tlon-local-browser-relay", version: "0.1.0" },
    instructions:
      "This credential has no local browser yet. Call browser_pair_local, have the person finish pairing, then refresh this server's tool catalog.",
  };
}

function rpcErrorResult(id, text) {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } };
}

function servePairPage(response, token) {
  const pairing = pairings.get(sha256(token));
  if (!pairing || pairing.expiresAt <= Date.now())
    return sendPublicError(response, 410, "This pairing link is invalid or expired.");
  const pairUrl = new URL(`/pair/${token}`, publicOrigin).toString();
  const connectorUrl = new URL("/connector.mjs", publicOrigin).toString();
  const command = `node connector.mjs --pair ${shellQuote(pairUrl)}`;
  const braveSnapCommand = `${command} --executable-path /snap/bin/brave --user-data-dir "$HOME/snap/brave/current/.config/BraveSoftware/Brave-Browser"`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect your browser</title><style>
body{font:16px/1.5 system-ui,sans-serif;max-width:760px;margin:5rem auto;padding:0 1.5rem;color:#171717}code{display:block;padding:1rem;background:#f3f4f6;border-radius:.5rem;overflow:auto}a{color:#155eef}li{margin:.8rem 0}.muted{color:#666}
</style></head><body><h1>Connect your browser</h1>
<p>Your cookies and passwords stay in your browser profile, but the bot can read and control browser content through this connection. Use a dedicated Chromium profile: the official extension warns that a connection may expose signed-in sessions and other tabs or windows in that profile.</p>
<ol><li>Create or select a dedicated Chrome, Brave, or Edge profile, then install the <a href="https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm" rel="noreferrer">official Playwright extension</a> in that profile.</li>
<li>Install Node.js 22 or newer, then download the local companion:<code>curl -fsS ${escapeHtml(connectorUrl)} -o connector.mjs</code></li>
<li>Run it and approve a tab when Playwright opens the extension page:<code>${escapeHtml(command)}</code></li></ol>
<p>Brave installed as a Linux Snap:</p><code>${escapeHtml(braveSnapCommand)}</code>
<p class="muted">This one-time link expires at ${escapeHtml(new Date(pairing.expiresAt).toISOString())}. Closing the companion disconnects the bot from your browser.</p></body></html>`;
  response.writeHead(200, securityHeaders({
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  }));
  response.end(html);
}

function authorizeConnectorToken(token) {
  if (!token)
    return undefined;
  const tokenHash = sha256(token);
  const pairing = pairings.get(tokenHash);
  if (pairing && pairing.expiresAt > Date.now())
    return { kind: "pair", tokenHash, tenant: pairing.tenant };
  const resume = connectorTokens.get(tokenHash);
  if (resume && resume.expiresAt > Date.now())
    return { kind: "resume", tokenHash, tenant: resume.tenant };
  return undefined;
}

function connectionToken(header) {
  const protocols = String(header || "").split(",").map(value => value.trim());
  const encoded = protocols.find(value => value.startsWith("token."));
  return encoded?.slice("token.".length);
}

function localHeaders(incoming, sessionId) {
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  const protocol = singleHeader(incoming?.["mcp-protocol-version"]);
  if (protocol)
    headers["mcp-protocol-version"] = protocol;
  if (sessionId)
    headers["mcp-session-id"] = sessionId;
  return headers;
}

function copyResponseHeaders(headers) {
  const copied = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!["connection", "transfer-encoding", "content-length", "mcp-session-id", "server"].includes(lower))
      copied[lower] = value;
  }
  return copied;
}

function parseRpc(body) {
  if (!body?.length)
    return undefined;
  const text = body.toString("utf8");
  const data = text.split(/\r?\n/).find(line => line.startsWith("data:"));
  try {
    return JSON.parse(data ? data.slice(5).trimStart() : text);
  } catch {
    return undefined;
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > maxBodyBytes) {
        const error = new Error("request body too large");
        error.statusCode = 413;
        reject(error);
        request.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { "content-type": "application/json", "content-length": body.length, "cache-control": "no-store" });
  response.end(body);
}

function sendPublicError(response, status, message) {
  const body = Buffer.from(message);
  response.writeHead(status, securityHeaders({ "content-type": "text/plain; charset=utf-8", "content-length": body.length }));
  response.end(body);
}

function securityHeaders(extra = {}) {
  return {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    ...extra,
  };
}

function rejectUpgrade(socket, status, message) {
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function headerValue(headers, name) {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === target)
      return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

function singleHeader(value) {
  if (Array.isArray(value))
    return value[0];
  return typeof value === "string" && value.length ? value : undefined;
}

function randomToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function integerEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function parseOrigin(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash)
    throw new Error("BROWSER_RELAY_PUBLIC_ORIGIN must be an http(s) origin without a path, query, or fragment");
  return url.toString();
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function upstreamError(message) {
  const error = new Error(message);
  error.statusCode = 502;
  return error;
}

function reapMap(map, now) {
  for (const [key, value] of map) {
    if (value.expiresAt <= now)
      map.delete(key);
  }
}

function revokeConnectorTokens(tenant) {
  for (const [tokenHash, record] of connectorTokens) {
    if (record.tenant === tenant)
      connectorTokens.delete(tokenHash);
  }
}
