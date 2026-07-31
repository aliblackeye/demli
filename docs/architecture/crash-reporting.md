# Crash Reporting (Desktop)

Two systems, deliberately separate:

| | **Local crash log** (M5) | **Sentry** (M19, optional) |
| --- | --- | --- |
| Purpose | Post-mortem on **the founder's own machine** | Errors from **users we cannot reach** |
| Default | Always on | **OFF** — needs a build-time DSN |
| Destination | `userData/logs/crash.log` + minidumps on disk | Sentry SaaS (free tier) |
| Content | Full messages + stacks + native minidumps | Scrubbed message + normalized stack only |
| Network | **Never** | Only when a DSN was baked in |

The local log is the primary record and is **unchanged**: it keeps working
identically whether or not Sentry is enabled. Sentry is a strictly additive
second sink hanging off the same crash paths. Nothing was removed.

Code:

- `apps/desktop/src/main/crash-reporter.ts` — native reporter, process-gone
  handlers, main-process `uncaughtExceptionMonitor`, validated renderer-error
  IPC handler, rotating log writer. Every path also calls Sentry (no-op when
  disabled).
- `apps/desktop/src/main/crash-reporter-types.ts` — shared contract (IPC channel
  name, payload bounds, `RendererErrorReport` / `CrashBridge` types).
- `apps/desktop/src/main/sentry.ts` / `sentry-types.ts` — the minimal Sentry
  client (see "Sentry" below). `sentry.test.ts` covers it.
- `apps/desktop/src/preload/index.ts` — exposes `window.demli.crash`.
- `apps/desktop/src/renderer/src/components/ErrorBoundary.tsx` — React error
  boundary + global `onerror` / `onunhandledrejection` hooks + reporter helper.

## What is captured, and where

| Layer | Trigger | Mechanism | Destination |
| --- | --- | --- | --- |
| Native minidumps | Native (C++) crash of main / renderer / GPU / utility process | `crashReporter.start({ uploadToServer: false })`, started at module load before `app.whenReady()` | `app.getPath('crashDumps')` (Windows: `…\@demli/desktop\Crashpad`) — **never uploaded, not even to Sentry** |
| Process-gone | `render-process-gone`, `child-process-gone` | `app.on(...)` handlers log `reason` + `exitCode` (+ type/name) | userData `logs/crash.log` (+ Sentry) |
| Main-process exceptions | Uncaught throw / unhandled rejection in main | `process.on("uncaughtExceptionMonitor")` — the *monitor* variant, so Node's default crash behaviour is unchanged | userData `logs/crash.log` (+ Sentry) |
| Renderer JS errors | React render error, `window.onerror`, `unhandledrejection` | `window.demli.crash.reportRendererError(...)` → validated IPC → log | userData `logs/crash.log` (+ Sentry) |

`logs/crash.log` rotates to `logs/crash.log.1` once it passes 512 KiB (one
backup kept), so it can never grow without bound. Each line is a single-line,
timestamped `key=value` record; multi-line stacks are collapsed with `\n` so one
event stays on one line.

## IPC / bridge contract

- Channel: `demli:crash:report-renderer` (constant `CRASH_CHANNELS.reportRenderer`).
- Bridge: `window.demli.crash.reportRendererError(report): Promise<void>`.
- Payload (`RendererErrorReport`, zod-validated + length-bounded in main):
  - `message: string` (1–2000 chars, required)
  - `stack?: string` (≤ 8000 chars)
  - `componentStack?: string` (≤ 8000 chars)
- Report-only: the renderer can push an error; it can never read the log or the
  minidump directory back out.

## Renderer UX (CLAUDE.md §26 — no raw stack traces to users)

`ErrorBoundary` wraps `<App/>` (in `main.tsx`). On a render error it shows a
calm, dark, on-brand fallback ("Something went wrong" + a **Restart** button that
reloads the renderer) — never a stack trace. The error itself is sent to the
local log. The global `onerror` / `unhandledrejection` hooks are silent and
deduped (no console spam, no user-facing UI).

## Privacy stance (local log)

- **Local only.** `uploadToServer: false`. The log and the minidumps never leave
  the device — no account, no network endpoint, no telemetry.
- Only error diagnostics (message + stacks) are logged. Never tokens or other
  sensitive values.
- Users see friendly messages, not raw errors.

---

# Sentry (optional remote error monitoring)

Added in M19. **Disabled by default and disabled in every build shipped so far.**

## Turning it on — the founder's one step

1. Create a free Sentry account and a project (platform: *Electron* or *Node*).
2. Copy the DSN: **Settings → Projects → \<project\> → Client Keys (DSN)**. It
   looks like `https://<publicKey>@o000000.ingest.de.sentry.io/0000000`.
3. Put it in the **build** environment — it is baked into the app at package
   time, because a packaged Electron app has no environment of its own:

   ```bash
   # Windows release
   SENTRY_DSN=https://…@o…ingest.de.sentry.io/… \
     DEMLI_DOMAIN=getdemli.com pnpm --filter @demli/desktop package:win

   # macOS via CI: add a repository secret named SENTRY_DSN
   #   (Settings -> Secrets and variables -> Actions -> New repository secret)
   ```

   Locally, `SENTRY_DSN=` in a gitignored `.env` also works for `pnpm dev:desktop`.
4. Errors appear in Sentry tagged with the release (`demli-desktop@0.0.64`),
   so you can tell which version broke.

`VITE_SENTRY_DSN` is accepted as an alias. Both `.env.example` files carry the
line, empty, with the same warning.

## Off by default — what "off" actually means

No DSN ⇒ `initSentry()` returns `false` before touching any state and the module
is inert: no handlers, no timers, **no network request of any kind**. It is not a
"quiet mode", there is no client object at all. Malformed and non-`https` DSNs
are treated the same way (fail closed), so a typo can never produce a
half-working reporter.

This is enforced by tests, not just by reading the code —
`apps/desktop/src/main/sentry.test.ts` injects a fake transport and asserts it is
never called for `undefined` / `""` / whitespace / malformed / `http://` DSNs.

## Where the renderer fits

The renderer **does not talk to Sentry**. Renderer errors already travel to main
over the validated `demli:crash:report-renderer` IPC bridge; main forwards
them, tagged `process=renderer`. Consequences, all of them deliberate:

- the renderer CSP needs no Sentry ingest origin in `connect-src`;
- the DSN never enters renderer JS;
- there is exactly **one** place where scrubbing happens, so it cannot be
  bypassed by a future renderer code path.

## What is sent — and what never is

Sent: error type + scrubbed message, a normalized stack, the release version,
`environment`, and coarse tags (`process`, `os`).

**Never sent** (this matters — the repo is going public, CLAUDE.md §28):

- **No user identity.** No id, email, username, IP, or hostname. This is
  structural, not a setting: no code path in `sentry.ts` can read an account.
  (Equivalent to Sentry's `sendDefaultPii: false`, but stronger.)
- **No message content, channel/group names, or any app data.** The only callers
  are the crash paths above, which carry error text and stacks.
- **No breadcrumbs and no automatic instrumentation.** There is no HTTP, console,
  or navigation hook — the usual way user content leaks into an error tracker
  does not exist here.
- **No native minidumps.** `uploadToServer` stays `false`. A minidump is a raw
  memory snapshot and can contain anything the app had in memory.

Every string is passed through `scrubText()` — the `beforeSend` equivalent —
before it reaches the wire:

| Pattern | Becomes |
| --- | --- |
| `user@example.com` | `[email]` |
| `eyJhbGciOi….….…` (JWT) | `[jwt]` |
| `Bearer <token>` | `Bearer [redacted]` |
| `https://host/p?token=…` | `https://host/p?[redacted]` |
| `C:\Users\<name>`, `/Users/<name>`, `/home/<name>` | `…\[user]` |
| any opaque run of 48+ chars | `[redacted]` |

Stack frame paths are additionally rewritten to `app:///out/main/index.js` —
everything before the build-output marker (which is where the OS user name
lives) is dropped. Unrecognized paths collapse to a bare basename.

## Volume + failure behaviour

- Max **25 events per app run**, deduplicated by fingerprint — a crash loop
  cannot burn the free-tier quota.
- HTTP 429 honours `Retry-After` and backs off.
- Any transport failure (offline, DNS, TLS, 5xx) is swallowed. Reporting can
  never throw into the app, block a caller, or surface to a user.

## Implementation note: no `@sentry/*` dependency

`main/sentry.ts` speaks Sentry's public envelope protocol directly (one HTTPS
POST) instead of vendoring `@sentry/electron`. That SDK pulls `@sentry/node` and
with it the whole OpenTelemetry auto-instrumentation stack, which conflicts with
this app's packaging model (everything bundled into `out/`, **zero** shipped
`node_modules`) and would enlarge both the installer and the supply-chain
surface. Full rationale, what we give up, and the upgrade path if we ever want
the real SDK: [ADR 0018](../decisions/0018-desktop-error-monitoring.md).
