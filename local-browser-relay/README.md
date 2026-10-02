# Local browser relay

This is an optional browser execution plane beside hosted Steel. It lets a moon's bot use a Chrome
or Edge profile on the user's own computer without copying that profile's cookies, passwords, or
extension authentication token into Kubernetes.

The stock Playwright extension accepts relay WebSockets only on `127.0.0.1` or `::1`. The local
companion therefore runs the official Playwright MCP server beside Chrome and makes an outbound
WebSocket connection to the cluster:

```text
moon X-Api-Key -> browser-relay /mcp -> outbound tunnel -> local Playwright MCP -> extension -> Chrome
```

Steel remains the hosted fallback. Configure this relay as a second Urbit MCP upstream rather than
replacing `steel-mcp`.

## Security and isolation

- The broker hashes `X-Api-Key` and uses the hash only as a tenant identifier. It never forwards the
  key to the user's computer.
- A 256-bit, ten-minute, one-time pairing capability binds one local companion to one tenant.
- The connector receives a process-local resume capability after pairing. Closing it disconnects
  the browser. A broker restart intentionally requires pairing again in this first version.
- Only one companion may own a tenant. Pairing a replacement disconnects the prior companion.
- Different keys cannot discover or call each other's local Playwright MCP sessions. The broker also
  replaces unstable upstream MCP session IDs with one credential-owned downstream session.
- The public Ingress exposes `/pair`, `/connect`, and `/connector.mjs`; it does not expose `/mcp`.
- The official extension warns that a connection may expose signed-in sessions and other tabs or
  windows in its Chrome profile. Users should create a dedicated Chrome profile for their bot.
- Website credentials stay in Chrome, but page content and actions necessarily travel through the
  bot and cluster while it controls the page.
- The broker removes and rejects `browser_run_code_unsafe`, `browser_file_upload`, and
  `browser_drop`. This prevents local-process code execution and arbitrary reads from the user's
  filesystem. Playwright output is confined to a dedicated temporary directory.

The broker is process-local and deployed as one replica. Horizontal scaling requires a shared
tenant-to-connector directory plus sticky routing or a broker designed to route tunnel frames to the
owning replica.

## Build and deploy

Test:

```sh
docker build -f Dockerfile.browser-relay \
  -t us-central1-docker.pkg.dev/test-61eb624c/images/browser-relay:latest .
docker push us-central1-docker.pkg.dev/test-61eb624c/images/browser-relay:latest
kubectl apply -f deploy/kubernetes/browser-relay.test.yaml
kubectl -n tlon rollout status deployment/browser-relay
```

Production uses `prod-f0181862` and `deploy/kubernetes/browser-relay.prod.yaml`.

Configure the moon's MCP desk with this second upstream:

```text
http://browser-relay.tlon.svc.cluster.local:8081/mcp
```

Set its `X-Api-Key` header to the same distinct credential the moon uses to authenticate to its MCP
desk. Do not reuse one credential between users.

## User flow

1. Before a companion is connected, this MCP endpoint advertises `browser_pair_local` and
   `browser_local_status`.
2. The bot calls `browser_pair_local` and sends the returned HTTPS link to the user.
3. The user opens it on the computer with Chrome, Brave, or Edge, creates a dedicated browser profile, installs the
   official Playwright extension, downloads `connector.mjs`, and runs the command shown.
4. On the first browser action, Playwright opens the extension's consent/tab-selection page. The
   user approves the connection.
5. Refresh the upstream catalog. The relay now advertises Playwright's `browser_*` tools alongside
   the pairing and status tools.
6. Stop the local companion to revoke access immediately.

The companion requires Node.js 22 or newer. It pins `@playwright/mcp@0.0.79`, disables the HTTP
heartbeat that the Urbit proxy does not answer, and does not set
`PLAYWRIGHT_MCP_EXTENSION_TOKEN`; connection approval stays manual by default.

For a non-default Chrome profile location, append:

```sh
node connector.mjs --pair 'PAIR_URL' --user-data-dir '/path/to/chrome/profile/root'
```

To target a non-default Chromium executable, including Brave installed as a Linux Snap:

```sh
node connector.mjs --pair 'PAIR_URL' \
  --executable-path /snap/bin/brave \
  --user-data-dir "$HOME/snap/brave/current/.config/BraveSoftware/Brave-Browser"
```

## Local broker development

```sh
cd local-browser-relay
npm ci
BROWSER_RELAY_PUBLIC_ORIGIN=http://127.0.0.1:8081 npm start
```

The MCP endpoint is then `http://127.0.0.1:8081/mcp`. The pair page serves the exact companion source
embedded in the broker image, so the downloaded connector and broker protocol stay in lockstep.
