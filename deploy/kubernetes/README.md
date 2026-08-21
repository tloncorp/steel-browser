# Kubernetes deployment

This deployment runs Steel Browser and the Steel MCP HTTP bridge in one Pod. The MCP sidecar talks
to the browser over loopback, and the `steel-mcp` ClusterIP Service exposes only the MCP port to
other workloads in the `tlon` namespace.

The browser image is:

```text
us-central1-docker.pkg.dev/prod-f0181862/images/steel-browser:latest
```

Build the separate MCP sidecar image from the directory containing the sibling
`steel-browser` and `steel-mcp-server` checkouts:

```sh
docker build \
  -f steel-browser/Dockerfile.steel-mcp \
  -t us-central1-docker.pkg.dev/prod-f0181862/images/steel-mcp:latest \
  steel-mcp-server
docker push us-central1-docker.pkg.dev/prod-f0181862/images/steel-mcp:latest
```

Deploy and wait for readiness:

```sh
kubectl apply -f steel-browser/deploy/kubernetes/steel.yaml
kubectl -n tlon rollout status deployment/steel
```

Configure each Urbit MCP desk with:

```text
http://steel-mcp.tlon.svc.cluster.local:8000/mcp
```

The manifest admits four browser sessions, expires them after 15 minutes, retains at most 20
released-session records, and bounds disposable profile storage to 8 GiB.

The current self-hosted Steel MCP server hard-codes its own session limit to one. Its config must be
patched to honor `STEEL_MAX_SESSIONS` before the sidecar will open four sessions. Keep the
Deployment at one replica while MCP handles are process-local.

The Service is not an authentication boundary. The NetworkPolicy limits ingress to Pods in
`tlon`, but a tenant-aware MCP layer must still enforce which caller owns each browser handle.
