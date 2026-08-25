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
to the owning Pod. Browser profiles remain disposable `emptyDir` data and do not survive Pod
replacement.

The manifest admits four browser sessions, expires them after 15 minutes, retains at most 20
released-session records, and bounds disposable profile storage to 8 GiB.

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
admit four sessions. Keep the Deployment at one replica while MCP handles are process-local.

The NetworkPolicy limits ingress to Pods in `tlon`; `X-Api-Key` provides the tenant boundary within
that network. Requests without a supported credential are rejected before a tenant runtime exists.
