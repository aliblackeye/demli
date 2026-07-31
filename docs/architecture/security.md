# Security Rules

Security is not optional (CLAUDE.md §28). These rules apply from Milestone 0 onward.

## Electron

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` on every window.
- Renderer talks to native capabilities only through the minimal preload bridge.
- Validate every IPC payload in the main process — treat the renderer as untrusted.
- Restrict navigation: deny window opens, block `will-navigate` away from our UI,
  open external `https://` links in the OS browser.
- Never expose raw filesystem, shell, or `ipcRenderer` to the renderer.
- No remote code execution patterns (no `eval`, no loading remote JS into privileged contexts).

Details and current implementation: see electron.md.

### Third-party frames (since M20 / ADR 0016)

Watch Party put the first content we do not control inside the app window. That
changes the threat model, so the rules that used to be implicit are written down:

- `frame-src` names **one exact host** and nothing else, in BOTH policies (the
  desktop CSP plugin and the `app.{$DOMAIN}` header in `Caddyfile`). Whichever is
  looser is the one that counts, so they are kept identical and
  `scripts/check-caddyfile.mjs` enforces the web half as an exact set.
- `will-navigate` covers the MAIN frame only. Subframe navigation needs its own
  guard (`will-frame-navigate` + `main/frame-navigation-policy.ts`), comparing
  parsed hostnames — never URL prefixes — and failing closed.
- A refused frame navigation is **cancelled, not re-opened externally**. Treating
  it as "the user wants this page" would turn a hostile embed into a launcher for
  arbitrary URLs.
- Nothing identifying may be handed to the embed: no user id, no group id, no
  channel id — not in the URL and not over `postMessage`. Correlation ids sent to
  a third party must be opaque and per-instance, or the embed provider can link
  the members of a private group to each other.
- `postMessage` is validated on BOTH sides: incoming by `event.origin` **and**
  `event.source`, outgoing with an exact `targetOrigin` (never `"*"`).

**Closed (was the one open item from the Watch Party review).** `setWindowOpenHandler`
used to deny the in-app window but still hand any `https://` URL to the OS browser —
a path the embed could reach (an ad or end-screen card using `target="_blank"`),
which contradicted the "cancelled, not re-opened externally" rule two bullets up.
It now returns `deny` **unconditionally**: the installed handler
(`denyWindowOpen`, main/external-link-policy.ts) takes **no arguments**, so it
cannot branch on the requested URL at all.

Our own external links ask for a browser tab explicitly instead, over one narrow
preload verb — `externalLinks.open(url)` → `external-link:open`
(main/external-link.ts). The renderer never receives `shell`, so `openPath`,
`showItemInFolder` and `trashItem` stay unreachable. Every request is:

- zod-bounded, then re-parsed by `isOpenableExternalUrl` — **http(s) only**, no
  embedded credentials, non-empty host. `javascript:`, `data:`, `file:` and every
  custom scheme (which the OS resolves to a registered *application*) are refused.
- accepted only from the **top frame of one of our own windows**. A subframe —
  i.e. the embed — is refused outright.
- rate limited (6 per 10 s), so a compromised renderer cannot carpet the desktop
  with browser windows.

The shared UI calls one seam, `openExternalUrl` (packages/app-ui
platform/external-link.ts): the preload verb when a bridge is present, a plain
`noopener` `window.open` otherwise — so the browser build, which has no main
process to deny anything, keeps working unchanged.

## Backend (api + realtime)

- **Validate all input** at the boundary (zod on HTTP bodies/params and on WebSocket payloads).
  The realtime gateway already rejects malformed JSON and unknown event types.
- **Auth middleware** on every non-public route; authenticate the WebSocket on connect.
- **Rate limit** login, message send, and invite endpoints — and see "Resource limits" below,
  which is the full policy for both transports.
- **Never trust client-asserted permissions.** The server checks group membership and role
  (Owner/Member/Guest) on every action — the client's opinion is UI hint only.
- Store passwords securely (argon2/bcrypt) if password auth exists; prefer magic link/OAuth early.
- Sessions/tokens: short-lived, revocable, never logged.

## Resource limits (availability)

Confidentiality is not the only security property — one client must never be able to take the
service down for everyone. Every limit below has its rationale in a comment at the constant.

- **Inbound WS frame cap.** `maxPayload = 64 KiB` on the gateway's `WebSocketServer`. Without it
  `ws` accepts 100 MiB per frame and allocates it before any validation runs. 64 KiB is ~2.4× the
  largest legitimate frame (`message.send` with full content + attachment ids ≈ 26 KB). Oversized
  frames get a 1009 close; the process survives.
- **Outbound backpressure.** A connection whose unflushed queue passes 1 MiB is terminated
  (`apps/realtime/src/backpressure.ts`). The heartbeat reaper only catches sockets that stop
  answering pings — a slow consumer is alive, so without this the write queue grows unbounded.
  1 MiB is ~40× the largest server frame, so an honest client on a bad link is never dropped.
- **Per-event WS budgets.** Every client→server event has a token bucket, sized per event class:
  `message.send` 10/2 per s, `typing.*` 20/5 per s, `presence.update` 10/1 per s, and
  `presence.app_state` + `voice.join`/`voice.leave` sharing 30/5 per s. Separate buckets so a
  chatty composer cannot starve a voice join. Over-budget frames are dropped SILENTLY for
  fire-and-forget events — an error reply per rejected frame would turn an inbound flood into an
  equal outbound one.
- **HTTP limits are per session, not per IP** (`perSessionKey`), so NAT cannot shield an abuser.
  Every write endpoint and every endpoint that mints signed storage URLs carries one. Plain
  GET/list reads are intentionally unlimited — the client pages through history and infinite
  scroll must not 429.
- **Reconnect jitter.** The client's backoff jitter scales with the attempt (0-0.5 s on the first
  retry, up to 0-5 s later), so a restart does not bring the whole fleet back in lockstep against
  a 10-connection DB pool. The first retry stays fast so a blip still heals instantly.

## Chat content

- **Escape message content** — render as text, never as HTML.
- No unsafe markdown/HTML rendering; if markdown is added later, use a sanitizing renderer
  with a strict allowlist.
- Validate attachment types and sizes when attachments arrive (post-MVP).
- Never show raw stack traces or internal errors to users.

## Secrets

- **`.env` files are never committed.** Only `.env.example` with dev placeholder values.
- Real secrets (LiveKit keys, JWT secret, DB credentials) live in local `.env` files
  or the deployment environment — never in Git, code, or docs.
- Dev defaults in `.env.example` (e.g. `JWT_SECRET=dev-only-change-me`) must never reach
  a real deployment.

## Review gate

The security agent reviews Electron config, auth/session handling, IPC validation, rate limits,
and secret handling before any milestone ships (Milestone 5 has a dedicated pass).
