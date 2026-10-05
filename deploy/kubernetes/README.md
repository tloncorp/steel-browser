# Kubernetes deployment

This deployment runs Steel Browser and the tenant-aware Steel MCP HTTP server in one Pod. The MCP
sidecar talks to the browser over loopback, and the `steel-mcp` ClusterIP Service exposes only the
MCP port to other workloads in the `tlon` namespace.

The browser image is:

```text
us-central1-docker.pkg.dev/test-61eb624c/images/steel-browser:latest
```

Build the separate MCP sidecar image from the directory containing the sibling
`steel-browser` and `steel-mcp-server` checkouts:

```sh
docker build \
  -f steel-browser/Dockerfile.steel-mcp \
  -t us-central1-docker.pkg.dev/test-61eb624c/images/steel-mcp:latest \
  steel-mcp-server
docker push us-central1-docker.pkg.dev/test-61eb624c/images/steel-mcp:latest
```

The `Build browser images` GitHub Actions workflow builds and publishes `steel-browser`,
`steel-mcp`, and `session-viewer` together. Run it manually, choose `test` or `prod`, and provide
the published Steel MCP branch, tag, or SHA. Each GitHub Environment must expose its GAR service
account JSON as the `GKE_SA_KEY` secret. The workflow pushes both a shared immutable tag and
`latest` to that environment's `images` repository. It checks out the requested `mcp_ref` from
`tloncorp/steel-mcp-server` using the `TLONBOT_READ` secret.

Deploy and wait for readiness:

```sh
kubectl apply -f steel-browser/deploy/kubernetes/steel.yaml
kubectl -n tlon rollout status deployment/steel
```

The test viewer is published at `browser-session-ovh-test-1.test.tlon.systems`. Production uses
one single-label wildcard hostname per cluster: `browser-session-ovh1.tlon.network`,
`browser-session-ovh2.tlon.network`, `browser-session-ovh3.tlon.network`, or
`browser-session-east5.tlon.network`.

Render the production manifest for the target cluster instead of applying `steel.prod.yaml`
directly:

```sh
steel-browser/deploy/kubernetes/render-steel-prod.sh ovh1 | kubectl apply -f -
```

Configure each Urbit MCP desk with:

```text
http://steel-mcp.tlon.svc.cluster.local:8000/mcp
```

Configure that upstream with an `X-Api-Key` header containing the moon's own distinct MCP API key.
Steel MCP hashes the key into a tenant principal, strips it before dispatch, and binds every browser
handle to that principal. The local Steel Browser never receives the key. Do not reuse one key for
multiple moons: callers with the same key intentionally share one tenant and can resume each
other's sessions. A moon still passes the opaque `session_id` to session tools; if it loses that
handle, `steel_session_diagnostics` with `list_live: true` rediscovers only that tenant's live ones.

The sidecar treats possession of any non-empty key as tenant identity; it does not call back into the
moon's MCP desk to validate it. Keep the Service cluster-private as shown. A leaked key grants access
to that tenant, while an invented key creates a separate tenant and can consume shared capacity.

Handles and tenant clients persist across HTTP requests but are held in memory with the single
replica shown here. `REDIS_URL` plus a shared `STEEL_REQUEST_STATE_SECRET` can preserve handles
across an MCP-sidecar restart while its browser stays alive. Redis alone does not make this combined
Deployment horizontally scalable: each handle still belongs to the browser in the Pod that created
it. Multiple replicas also require a shared/routable Steel backend or tenant/session-aware routing
to the owning Pod. Each MCP credential transparently reuses one browser profile after its live
Chrome session is released. The standalone YAML manifests still place those profiles on an
`emptyDir`, so they survive idle/release but not Pod replacement. The Terraform cluster-services
deployment mounts `browser-profiles`, a configurable persistent volume claim, instead.

The manifest admits 20 browser sessions, expires them after two hours, retains at most 20
released-session records, and admits at most one live session per credential so a Chrome profile
never has concurrent writers.

Viewer and credential-entry links expire at the earlier of the session's hard deadline and
`SESSION_VIEWER_MAX_TTL_MS` after issuance (two hours by default). The bot's
`browser handoff <session_id>` tool resolves a fresh signed link through its configured MCP
connection and passes it directly to the native login card. The model supplies only the session
handle, never the signed URL. A released session is unavailable even if its link has time remaining.

## Bare-metal GAR authentication

The Pod mirrors the working Voyager pattern on `ovh-test-1`:

- it runs as the existing `pioneer` Kubernetes ServiceAccount;
- it is scheduled onto nodes labeled `node.tlon.io/planetary=true`;
- it mounts the existing `pioneer-wid-config` ConfigMap; and
- it projects a one-hour `ksa-token` for the `ovh-test-1` Workload Identity provider.

The projected volumes provide Google ADC after a container starts. They cannot authorize the
initial image pull because kubelet pulls images before creating or mounting container volumes. The
pull itself therefore depends on the bare-metal nodes' existing GAR credential provider, using the
same ServiceAccount/node path as Voyager.

The audience in `steel.yaml` is specifically for `ovh-test-1`. Change it to the target
bare-metal cluster's `WORKLOAD_IDENTITY_POOL_AUDIENCE` when deploying elsewhere; that cluster
must also provide its corresponding `pioneer-wid-config` ConfigMap.

The patched self-hosted Steel MCP server honors `STEEL_MAX_SESSIONS`, so the sidecar and browser both
admit 20 concurrent sessions. Sessions have a two-hour hard lifetime and a 30-minute idle timeout.
Explicit session requests can choose a shorter lifetime. The per-credential request-rate budget
is separate from these settings. Keep the Deployment at one replica while MCP handles are
process-local. Monitor browser memory usage: the concurrency ceiling does not reserve memory
for 20 heavy pages.

The NetworkPolicy limits ingress to Pods in `tlon`; `X-Api-Key` provides the tenant boundary within
that network. Requests without a supported credential are rejected before a tenant runtime exists.

## Planet-backed saved logins

`BROWSER_VAULT_ENABLED=true` on both the MCP and viewer containers enables saved logins.
The manifests leave it disabled until the service and secrets are configured. Native secure
forms offer an unchecked save option and an owner-only account chooser. Bot settings lists and
deletes saved logins. `browser_login` fills through the private browser API and returns only a
status; it never exposes an account list or password to the model. OTPs, new-password fields,
cards, cross-origin frames/actions, and HTTP origins are excluded.

Provision `browser-vault-secrets` in each Steel deployment with these keys:

- `encryption-key`: a persistent, base64-encoded 32-byte random key, used only by Steel MCP.
- `key-id`: the identifier for that encryption key, such as `primary`.
- `service-token`: a separate random secret of at least 32 characters, shared by the viewer,
  Steel MCP, and Pioneer. Set Pioneer's `BROWSER_VAULT_SERVICE_TOKEN` to this value.

Use the same encryption key and key ID across browser clusters in one environment, and keep a
secure backup. Test and production use separate keys. There is no generated startup key or
plaintext fallback. Changing the encryption key requires a deliberate authenticated re-encryption
migration of stored records; replacing or losing it makes those records unreadable. Rotating a
moon's login code or the planet owner token does not require re-encryption.

MCP derives an AES-256-GCM key for each `(planet, moon)` pair using HKDF-SHA256. Pioneer verifies
the moon's current browser key, derived locally from its login code, before any browser retrieval.
The code stays in Pioneer. The configured `X-Tlon-Parent-Ship` and `X-Tlon-Ship` upstream headers
are routing hints until this verification succeeds. Native owner requests additionally prove the
planet's authenticated `%genuine` token before listing, saving, choosing, or deleting a login.
A signed viewer link alone grants no durable-vault authority.

Pioneer stores only encrypted records in the **parent planet's** `%settings` bucket
`%moltbot/%browser-logins`. Each entry is scoped to one bot moon and exact HTTPS origin, with
version, record ID, revision, timestamps, and key ID authenticated by the cipher. Sibling bots do
not share entries. Updates and deletes check the record revision under the planet's writer lock.
Save acknowledgement waits until the planet's scry observes the write; successful form filling
and successful saving are reported separately. Neither result proves sign-in.

Deploy Pioneer with the service token, then the matching MCP/browser/viewer images, then enable
both feature flags. Start with synthetic accounts for two bot moons: verify isolation, owner
selection, username/password steps, deletion, rejected retries, expired/replayed handoffs, and
browser-key/owner-token rotation. The viewer-to-MCP route and browser REST API remain private;
Pioneer routing uses the fixed operator-controlled HTTPS origin template. Owner tokens and
credential payloads are excluded from request logs. Secure fills redact known values from browser
logs and stop recording that session's remaining DOM/image events.
Chrome password-manager and autofill saving are disabled; existing profile data is preserved.

Turning both flags off disables saving and reuse while preserving ciphertext on the planet.
Existing browser cookies are separate: deleting a saved login does not sign out a browser.
