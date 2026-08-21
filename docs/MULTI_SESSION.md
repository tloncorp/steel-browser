# Multi-session deployment

Steel Browser can run multiple concurrent CDP sessions in one API process. Each session owns:

- a dedicated `CDPService` and Chrome process;
- a profile at `<profile-root>/<session-id>`;
- a download directory inside that profile; and
- session-addressed CDP, debugger, cast, page, recording, and log WebSockets.

The existing default browser remains available for stateless quick-action endpoints. Legacy
session endpoints that omit a session ID continue to work with zero or one active session and fail
closed when multiple sessions make the request ambiguous.

## Configuration

| Variable                  | Default               | Purpose                                                               |
| ------------------------- | --------------------- | --------------------------------------------------------------------- |
| `SESSION_PROFILE_ROOT`    | a temporary directory | Parent directory for session profiles                                 |
| `MAX_CONCURRENT_SESSIONS` | unlimited             | Per-process admission limit for active sessions                       |
| `MAX_RETAINED_SESSIONS`   | `100`                 | In-memory released/failed session records; use `0` to disable history |
| `SESSION_TTL_MS`          | unlimited             | Automatically release sessions after this many milliseconds           |

Set a concurrency limit based on pod memory and CPU. Active browser cost is linear because every
session is a separate Chrome process. Scale horizontally after that limit and route every request
for a session to the pod that owns it. Set `SESSION_TTL_MS` as a backstop for clients that fail to
release their sessions.

Profiles and downloads are removed after release unless the session was created with
`persist: true`. Persistent profiles survive under the same session ID and need a PVC quota and a
separate retention policy.

## Routing and trust boundary

The session ID is carried in the URLs returned by `POST /v1/sessions`, including the root CDP
WebSocket:

```text
ws://steel-browser:3000/?sessionId=<uuid>
```

A session ID selects a runtime; it is not authentication. Do not expose the Steel Browser API
directly to tenants. Put an authenticated broker or tenant-aware MCP server in front of it, bind a
tenant to the sessions it created, and deny arbitrary cross-tenant session IDs.

The legacy file API and aggregate log-query routes remain process-global. Keep them on an
operator-only network (or disable log routes) until they are made tenant-aware. Browser downloads
for multi-session CDP runtimes are session-scoped and follow profile cleanup.

## MCP compatibility

The Steel MCP session API and CDP URL shape are unchanged. The self-hosted Steel MCP server has its
own concurrency limit, so it must be configured or patched separately before one MCP process can
use this browser's full concurrency.
