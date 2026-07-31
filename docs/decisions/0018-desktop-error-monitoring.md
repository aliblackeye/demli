# 0018 — Desktop error monitoring: Sentry protocol, no Sentry SDK

Status: Accepted
Date: 2026-07-27
Owner: DevOps/Release

## Context

M19 (reliability) asks for real error monitoring on the desktop app: today the
only crash record is a **local** file on the user's machine
(`docs/architecture/crash-reporting.md`), which is useless for anyone but the
founder. We want errors from real installs, on the **free Sentry tier**.

Three constraints shaped the decision:

1. **Packaging.** `apps/desktop` bundles main, preload and renderer into `out/`
   and ships **zero `node_modules`** (`electron-builder.yml` `files:` is a
   positive include list; `package.json` has no prod `dependencies` on purpose).
   That property is load-bearing — it is what fixed the 347 MB installer.
2. **Privacy.** Demli is a private messaging app and the repo is going public
   (memory: *Open-Source Plan*). A leak of message text, a token, or a user's
   Windows account name into a third-party service would be a serious,
   permanent embarrassment. CLAUDE.md §28.
3. **No account yet.** There is no Sentry org or DSN. Whatever we build must be
   completely inert until the founder pastes one in, and must not be a
   half-working "waiting for DSN" state.

`@sentry/electron@7` depends on `@sentry/node@10`, which brings the OpenTelemetry
auto-instrumentation stack (~20 packages plus `import-in-the-middle` /
`require-in-the-middle`, which rely on runtime `require` hooks that do not
survive bundling). Adopting it means either abandoning the zero-`node_modules`
packaging model or fighting the bundler — plus a large installer increase and a
large new dependency surface in a repo about to be public.

## Decision

Implement a **minimal, dependency-free Sentry client** in the main process
(`apps/desktop/src/main/sentry.ts`) that speaks Sentry's documented public
ingest protocol: one HTTPS POST of an envelope containing a JSON event. Events
land in a normal Sentry project and behave like normal Sentry events.

Specifics:

- **Main process only.** The renderer already forwards its errors to main over
  the validated crash IPC bridge, so main is the single egress point. The
  renderer bundle contains no reporting code, the renderer CSP needs no ingest
  origin, and scrubbing happens in exactly one place.
- **Off unless a DSN is baked in** at build time (`SENTRY_DSN` /
  `VITE_SENTRY_DSN` → `__SENTRY_DSN__` via the vite `define` in
  `electron.vite.config.ts`). Empty, malformed or non-`https` ⇒ no client, no
  network. Fail closed.
- **Additive.** The local crash log and native minidumps are untouched and
  remain the primary record; minidumps are still never uploaded.
- **Scrub everything** (`scrubText`, the `beforeSend` equivalent): emails, JWTs,
  bearer tokens, URL query strings, home-directory paths, long opaque runs.
  Stack frame paths are rewritten to `app:///…`. No user identity is ever
  attached — structurally, not by configuration.
- **Bounded:** ≤25 events per run, deduplicated, `Retry-After` honoured, all
  failures swallowed.

## Consequences

Good:

- No new runtime dependency; installer size and packaging model unchanged.
- The entire privacy surface is ~50 lines we control and unit-test, rather than
  an SDK whose defaults (breadcrumbs, HTTP instrumentation, `sendDefaultPii`)
  must be audited on every upgrade.
- Nothing at all happens until a DSN exists, which is provable — and proved by
  `sentry.test.ts` with an injected transport.

Costs (accepted, and reversible):

- **No source maps / no symbolication.** Stacks reference minified bundle
  positions. Mitigated by frames carrying `filename:line:col` and by errors
  being tagged with the exact release. If this hurts, upload source maps with
  `sentry-cli` — the event format already supports it.
- **No breadcrumbs, sessions, release health, or performance data.** We
  deliberately do not want automatic breadcrumbs (that is the leak vector).
- **No native crash upload.** Native minidumps stay local by choice.
- We own protocol compatibility. The envelope format is public and stable, but
  it is one more thing to maintain.
- **Unverified against a live Sentry project** — there is no DSN yet. The
  payload shape is unit-tested, but the first real DSN build is the true
  end-to-end test.

## Alternatives considered

- **`@sentry/electron`** — rejected above: incompatible with the
  zero-`node_modules` packaging model, large installer + supply-chain cost,
  and its safe-by-default privacy posture would still need a full audit.
  *Reversal path if we change our mind:* add it to `dependencies`, externalize
  it in `electron.vite.config.ts`, re-include `node_modules` in
  `electron-builder.yml` `files:`, then replace the body of `captureSentryError`
  with `Sentry.captureException` and keep `scrubText` as `beforeSend`. The call
  sites in `crash-reporter.ts` do not change.
- **Self-hosted GlitchTip / Sentry** — same protocol (this client already works
  against it: `parseDsn` supports a path prefix), but more VPS load and another
  service to run. Can be adopted later by changing only the DSN.
- **Ship errors to our own API** — a new endpoint, storage, retention and
  moderation problem for no benefit over a free tier that already does it.
- **Do nothing / keep local-only** — rejected: it leaves us blind to every crash
  on a machine that is not the founder's, which is exactly the M19 goal.
