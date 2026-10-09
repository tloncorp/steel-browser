# Multi-session deployment

Steel Browser can run multiple concurrent CDP sessions in one API process. Each session owns:

- a dedicated `CDPService` and Chrome process;
- a profile at `<profile-root>/<profile-id-or-session-id>`;
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
`persist: true`. A persistent session may also provide a UUID `profileId` independent of its live
session ID. Later sessions using that profile ID reopen the same cookies and browser state without
keeping Chrome running between them. Only one live session may use a profile ID at a time.
Persistent profiles need durable storage, a PVC quota, and a separate retention policy.

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

## Streamed viewer input

The session viewer turns finger swipes into scrolling and taps into clicks. A mouse supports
held dragging and wheel scrolling. The toolbar keeps back, forward, address, keyboard, layout,
and browser options on one row. On opening, the viewer detects mobile devices from
browser device information, including touch-capable iPads using a desktop identity. Phones and
tablets start in Mobile layout using the viewer's dimensions; desktop browsers start in Agent View.
A narrow desktop window alone does not select Mobile. Reconnecting preserves the selected layout.
The screen icon selects Agent View, Auto, Mobile, or Desktop; browser options contain tabs, reload,
and viewer control. Device detection also applies inside the native app viewer.

To enter text, tap the browser field, then tap the keyboard icon. The keyboard panel displays
and edits the text entered during that keyboard session. It supports composition, selection,
replacement, deletion, paste, and Enter. Enter sends the key to the page and starts a fresh draft.

Each page accepts input from one viewer connection. Input carries the page ID, a control generation,
a viewport generation, and an increasing sequence number. The viewer enables input after it paints
and acknowledges a frame with the current dimensions. Rotation, pointer cancellation, backgrounding,
disconnection, and link expiry cancel held contacts, mouse buttons, keys, and unfinished composition.
A reconnect obtains fresh control and frame state without replaying input. Viewer arbitration is
page-scoped; agent and direct CDP access operate independently.

When a viewer takes control, its WebSocket `User-Agent` header becomes the remote tab's HTTP
user agent and `navigator.userAgent`. A changed user agent reloads the current page so its next
request uses the viewer's identity. Initial layout and identity changes share one reload. Control
does not wait for page loading to complete; input waits for a frame from the committed document.
Reconnecting with the same user agent and layout does not reload. The tab keeps that user agent after the viewer disconnects;
a new controlling viewer supplies its own. Watching a tab does not change its user agent. This
changes the reported user agent, not Chrome's browser engine or the rest of its device fingerprint.

The public gateway supplies the verified capability deadline to the casting service. An open viewer
connection closes at that deadline or the session deadline, whichever comes first. Secure form fills
also recheck their deadline after reading the request body and before dispatching to the browser.
Deploy the API and viewer template together: the input protocol requires matching versions.

Secure form handoffs discover visible, editable native controls without requiring login or autofill
semantics. Field labels come from the page's accessible labels, placeholders, or names; discovery
does not return existing input values. Text fields and textareas retain their labels and required
status. Radio groups appear as choices, while checkboxes and individual multiple-select options
appear as Yes/No choices. A focused form takes precedence when a page has several forms; without
focus, discovery selects a single form in the page's primary-content landmark (`main` or
`role="main"`), or the sole form on the page. Secondary landmarks such as `aside` do not compete
with a unique primary form. Multiple primary forms still require focus. Fields in frames contained
by the selected form, including nested cross-origin frames, join the same handoff. Each frame retains
its own URL, origin, and node bindings; detached, hidden, navigated, or replaced destinations reject
filling. Unrelated frame forms stay separate. General forms fill without submitting. Login forms
can submit when explicitly requested. File uploads and custom widgets require the live browser.

Each signed viewer link offers one successful secure form fill. After filling, credential discovery
with that link returns 404, allowing the app to finish its polling and return control to the bot.
The link still opens the live browser. The bot inspects the current page and requests a fresh
handoff for each step needing owner input. Reading the session through the internal gateway mints
a distinct signed link, even when the session deadline is unchanged. Failed fills require fresh
field discovery and input; they do not close the link's secure-entry round.

Run the input, viewport, and public-gateway browser checks with a local Chrome:

```sh
CHROME_EXECUTABLE_PATH=/usr/bin/google-chrome npm exec -w api -- vitest run src/plugins/browser-socket/casting-input.test.ts src/plugins/browser-socket/casting-viewport.test.ts src/plugins/browser-socket/casting-viewer.browser.test.ts
node --test session-viewer/server.test.mjs
```

For phone acceptance, open a viewer link in Chrome on an iPhone and verify tap and swipe scrolling,
text entry with the software keyboard, composition, deletion,
paste, rotation during a gesture, and return from backgrounding. Verify input against the same
browser page after reconnecting. The Chrome tests use harmless page and cross-origin iframe
fixtures; a live challenge requires separate manual verification.

### Tlon native viewer

Tlon embeds the same viewer with floating native Close, keyboard, paste, and
Browser options controls. The options menu selects **Agent View** or
**Mobile View**. The viewer detects the device when it opens and starts phones in Mobile View.
Agent View leaves the live browser viewport unchanged, including
agent-initiated resizes. Pinch zoom and panning affect only the streamed image.
In Agent View, double-tapping while zoomed in resets the image to its centered,
default scale without clicking the remote page. Single taps while zoomed wait
300 ms to distinguish the reset gesture;
taps and scrolling still use the ordered viewer input protocol. Mobile View
explicitly changes the shared page's viewport and mobile emulation. Switching
emulation asks before reloading; Agent View restores the viewport captured before
the switch. In the native viewer, Mobile View reserves the safe area and control
rows above and below the page on a dark background, and uses the remaining area
for the remote viewport. Agent View remains edge-to-edge. Keyboard presentation
does not resize the remote page.

The native options menu also offers **Show browser controls**, off by default for
each new viewer. It reveals the existing Back, Forward, address field, and browser
menu below the native controls. Native keyboard and layout controls remain in the
app. The toolbar can be shown in either view; Agent View retains the remote
viewport, while Mobile View fits the space below the toolbar.

The `tlonBrowserInput` native bridge accepts versioned keyboard, paste, layout, insets,
`browserControls` (`visible: boolean`), and status commands. Input status includes
`browserControlsVisible`; clients disable the toggle when an older viewer omits
that capability. Its context changes with connection/control/frame epochs;
clipboard content never appears in status messages. Native layout confirmation
and paste must use the latest context. The standalone web toolbar and dashboard
clipboard bridge remain available outside the React Native WebView.

For deployment, build the `steel-browser` API image from the branch containing
both the streamed-input changes and this native integration. The API build copies
all viewer templates, including the native-input and gesture partials. This native
integration adds no environment variables, migrations, or new public endpoints;
it does not change the `steel-mcp` or `session-viewer` images. A deployment that
predates the streamed-input changes must also include their matching gateway
changes. The Tlon native controls require the separate client update; standalone
viewer links remain usable while that client update is pending.
