# Home WireGuard egress test

This runs only a standard WireGuard server. The Kubernetes pod runs `wireproxy`, an unprivileged
userspace WireGuard client that exposes `socks5://127.0.0.1:1080`. Steel sends Chromium traffic to
that loopback proxy. No browser, HTTP proxy, or custom service runs at the VPN endpoint.

This is the same client architecture used with a commercial VPN: replace the Kubernetes Secret
with the provider's standard WireGuard peer config. The remote endpoint only needs ordinary
WireGuard egress/NAT.

The generated keys and peer configuration live under `.data/`, which is gitignored. Do not commit
that directory or the Kubernetes Secrets created from it. Each cluster has its own WireGuard
identity; never install the same peer configuration in two clusters because the endpoints will
steal the peer route from each other.

The generated peer-to-cluster mapping is:

| Cluster | Generated peer directory |
| --- | --- |
| `ovh-test-1` | `.data/peer_steelcluster/` (existing identity) |
| `ovh1` | `.data/peer_ovh1/` |
| `ovh2` | `.data/peer_ovh2/` |
| `ovh3` | `.data/peer_ovh3/` |
| `east5` | `.data/peer_east5/` |

The existing `steelcluster` peer is retained for `ovh-test-1` so the working test-cluster Secret
does not need a key rotation. New generated peer names are alphanumeric because that is what the
linuxserver/wireguard generator accepts.

Start the home endpoint:

```sh
cd deploy/home-wireguard
PUID=$(id -u) PGID=$(id -g) WIREGUARD_SERVER_URL=home.scogg.in docker compose up -d
docker compose logs -f wireguard
```

At the time of this test, `home.scogg.in` also resolves to the stale address `162.255.119.214`.
Remove that A record before using the hostname. The local ignored `.env` currently pins
`WIREGUARD_SERVER_URL=173.174.34.185` so the generated peer uses the working residential address.

Changing `PEERS` regenerates the server configuration. Start or refresh the endpoint before
installing the Secrets:

```sh
docker compose up -d
docker compose logs --tail=100 wireguard
```

Create each cluster's Secret from its own generated peer configuration. The pod normalizes the
address for userspace WireGuard, adds a client-side keepalive, and adds only a pod-local SOCKS5
listener. The standard WireGuard keys and endpoint are otherwise unchanged.

```sh
# ovh-test-1 (existing identity; only needed when creating or restoring the Secret)
kubectl -n tlon create secret generic steel-wireguard \
  --from-file=wg0.conf=.data/peer_steelcluster/peer_steelcluster.conf \
  --dry-run=client -o yaml | kubectl apply -f -
```

For production, select the matching cluster context and set `profile` to that cluster's peer before
running the same command:

```sh
# One of: ovh1, ovh2, ovh3, east5. Confirm kubectl's current context first.
profile=ovh1
kubectl config current-context
kubectl -n tlon create secret generic steel-wireguard \
  --from-file="wg0.conf=.data/peer_${profile}/peer_${profile}.conf" \
  --dry-run=client -o yaml | kubectl apply -f -
```

Build and push the userspace client and Steel images, apply `../kubernetes/steel.test.yaml`, then
verify residential browser egress:

```sh
cd ../..

docker build -f Dockerfile.wireproxy \
  -t us-central1-docker.pkg.dev/test-61eb624c/images/wireproxy:latest .
docker push us-central1-docker.pkg.dev/test-61eb624c/images/wireproxy:latest

docker tag us-central1-docker.pkg.dev/test-61eb624c/images/wireproxy:latest \
  us-central1-docker.pkg.dev/prod-f0181862/images/wireproxy:latest
docker push us-central1-docker.pkg.dev/prod-f0181862/images/wireproxy:latest

docker build \
  -t us-central1-docker.pkg.dev/test-61eb624c/images/steel-browser:latest .
docker push us-central1-docker.pkg.dev/test-61eb624c/images/steel-browser:latest

kubectl apply -f deploy/kubernetes/steel.test.yaml
kubectl -n tlon rollout status deployment/steel --timeout=5m

kubectl -n tlon logs deployment/steel -c egress-wireproxy --tail=100
kubectl -n tlon exec deployment/steel -c browser -- \
  curl -fsS --proxy socks5h://127.0.0.1:1080 https://api.ipify.org
```
