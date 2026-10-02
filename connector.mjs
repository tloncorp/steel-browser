#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
if (!args.pair)
  fail("Usage: node connector.mjs --pair https://browser-connect.example/pair/TOKEN [--executable-path PATH] [--user-data-dir PATH]");
if (typeof WebSocket === "undefined")
  fail("Node.js 22 or newer is required.");

const pairUrl = new URL(args.pair);
const pairMatch = /^\/pair\/([A-Za-z0-9_-]{32,128})$/.exec(pairUrl.pathname);
if (!pairMatch)
  fail("--pair must be the complete pairing URL shown by the bot.");
if (!['https:', 'http:'].includes(pairUrl.protocol))
  fail("The pairing URL must use HTTPS or HTTP.");

let connectionToken = pairMatch[1];
const websocketUrl = new URL("/connect", pairUrl);
websocketUrl.protocol = pairUrl.protocol === "https:" ? "wss:" : "ws:";

const localPort = await reservePort();
const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "tlon-browser-connector-"));
const outputDirectory = path.join(workDirectory, "output");
fs.mkdirSync(outputDirectory, { mode: 0o700 });
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
let stopping = false;
const mcpArgs = [
  "-y",
  "@playwright/mcp@0.0.79",
  "--extension",
  "--host=127.0.0.1",
  `--port=${localPort}`,
  `--output-dir=${outputDirectory}`,
];
if (args.userDataDir)
  mcpArgs.push(`--user-data-dir=${args.userDataDir}`);
if (args.executablePath)
  mcpArgs.push(`--executable-path=${args.executablePath}`);

console.log(`Starting the local Playwright MCP server on 127.0.0.1:${localPort}…`);
const child = spawn(npx, mcpArgs, {
  cwd: workDirectory,
  env: { ...process.env, PLAYWRIGHT_MCP_PING_TIMEOUT_MS: "0" },
  shell: false,
  stdio: "inherit",
  windowsHide: true,
});
child.on("exit", code => {
  cleanupWorkDirectory();
  if (!stopping) {
    console.error(`Local Playwright MCP exited with code ${code}.`);
    process.exit(code || 1);
  }
});

await waitForPort(localPort, 120_000);
console.log("Local Playwright MCP is ready. Connecting to the cluster relay…");

let socket;
let reconnectDelay = 1_000;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (stopping)
      return;
    stopping = true;
    socket?.close(1000, "Local companion stopped");
    child.kill("SIGTERM");
  });
}

while (!stopping) {
  try {
    await connectOnce();
    reconnectDelay = 1_000;
  } catch (error) {
    if (stopping)
      break;
    console.error(`Relay connection failed: ${error.message}`);
  }
  if (!stopping) {
    await delay(reconnectDelay);
    reconnectDelay = Math.min(30_000, reconnectDelay * 2);
  }
}

async function connectOnce() {
  socket = new WebSocket(websocketUrl, ["tlon-browser-relay.v1", `token.${connectionToken}`]);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("connection timed out")), 15_000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("WebSocket handshake failed"));
    }, { once: true });
  });
  console.log("Connected. The bot can now request control; approve the tab-selection page Chrome opens.");

  await new Promise(resolve => {
    socket.addEventListener("message", event => void handleMessage(event.data));
    socket.addEventListener("close", event => {
      if (!stopping)
        console.log(`Relay disconnected (${event.code}${event.reason ? `: ${event.reason}` : ""}); reconnecting…`);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {}, { once: true });
  });
}

async function handleMessage(raw) {
  let message;
  try {
    message = JSON.parse(typeof raw === "string" ? raw : Buffer.from(await raw.arrayBuffer()).toString("utf8"));
  } catch {
    return;
  }
  if (message.type === "paired" && typeof message.resumeToken === "string") {
    connectionToken = message.resumeToken;
    return;
  }
  if (message.type !== "request" || typeof message.id !== "string")
    return;

  try {
    const request = message.request || {};
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers || {})) {
      if (!["host", "connection", "content-length", "transfer-encoding"].includes(name.toLowerCase()) && value !== undefined)
        headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
    }
    const body = request.body ? Buffer.from(request.body, "base64") : undefined;
    // Current Playwright MCP intentionally validates Host and permits the
    // localhost name it advertises, not the equivalent 127.0.0.1 literal.
    const response = await fetch(`http://localhost:${localPort}${request.path || "/mcp"}`, {
      method: request.method || "POST",
      headers,
      body: body?.length ? body : undefined,
    });
    const responseBody = Buffer.from(await response.arrayBuffer());
    send({
      type: "response",
      id: message.id,
      response: {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseBody.toString("base64"),
      },
    });
  } catch (error) {
    send({ type: "response", id: message.id, error: error.message });
  }
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify(message));
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await new Promise(resolve => {
      const candidate = net.createConnection({ host: "127.0.0.1", port });
      candidate.setTimeout(500);
      candidate.once("connect", () => { candidate.destroy(); resolve(true); });
      candidate.once("timeout", () => { candidate.destroy(); resolve(false); });
      candidate.once("error", () => resolve(false));
    });
    if (ready)
      return;
    if (child.exitCode !== null)
      fail(`Local Playwright MCP exited with code ${child.exitCode}.`);
    await delay(250);
  }
  fail("Timed out waiting for the local Playwright MCP server.");
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value === "--pair")
      result.pair = values[++index];
    else if (value.startsWith("--pair="))
      result.pair = value.slice("--pair=".length);
    else if (value === "--user-data-dir")
      result.userDataDir = values[++index];
    else if (value.startsWith("--user-data-dir="))
      result.userDataDir = value.slice("--user-data-dir=".length);
    else if (value === "--executable-path")
      result.executablePath = values[++index];
    else if (value.startsWith("--executable-path="))
      result.executablePath = value.slice("--executable-path=".length);
    else
      fail(`Unknown argument: ${value}`);
  }
  return result;
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function cleanupWorkDirectory() {
  try {
    fs.rmSync(workDirectory, { recursive: true, force: true });
  } catch (error) {
    console.error(`Could not remove temporary output directory ${workDirectory}: ${error.message}`);
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
