# Deployment — Self-Hosted Production (Hybrid)

Status: **deployed and live in production** on `getdemli.com` — API, realtime
gateway, LiveKit and the web app all run from this stack. Architecture is locked
by [ADR 0003](../decisions/0003-self-host-deploy.md). If you are standing up your
own instance, start at "What you must provide" and the first-deploy runbook.

## Topology

Database is **Supabase** (managed Postgres). Everything else runs as containers
on **one VPS**, fronted by Caddy for automatic HTTPS/WSS. Media (voice/screen)
uses LiveKit's own UDP/TCP ports directly — it never passes through Caddy.

```
                              Internet
                                 │
   friends' desktop/mobile clients (no VPN; unblocked IP + real domain + TLS)
                                 │
        ┌────────────────────────┼──────────────────────────────┐
        │ HTTPS/WSS 443/tcp       │ media: UDP 7882 / TCP 7881    │
        │ (api, ws, livekit)      │ TURN: UDP 3478                │
        ▼                         ▼                              ▼
  ┌───────────────────────────── VPS (Docker) ───────────────────────────┐
  │                                                                       │
  │   ┌────────┐    api.DOMAIN   ┌──────────────┐                         │
  │   │ Caddy  │───────────────▶ │ api (Fastify)│──┐                      │
  │   │ :80    │    ws.DOMAIN    │  :4000       │  │                      │
  │   │ :443   │───────────────▶ ┌──────────────┐  │  DATABASE_URL        │
  │   │ (TLS)  │                 │ realtime :4001│──┼──────────────┐      │
  │   │        │  livekit.DOMAIN ├──────────────┤  │              │      │
  │   │        │───────────────▶ │ livekit :7880│  │              │      │
  │   └────────┘                 │  + TURN/media│  │              │      │
  │                              └──────┬───────┘  │              │      │
  │                                     │          │              │      │
  │                              ┌──────▼───┐  ┌───▼────┐         │      │
  │                              │  redis   │  │ migrate│(one-shot)│      │
  │                              │ (unused* │  │  job   │─────────┘      │
  │                              │  by app) │  └────────┘                │
  │                              └──────────┘                            │
  └───────────────────────────────────────────────┼──────────────────────┘
                                                   │ TLS (sslmode=require)
                                                   ▼
                                        ┌──────────────────────┐
                                        │  Supabase Postgres    │
                                        │  (managed, backed up) │
                                        └──────────────────────┘

  * redis backs realtime presence + the api↔realtime mutation bus — see "Redis" below.
```

Public hostnames. `DOMAIN` is **getdemli.com** and it is the only domain the
product uses. Every host below needs an A record pointing at the VPS IP; all but
`turn` have a Caddy vhost, and a vhost whose name does not resolve makes Caddy
retry its certificate forever, so **the DNS zone and the Caddyfile host list must
match exactly** (`pnpm lint:caddy` enforces the Caddyfile side).

| Host             | Purpose                                       | Reaches                       |
| ---------------- | --------------------------------------------- | ----------------------------- |
| `DOMAIN` (apex)  | Landing / marketing site + `/download/*`      | Caddy → static `/srv/landing` |
| `www.DOMAIN`     | Permanent 301 to the apex                     | Caddy                         |
| `app.DOMAIN`     | Web client (SPA + PWA) + mobile deep links    | Caddy → static `/srv/app`     |
| `api.DOMAIN`     | HTTP API (REST, auth, media tokens) + `/dl/`  | Caddy → api:4000              |
| `ws.DOMAIN`      | Realtime WebSocket (chat/presence/typing)     | Caddy → realtime:4001         |
| `livekit.DOMAIN` | LiveKit signaling (WSS)                       | Caddy → livekit:7880          |
| `turn.DOMAIN`    | TURN realm (LiveKit built-in TURN)            | VPS directly (UDP 3478)       |

There is **one** domain placeholder. A second one (`BRAND_DOMAIN`) existed until
the 2026-07-27 cutover and was removed rather than repointed — pointing both at
the same value defines every site twice, which Caddy refuses to load. See
"The domain (`getdemli.com`)" below for the full story and the invariants that
now guard it.

### Image tags are environment-scoped (`:prod`, never `:latest`)

The `api` and `realtime` images are built **on the VPS**, so their tags are just
local mutable names — there is no registry arbitrating them. `docker-compose.prod.yml`
and `scripts/deploy.sh` therefore agree on `demli/{api,realtime}:${IMAGE_TAG:-prod}`.

Why it matters even though only one stack exists today: with `:latest`, the first
time a second stack (staging) is ever built on this box it silently overwrites
the exact tag production restarts from. Nothing fails at that moment — the
running containers hold an image *ID*, not the tag — but the next `docker compose
up`, container restart or host reboot brings up **staging code in front of real
users**, with nothing in any log to explain it. An environment-scoped tag makes
that structurally impossible: a staging stack sets `IMAGE_TAG=staging` alongside
its own compose `name:` and the two never touch.

`IMAGE_TAG` needs no entry in `.env.prod` (both sides default to `prod`).
Precedence is shell env → `.env.prod` → `prod`. `deploy.sh` also removes the
retired `demli/*:latest` tags once the new stack is verified healthy —
`docker image prune` never reclaims a *tagged* image, so they would otherwise
hold ~1 GB each forever.

## Environment variables

Single source of truth: [`.env.prod.example`](../../.env.prod.example) (copy to
`.env.prod`, gitignored). Where each is consumed:

| Variable                         | Consumed by (verified in source)                              |
| -------------------------------- | ------------------------------------------------------------- |
| `DOMAIN`                         | Every Caddyfile vhost; deploy.sh (derives `TURN_DOMAIN`). The one and only domain — there is no second placeholder |
| `ACME_EMAIL`                     | Caddy (Let's Encrypt account)                                 |
| `APP_ENV`                        | `apps/api/src/env.ts`, `apps/realtime/src/env.ts` — **must be `production`**; activates the fail-fast secret checks |
| `DATABASE_URL`                   | `apps/api/src/env.ts`, `apps/realtime/src/env.ts`, `packages/db/src/migrate.ts` |
| `CORS_ORIGIN`                    | `apps/api/src/env.ts`                                         |
| `SESSION_TTL_HOURS`              | `apps/api/src/env.ts` (default 168 = 7 days)                  |
| `LIVEKIT_URL`                    | `apps/api/src/env.ts` (returned to clients in the media token)|
| `LIVEKIT_API_KEY` / `_SECRET`    | `apps/api/src/env.ts`; assembled into `LIVEKIT_KEYS` for the LiveKit server. The KEY (public ID only) is also rendered into `deploy/livekit.yaml`'s `webhook.api_key`; the SECRET never is |
| `TURN_DOMAIN`                    | `deploy/livekit.yaml` (rendered by deploy.sh)                 |
| `REDIS_PASSWORD`                 | compose: `redis --requirepass` + assembles the credentialed `REDIS_URL` for api/realtime |
| `REDIS_URL`                      | `apps/api/src/env.ts`, `apps/realtime/src/env.ts` (presence + mutation bus) — **assembled by compose** from `REDIS_PASSWORD`, not set by hand |
| `PORT` / `HOST`                  | set per-service by compose (api=4000, realtime=4001, 0.0.0.0) |
| `LIVEKIT_KEYS`                   | LiveKit server; assembled by compose from KEY/SECRET          |

**Not used by anything** (do not add): `JWT_SECRET`, `SESSION_SECRET`
(sessions are opaque SHA-256 tokens — no signing secret).

### Fail-fast secret checks (do not deploy with placeholders)

Two layers reject dev-default / placeholder secrets so a copied-but-unfilled
`.env.prod` can never reach production (security-review M5):

1. **`scripts/deploy.sh`** refuses to start if `DATABASE_URL`, `LIVEKIT_API_KEY`,
   `LIVEKIT_API_SECRET`, or `REDIS_PASSWORD` is empty or still a placeholder
   (`REPLACE_WITH_*`, `YOUR_DB_PASSWORD`, `devkey`, `devsecret`, …), or if
   `APP_ENV` is not `production`.
2. **The app itself** (`apps/api` / `apps/realtime` env schemas): with
   `APP_ENV=production`, the process throws at boot if a LiveKit key/secret is a
   dev default or `REPLACE_WITH_*`, if `DATABASE_URL` is the local dev default,
   or if `REDIS_URL` carries no credentials. This is why `APP_ENV=production`
   is required, not optional.
3. **`docker-compose.prod.yml` pins `APP_ENV: production`** on `api`, `realtime`
   and `migrate`, overriding `env_file`. Layer 2 is the real guard, but it only
   arms itself when `APP_ENV === "production"` — and until 2026-07-31 that value
   came *only* from the un-versioned `.env.prod`, so the guard depended on
   `deploy.sh` being the thing that started the stack. It is not the only thing
   that can: a hand-run `docker compose -f docker-compose.prod.yml up -d` during
   an incident, or by someone self-hosting from the now-public repo, skips
   layer 1 entirely and would boot the live stack in "development" — with the
   `devkey`/`devsecret` LiveKit credentials this repo publishes in
   `.env.example`, letting anyone mint a media token for any room. Pinning it in
   the compose file makes the guard a property of the file itself.
   Enforced by `pnpm lint:deploy`.

### Local dev compose is bound to loopback

`docker-compose.yml` (dev only) publishes every port as
`${DEV_BIND_ADDR:-127.0.0.1}:…`. The plain `"5432:5432"` form means **all
interfaces**, and Docker implements it with an iptables DNAT rule inserted ahead
of the INPUT chain — so `ufw`/`firewalld` does *not* block it. What that exposed:
Postgres on `postgres/postgres`, Redis with **no authentication at all**, and a
LiveKit whose `devkey`/`devsecret` are printed in `.env.example`.

This matters on the VPS too, not just on a laptop: that file sits in the
production checkout (`/opt/demli`) next to `docker-compose.prod.yml`, so a single
`docker compose up -d` **without** `-f docker-compose.prod.yml` starts the dev
stack on a box with real users.

To reach a dev service from another machine — a real handset talking to a local
LiveKit is the honest case — widen it deliberately, for that session only:

```bash
DEV_BIND_ADDR=0.0.0.0 docker compose up -d
```

The Android emulator does not need this; `10.0.2.2` already reaches the host's
loopback. Enforced by `pnpm lint:deploy`.

### Sessions (security-review M2)

Opaque session tokens now default to a **7-day** TTL (`SESSION_TTL_HOURS=168`,
down from 30 days) to shrink the blast radius of a leaked token. Clients can
revoke every active session for the account via `POST /auth/logout-all`
(authenticated) — used for "log out all devices" and suspected-compromise
recovery. A password-change endpoint does not exist yet; when it lands it should
also call `sessions.deleteAllForUser` (follow-up).

### Database (Supabase) — connection string caveats

- **Use the direct/session connection** (`db.<ref>.supabase.co:5432`), **not the
  transaction pooler** (`:6543`). The backend uses `postgres-js` with prepared
  statements, which the transaction pooler (pgBouncer transaction mode) does not
  support — runtime queries would error. One `DATABASE_URL` serves both the app
  and migrations.
- **Append `?sslmode=require`** — Supabase only accepts TLS.
- Migrations run as a one-shot `migrate` service (Drizzle migrator) before the
  app serves traffic. `deploy.sh` runs it and aborts the deploy if it fails.

### Desktop client origin (open item)

`CORS_ORIGIN` is set to an HTTPS origin. The packaged Electron renderer may send
a `null`/custom-scheme Origin rather than an HTTP origin. Confirm the production
Origin with the desktop-electron agent before first real deploy; `CORS_ORIGIN`
may need to include that value (or the API's CORS handling may need adjusting —
that is an app change, out of scope for this infra branch).

### Redis (password-protected — security-review M6)

Redis (persisted `redis-data` volume) backs realtime **presence** and the
**api↔realtime mutation fan-out bus**, and is consumed at runtime by both
`apps/api` and `apps/realtime` via `REDIS_URL`. It is internal-only (no host
port published) but still runs with `--requirepass ${REDIS_PASSWORD}`, so a
compromised neighbor/container (or a future accidental port publish) cannot
inject forged `message.*`/presence events onto the bus.

Set **`REDIS_PASSWORD`** once in `.env.prod` (e.g. `openssl rand -hex 32`).
Compose then (a) passes it to the Redis server via `--requirepass`, and
(b) assembles the credentialed `REDIS_URL=redis://:${REDIS_PASSWORD}@redis:6379`
that the api/realtime containers read — you never write `REDIS_URL` by hand.
LiveKit is single-node and does **not** need Redis, so it is intentionally not
wired to it.

## Desktop production build (CSP — security-review M4)

The renderer's Content-Security-Policy is injected at **build time** by the
`demli-csp` plugin in `apps/desktop/electron.vite.config.ts`; the HTML ships
a `%DEMLI_CSP%` placeholder so a packaged build can never accidentally carry
the permissive dev policy.

- **Dev** (`electron-vite dev`, `mode !== production`): `connect-src` allows the
  local dev servers (`ws://localhost:* http://localhost:*` + `127.0.0.1`).
- **Production build** (`electron-vite build`, `mode = production`): `connect-src`
  is pinned to `'self' https://api.<DOMAIN> wss://ws.<DOMAIN> wss://livekit.<DOMAIN>`
  — no wildcards, no plaintext `ws:`/`http:`. The build **fails** if
  `DEMLI_DOMAIN` is not set, so the locked CSP cannot be forgotten.

Inject the domain at build time:

```bash
DEMLI_DOMAIN=demli.example.com pnpm --filter @demli/desktop build
# verify the shipped policy:
grep -o "connect-src[^\"']*" apps/desktop/out/renderer/index.html
```

`DEMLI_DOMAIN` is the same domain as `DOMAIN` in `.env.prod` (the app builds
`api.`, `ws.`, and `livekit.` subdomains from it, matching the Caddy vhosts).

To build the actual **Windows installer** (NSIS + portable), run
`DEMLI_DOMAIN=<domain> pnpm --filter @demli/desktop package:win` — the same
one variable pins the CSP *and* the renderer's API/WS URLs. Full runbook,
Windows prerequisites (Developer Mode, MAX_PATH), code-signing, and auto-update
seam: [`desktop-packaging.md`](./desktop-packaging.md).

## Web client (`app.DOMAIN`) — SPA + PWA

The browser client (`apps/web`) is a static Vite SPA served by Caddy from a host
bind mount. It lets devices that can't install the native apps (the founder's
iPhone 6 / iOS 12) reach **Demli** in a browser. No new container: Caddy serves
files from `/srv/demli-app` (mounted read-only at `/srv/app`).

### Caddy + CSP

The `app.{$DOMAIN}` vhost does `root * /srv/app` + `try_files {path} /index.html`
(SPA fallback) + `file_server`, with content-hashed `/assets/*` cached
`immutable` and everything else `no-cache` (so a new deploy's `index.html` is
picked up immediately). Unlike the desktop renderer (which uses a build-time
`<meta>` CSP), the web CSP is a real **response header**:

- **`script-src 'self' 'unsafe-inline'`** — required, not lax. `@vitejs/plugin-legacy`
  injects **unhashed inline bootstrap scripts** (the module-support probe, the
  legacy-chunk loader, the Safari `nomodule` fix, and the inline `System.import(...)`
  entry). Without `'unsafe-inline'` the Safari 12 / iOS 12 path never boots —
  which is the web app's entire reason to exist. (Per-build script hashes are the
  stricter alternative but brittle; deferred.)
- **`style-src 'self' 'unsafe-inline'`** — injected inline styles.
- **`img-src` / `media-src` / `connect-src` include `https://*.supabase.co`** —
  attachments and avatars are fetched/uploaded **directly** client↔Supabase
  Storage via short-lived signed URLs ([ADR 0008](../decisions/0008-media-attachments.md));
  the API only signs, it does not proxy bytes. `connect-src` also pins
  `https://api.{$DOMAIN} wss://ws.{$DOMAIN} https://livekit.{$DOMAIN}
  wss://livekit.{$DOMAIN}`. **Optional hardening:** replace `https://*.supabase.co`
  with the exact `https://<project-ref>.supabase.co` for a tighter policy.
- Plus `default-src 'self'`, `object-src 'none'`, `base-uri 'self'`,
  `frame-ancestors 'none'`, `X-Content-Type-Options nosniff`, `X-Frame-Options
  DENY`, `Referrer-Policy strict-origin-when-cross-origin`, and a 1-year HSTS.

The build-time origins (`VITE_API_URL` / `_REALTIME_URL` / `_LIVEKIT_URL`) are
baked in by `publish-web.sh` from `DEMLI_DOMAIN`, so they always match the CSP
`connect-src` (both derive from the same domain).

### Publishing

`scripts/publish-web.sh` mirrors `publish-desktop.sh` (same `.env.deploy`
credentials + plink/pscp | sshpass | ssh-key auto-detect). It builds
`@demli/web`, then uploads the whole `dist/` tree **in place** into
`/srv/demli-app` (Docker bind mounts track the directory inode, so a mv-swap
would not update what Caddy serves; old hashed `/assets/*` are left behind so
in-flight clients holding the previous `index.html` can still fetch their
chunks). It finishes with a `curl` health check of `https://app.DOMAIN`.

```bash
bash scripts/publish-web.sh                # build + upload + verify (DOMAIN defaults to getdemli.com)
SKIP_BUILD=1 bash scripts/publish-web.sh   # reuse an existing dist
```

### PWA ("add to home screen")

`apps/web/public/` holds `site.webmanifest` (name "Demli", `standalone`,
theme/background `#F55416`) plus icons derived from the single brand source
`assets/brand/logo.png` via `pnpm gen:icons` (`scripts/gen-icons.mjs` web
section): `icon-192.png` / `icon-512.png` (purpose `any`),
`maskable-icon-192.png` / `maskable-icon-512.png` (Android adaptive — opaque,
mark inside the 72/108 safe area), `apple-touch-icon.png` (180, opaque — iOS 12
uses this, not the manifest), `favicon.svg`, `favicon-*.png` and `favicon.ico`.
Sizes and safe areas are declared in `assets/brand/brand-manifest.json` and
enforced by `pnpm test:brand` (also part of `pnpm lint`). `index.html` links the
manifest + apple-touch-icon and sets the `apple-mobile-web-app-*` metas
(`status-bar-style=black`, since the UI has no safe-area padding yet). No
service worker in P0 (fragile on iOS 12, no web push).

> Caddy's `@manifest path /manifest.webmanifest` matcher is stale — the served
> manifest is `/site.webmanifest`, so it never gets the
> `application/manifest+json` Content-Type. Needs a Caddyfile fix.

### Director's deploy steps (first web release)

Prereqs: the production stack (§first-deploy runbook) is already live and
`.env.deploy` holds `DEPLOY_HOST`/`DEPLOY_PASS`.

1. **DNS** — an A record `app.DOMAIN` → the VPS IP (same IP as the other hosts).
   Verify: `dig +short app.DOMAIN`.
2. **Host dir** (once, on the VPS): `sudo install -d -o 1000 -g 1000 /srv/demli-app`.
3. **Refresh Caddy** so it loads the vhost + obtains its TLS cert. Pull
   `origin/dev` on the VPS and re-run the server deploy —
   `bash scripts/deploy-remote.sh` — or, on the VPS,
   `docker compose --env-file .env.prod -f docker-compose.prod.yml up -d caddy`.
   (A new bind mount means the caddy container must be recreated, not just
   reloaded.)
4. **Publish the web build**: `bash scripts/publish-web.sh`.
5. **Verify**: `curl -fsS -I https://app.DOMAIN` → `200`; open on a phone and
   test "add to home screen".

Re-deploys of JS/UI changes are just step 4 again.

## The domain (`getdemli.com`)

Everything the product exposes lives under one domain. `DOMAIN=getdemli.com` in
`.env.prod` drives every Caddy vhost, and `deploy.sh` derives `TURN_DOMAIN` from
it.

| What | Where |
| ---- | ----- |
| Landing site | `getdemli.com` (+ `www.` → 301 to apex) |
| Web app + mobile deep links | `app.getdemli.com` |
| API + `/dl/` release feed | `api.getdemli.com` |
| Realtime WS | `ws.getdemli.com` |
| LiveKit signaling | `livekit.getdemli.com` |
| TURN | `turn.getdemli.com` — no vhost, see below |

### History: the single-domain cutover (2026-07-27)

The backend used to live on an older domain, with `getdemli.com` bolted on as an
**alias** so that already-installed clients — which have their API / WS / LiveKit
origins and their electron-updater feed compiled in at build time — would keep
working. That legacy domain was then retired: its DNS records were deleted,
explicitly accepting that everyone reinstalls.

That collapsed the alias into the original, and the alias machinery had to go
rather than be repointed:

- **A duplicate site address is fatal.** Caddy refuses to load a config that
  defines the same site twice, so pointing both `{$DOMAIN}` and a second brand
  placeholder at `getdemli.com` would have taken the whole stack down at the next
  deploy. `BRAND_DOMAIN` is therefore removed from the Caddyfile, from
  `docker-compose.prod.yml`, from `deploy.sh` and from `.env.prod.example`.
- **Old artifacts are dead, on purpose.** Any installer or APK built before the
  cutover points at the retired domain and cannot reach the backend at all.
  There is no fallback and no migration path — the user downloads the current
  build. Handing someone an installer that cannot connect is worse than a 404.

`scripts/check-caddyfile.mjs` now fails the build on a duplicate site address, on
any site address that is not built from `{$DOMAIN}`, and on any occurrence of the
retired legacy domain in a live directive.

If a second public domain is ever wanted, add it as an **extra address on the
same site block** (`api.{$DOMAIN}, api.example.org { … }`) — never as a second
block.

### TURN has no vhost

`turn.getdemli.com` needs an A record but no Caddy site block:

- LiveKit's built-in TURN takes a **single** `domain` (`deploy/livekit.yaml`,
  rendered from `TURN_DOMAIN`). There is no list.
- That value is both the TURN host LiveKit advertises to clients **and** the
  long-term-credential **auth realm**. A realm mismatch breaks relay candidates
  for exactly the users who depend on them (restrictive NATs, mobile carriers) —
  the failure hardest to notice from a desk, on the feature with the highest
  quality bar in this project.
- TURN traffic is UDP/3478 published straight off the host by the `livekit`
  service. It never passes through Caddy, so a vhost would achieve nothing.

Changing it is a one-line `.env.prod` edit + `deploy.sh`, effective at the next
join, with **no client rebuild** — but the DNS record must exist first.

### DNS records

All pointing at the **same VPS IPv4**:

| Type | Name (host) | Value        | TTL  | Caddy vhost |
| ---- | ----------- | ------------ | ---- | ----------- |
| A    | `@`         | `<VPS IPv4>` | 3600 | yes (landing) |
| A    | `www`       | `<VPS IPv4>` | 3600 | yes (301) |
| A    | `app`       | `<VPS IPv4>` | 3600 | yes (web app) |
| A    | `api`       | `<VPS IPv4>` | 3600 | yes |
| A    | `ws`        | `<VPS IPv4>` | 3600 | yes |
| A    | `livekit`   | `<VPS IPv4>` | 3600 | yes |
| A    | `turn`      | `<VPS IPv4>` | 3600 | **no** — UDP off the host |

Notes:

- If the registrar rejects `@`, use the blank name or `getdemli.com` — whatever it
  calls the apex. A `CNAME` at the apex is not portable; use `A`.
- `www` as a `CNAME` to `getdemli.com` also works if preferred.
- No `AAAA` records: the stack does not advertise IPv6.
- **Do not add a record without adding the vhost, or a vhost without the record.**
  A vhost for a name that does not resolve makes Caddy retry its certificate
  forever and buries real errors in ACME noise; that is why the host list is
  asserted by `pnpm lint:caddy`.
- Verify before deploying — all must return the VPS IP:
  `dig +short getdemli.com www.getdemli.com app.getdemli.com api.getdemli.com ws.getdemli.com livekit.getdemli.com turn.getdemli.com`

### TLS

Verified with `caddy adapt`: every hostname lands in **one** `tls.automation`
policy with a **flat `subjects` list**, and CertMagic obtains and renews **one
certificate per subject**. Subjects are independent — a host whose A record is
missing fails its own ACME HTTP-01 challenge, is logged, and is retried with
exponential backoff, while the already-issued certificates keep serving.

- **Deploying before DNS is safe.** A host without a record simply does not
  answer until the record exists.
- **Rate limits are not a concern at this size.** Let's Encrypt allows 50
  certificates per registered domain per week; this stack uses 6. Failed-validation
  limits (5/hour per host) are not reached because Caddy backs off exponentially.
  Caddy also has ZeroSSL as a fallback issuer.
- **The one thing that hurts** is deleting or repointing an A record for a live
  host — that breaks its renewal. (Which is exactly what was done, deliberately,
  to the retired legacy domain.)

### Validating the Caddyfile

Neither Caddy nor Docker is required on a workstation to check the config:

```bash
# with the caddy binary (or: docker run --rm -v "$PWD:/w" -w /w caddy:2-alpine ...)
DOMAIN=getdemli.com ACME_EMAIL=you@example.com \
  caddy validate --config Caddyfile --adapter caddyfile

# structural checks (no Caddy needed; also run by `pnpm lint` / `pnpm lint:caddy`)
node scripts/check-caddyfile.mjs
```

The structural check fails on: unbalanced braces, a **duplicate site address**, a
site address not built from `{$DOMAIN}`, a host outside the expected set, a
`turn.*` vhost, a retired-legacy-domain reference in a live directive, a web CSP that
stops covering the backend or gains an over-broad source, and a `/download/windows`
redirect that no longer matches the installer name `electron-builder.yml`
produces.

### Shipping a Caddy change (the silent-stale trap)

**Production incident, 2026-07-27.** The `getdemli.com` vhosts were deployed,
`deploy-remote.sh` reported success and `/health` answered — and Caddy went on
serving the config it had parsed twenty minutes earlier. The new vhosts were
never loaded; the logs did not even show a certificate attempt for the new
names. `docker compose … exec caddy caddy reload` did not fix it either. Only
`docker compose … up -d --force-recreate caddy` did.

Two independent causes, both silent:

1. **`docker compose up -d` compares the service *definition*, not file
   contents.** Image, command, env, mount *declarations*, labels. Editing the
   Caddyfile changes none of them, so compose prints "Running" and does nothing.
2. **A single-file bind mount binds the *inode*, not the path.** `git reset
   --hard` — exactly how `deploy-remote.sh` updates `/opt/demli` — does not
   edit in place; it writes a replacement file on a *new* inode. The container's
   mount still resolves to the old one, so `/etc/caddy/Caddyfile` *inside the
   container* keeps showing the old text indefinitely.

Cause 2 is why reload was useless: **`caddy reload` re-reads the same stale
inode and reports success having re-applied the old config.** (Run without
`--config` it is worse still — the image's WORKDIR is `/srv`, there is no
`/srv/Caddyfile`, and it just errors.) Recreating the container is the only
thing that re-resolves the path to the current inode.

`scripts/deploy.sh` now handles this on every deploy, and — because a silent
success is what made this expensive — it *proves* the outcome rather than
assuming it:

- compares `sha256(./Caddyfile)` with `sha256(/etc/caddy/Caddyfile)` read from
  inside the running container. Because of the inode behaviour above, the
  in-container file is byte-for-byte what the running process parsed at startup,
  which makes this an exact staleness oracle;
- on a mismatch: `caddy validate` in a throwaway container built from the same
  service definition (fresh mount → current file), so a broken config never
  reaches the live proxy, then `up -d --no-deps --force-recreate caddy`
  (`--no-deps` keeps the recreate from cascading to api/realtime/livekit);
- then verifies, **on every deploy including no-op ones**: the hashes now match;
  every site address in the Caddyfile is present in the config the running
  process reports at its admin API (`127.0.0.1:2019/config/`); and
  `https://api.<DOMAIN>/health` answers through the public edge (DNS + TLS +
  proxy — the container health check proves none of those). Any of the three
  failing fails the deploy. `DEPLOY_SKIP_EDGE_CHECK=1` skips only the last one.

Keep the mount a **file**, not a directory. A directory mount would let content
changes through (and make `caddy reload` honest), but it would also destroy the
staleness oracle above — the in-container file would always match while the
running process kept the old config. Swapping to one means replacing the
detection mechanism too.

### Download links (version-independent)

The landing page and the in-app "get the other platform" prompt link at stable
paths on the apex, which Caddy redirects into the release feed:

| Path | Redirects to | Freshness mechanism |
| ---- | ------------ | ------------------- |
| `/download/windows` | `https://api.DOMAIN/dl/desktop/Demli-Setup.exe` (302) | a **relative symlink** next to the versioned installer, re-pointed by `publish-desktop.sh` after every upload and re-derived by `deploy.sh` on every server deploy (`ls Demli-Setup-*.exe \| sort -V \| tail -1`) |
| `/download/android` | `https://api.DOMAIN/dl/mobile/demli.apk` (302) | a fixed filename — the same URL the in-app self-updater uses (`MOBILE_APK_URL`), written by `publish-mobile-apk.sh` or the EAS build webhook |
| `/download/macos` | `https://api.DOMAIN/dl/desktop/Demli-macos.dmg` (302) | same symlink mechanism, arm64 preferred over x64. **The target does not exist until the first macOS release is published** — see below |
| `/download/ios` | — | honest **404**. No App Store listing exists; see "iOS" |

electron-updater is unaffected by these aliases: it resolves the **versioned**
filenames out of `latest.yml` / `latest-mac.yml`. The aliases exist only for
humans clicking a link.

The alias filenames come from `productName` in `apps/desktop/electron-builder.yml`.
They appear in three files that must change together — the Caddyfile redirect,
`publish-desktop.sh` and `deploy.sh` — so `pnpm lint:caddy` asserts all three
against the actual electron-builder config.

The Android name has the same problem in four places, and `pnpm lint:caddy`
(rule `apk-alias`) asserts them too:

| File | What names the APK |
| ---- | ------------------ |
| `Caddyfile` | the `/download/android` redirect target |
| `apps/api/src/env.ts` | the `MOBILE_APK_URL` default (advertised by `GET /mobile/version`) |
| `docker-compose.prod.yml` | the pinned production `MOBILE_APK_URL` |
| `apps/api/src/modules/hooks/download.ts` | `FINAL_NAME` — what the EAS webhook writes |
| `scripts/publish-mobile-apk.sh` | `REMOTE_NAME` — what the manual/local-build path uploads |

### macOS

The pipeline exists and is wired to this feed; **no artifact has been published
yet**, and until one is, the landing page must not show a macOS download button
(CLAUDE.md §35 — never link an artifact that does not exist). The `/download/macos`
redirect and the `Demli-macos.dmg` alias are already in place, so publishing is
the only remaining step; nothing needs reconfiguring afterwards.

Producing a build (macOS binaries cannot be cross-built from Windows):

```bash
bash scripts/build-desktop-mac.sh      # dispatch the workflow, wait, unpack artifacts
bash scripts/publish-desktop.sh --mac  # upload + refresh the Demli-macos.dmg alias
```

`scripts/build-desktop-mac.sh` drives `.github/workflows/desktop-mac.yml`, which
runs the same `apps/desktop/scripts/package.mjs` on a `macos-latest` runner and
uploads `*.dmg`, `*.zip`, `*.blockmap` and `latest-mac.yml`. It needs
`GITHUB_TOKEN` in `.env.deploy` (fine-grained PAT, "Actions: read and write").

Two things gate the first run:

- **The workflow must exist on the repository's default branch.** GitHub only
  offers `workflow_dispatch` for workflows present there, whatever ref you
  dispatch. If dispatch answers 404, that is why.
- **Cost.** GitHub-hosted macOS runners are free on public repositories and
  billed at **10x** minutes on private ones. A founder decision while the repo is
  private.

Builds are **unsigned** (signing needs a $99/year Apple Developer membership), so
Gatekeeper warns on first open and users must right-click → Open once. Signing is
a single switch — `DEMLI_MAC_IDENTITY` + `CSC_LINK` — with no file edits; see
`docs/architecture/desktop-packaging.md` → "macOS".

### Android — the native APK release (local build, no EAS quota)

OTA (`eas update`) delivers JS only. Anything native — a new module, the app
**name**, the **launcher icon**, `runtimeVersion` — needs a fresh APK. EAS free-tier
build minutes run out, so the primary path is a **local** build; EAS remains a
fallback when quota is available.

```bash
# 0. once per machine: signing credentials (see below) in .env.mobile-signing
pnpm package:android                    # = bash scripts/build-mobile-apk.sh
bash scripts/publish-mobile-apk.sh apps/mobile/android/app/build/outputs/apk/release/app-release.apk
bash scripts/deploy-remote.sh           # LAST — see the ordering rule below
```

`scripts/build-mobile-apk.sh` runs `expo prebuild --clean` (this is where
`app.json`'s `name` becomes `strings.xml/app_name` and `assets/*.png` become the
mipmaps), then `gradlew assembleRelease` with the real signing key injected, then
verifies the resulting signature is not the debug one.

**Signing is the whole game.** Android installs an update only when the new APK
carries the **same signature** as the installed one. The Expo android template
signs `release` with the checked-in **debug** keystore — that build installs fine
on a clean phone and only reveals itself at the *next* release, when every
existing user's in-app update fails and anyone who installed the mis-signed
build is stranded forever. So:

- the keystore is the EAS-managed one (its filename is `@<eas-account>__<slug>.jks`),
  retrieved via `npx eas-cli credentials --platform android` → *Download existing keystore*
  (EAS prints the store password, key alias and key password);
- keystore and passwords live **outside git** — `*.jks` and `.env.mobile-signing`
  are gitignored, and losing the key means no installed app can ever be updated
  again, so it needs a backup outside the repo;
- the build script refuses to run without those credentials rather than falling
  back to the debug key.

**Version bumps, in lockstep.** A native release changes four numbers; three are
in `apps/mobile/app.json` and one is in `docker-compose.prod.yml`:

| Field | Why |
| ----- | --- |
| `expo.version` | user-visible in Settings ("1.7.0 (1.7.0)") and the Android `versionName` |
| `expo.runtimeVersion` | the OTA compatibility key; bumping it is what makes older installs ask for a new APK |
| `expo.android.versionCode` | must strictly increase or Android refuses the upgrade |
| `MOBILE_LATEST_RUNTIME` | what `GET /mobile/version` advertises — the value old installs compare against |

**Ordering is not optional: publish the APK BEFORE deploying the server.**
`MOBILE_LATEST_RUNTIME` is pinned in `docker-compose.prod.yml`, so a deploy
immediately advertises the new runtime. Deploy first and every installed app is
told to update, downloads the *old* file still sitting at the link, finds itself
still out of date, and is re-prompted on every launch — a loop only a new publish
can end.

Local builds still receive OTA: `app.config.js` pins the `expo-channel-name:
preview` request header, which EAS builds get from the build profile and a gradle
build would otherwise lack.

### iOS

**Not shippable today.** Distributing an iOS build — even to testers via
TestFlight — requires a paid **Apple Developer Program** membership ($99/year) and
an App Store Connect record. There is no sideload path comparable to the Android
APK. So `/download/ios` answers an honest 404 and the landing page / in-app
platform prompt must show iOS as unavailable **without a link** (plain text, e.g.
"iOS: App Store'da yakında"), never a dead or placeholder URL.

If the founder buys the membership, the sequence is:

1. Enrol in the Apple Developer Program; create the app record in App Store
   Connect for bundle id `app.demli.mobile` (already set in
   `apps/mobile/app.json`).
2. Add the Apple credentials to EAS and build:
   `npx eas-cli build --profile preview --platform ios`.
3. Distribute through TestFlight first. The in-app APK self-updater is
   Android-only and must stay that way — Apple forbids self-updating binaries;
   iOS updates come from the App Store, and JS-only changes still ride EAS OTA.
4. Universal Links: upload an `apple-app-site-association` file (no extension,
   `application/json`) to `/srv/dl/link/`. The Caddy handler on `app.DOMAIN`
   already serves that exact path, so nothing else changes. `associatedDomains`
   in `app.json` is already `applinks:app.getdemli.com`.

### Mobile deep links

Invite and friend links are `https://app.getdemli.com/kat/<code>` and
`/arkadas/<code>`. They moved off the retired legacy host with the cutover, onto
the one public host that both resolves and is semantically "the app".

- Android App Links verification is served at
  `https://app.getdemli.com/.well-known/assetlinks.json`, from
  `/srv/dl/link/assetlinks.json` on the VPS. The file lists the app's
  `package_name` and signing-cert SHA-256 and is **host-independent**, so moving
  the host did not require regenerating it.
- On a device where the app is installed and verified, Android/iOS intercept the
  URL before the browser. Everyone else falls through to the web app's SPA
  fallback, which is a better landing than the old static "download the app" page.
- The host appears in three places that must agree:
  `apps/mobile/src/lib/deep-links.ts` (`DEEP_LINK_HOST`), the `intentFilters` +
  `associatedDomains` in `apps/mobile/app.json`, and the Caddy handler. Changing
  it requires a **native** mobile build — OTA cannot alter `AndroidManifest.xml`.

### CORS

The web app on `app.getdemli.com` calls the API cross-origin. CORS keys off the
**browser page origin**, so the API host is irrelevant here. The allowlist lives
in `FIRST_PARTY_WEB_ORIGINS` (`apps/api/src/env.ts`) and is **merged on top of**
whatever `CORS_ORIGIN` holds, so the public hosts never depend on a hand-edited
`.env.prod` (same rationale as `MOBILE_APK_URL`). It only ever widens the
allowlist. The realtime gateway needs no change — it does no origin check
(`new WebSocketServer({ port, host })`, no `verifyClient`); its boundary is the
session token, and browsers do not apply CORS to WebSocket handshakes.

### Deploy order

1. **DNS first** — the records in the table above; confirm with `dig`. (Deploying
   first also works; hosts without records just fail TLS until DNS lands.)
2. **Server** — `bash scripts/deploy-remote.sh`. Ships the Caddy vhosts, the
   `/srv/demli-landing` bind mount, and refreshes the stable download symlinks.
   The caddy container is **recreated, never reloaded**, whenever the Caddyfile's
   *contents* change — and the deploy then proves the live proxy is serving them.
   See "Shipping a Caddy change (the silent-stale trap)" above for why neither
   `up -d` on its own nor `caddy reload` is enough.
3. **Verify.** `deploy.sh` prints these at the end:

   ```bash
   curl -fsS -I https://getdemli.com                            # 200 — landing
   curl -fsS -I https://app.getdemli.com                        # 200 — web app
   curl -fsS    https://api.getdemli.com/health                 # ok
   curl -fsS -o /dev/null -w '%{http_code}\n' \
        https://api.getdemli.com/dl/desktop/latest.yml          # 200 — the update feed
   ```

4. **Landing** — `bash scripts/publish-landing.sh` (builds `apps/landing`, uploads
   to `/srv/demli-landing`, verifies the apex + the download redirects).
5. **Web app** — `bash scripts/publish-web.sh` for actual app changes.
6. **Desktop** — bump `apps/desktop/package.json`, then
   `DEMLI_DOMAIN=getdemli.com pnpm --filter @demli/desktop package:win` and
   `bash scripts/publish-desktop.sh`.
7. **Mobile (native APK)** — the exception to this order: `pnpm package:android`
   and `bash scripts/publish-mobile-apk.sh …` must run **before** step 2, because
   the deploy is what advertises the new `runtimeVersion` to installed apps. See
   "Android — the native APK release" above.

### Line endings: `scripts/deploy.sh` must be LF

`scripts/deploy.sh` was committed with **CRLF** (fixed 2026-07-31). Git Bash on
Windows tolerates the stray carriage returns, so it looked fine everywhere it was
edited. On the VPS — Linux, `core.autocrlf` unset — it is fatal:

```
scripts/deploy.sh: line 27: $'\r': command not found
scripts/deploy.sh: line 28: set: pipefail: invalid option name
```

The second line is the dangerous one: `set -euo pipefail` **fails**, so the rest
of the deploy runs with `errexit` and `pipefail` **off** and every guard in the
script becomes advisory. `deploy-remote.sh` `git reset --hard`s the checkout on
every deploy, so a CRLF commit reaches production the moment it is pushed.

`.gitattributes` now pins `eol=lf` for `scripts/**`, `Caddyfile`,
`docker-compose*.yml` and `deploy/**` (deliberately narrow — a repo-wide
`text=auto` would renormalise ~76 files across `apps/` and `packages/`), and
`pnpm lint:deploy` fails on any CR that slips through anyway.

## SSH credentials (host-key pinning, and why the password is not in argv)

Every script that touches the VPS — `deploy-remote.sh`, `publish-desktop.sh`,
`publish-web.sh`, `publish-landing.sh`, `publish-mobile-apk.sh`,
`add-assetlinks-package.sh` — goes through one helper, **`scripts/lib/remote-ssh.sh`**.
Nothing may hand-roll the auth block: six copies drifted, and the drift was two
holes at once (security-review 2026-07-31, both HIGH).

**`DEPLOY_HOSTKEY` is enforced on every path, not just PuTTY's.** It was always
required and always passed to `plink -hostkey`, but the OpenSSH/`sshpass` branch
threw it away and used `-o StrictHostKeyChecking=accept-new` — which trusts
whatever answers the *first* connection. A deploy run from WSL (no plink) would
therefore hand the **root password** and `git reset --hard && bash scripts/deploy.sh`
to the first host to reply. One bad DNS or ARP answer, full VPS takeover.

The helper closes it the way plink does: `ssh-keyscan` fetches the offered keys,
each is fingerprinted with `ssh-keygen -lf`, and **only** keys matching the pinned
`DEPLOY_HOSTKEY` are written to a throwaway `known_hosts` used with
`StrictHostKeyChecking=yes`. A mismatch aborts before any credential is sent:

```
[remote-ssh] ERROR: HOST KEY MISMATCH for <host>:22
  Pinned  (DEPLOY_HOSTKEY): SHA256:…
  Offered by the host:      SHA256:…
```

Read the pin once, out of band, and put it in the gitignored `.env.deploy`:

```bash
ssh-keyscan -t ed25519 <host> | ssh-keygen -lf -   # -> SHA256:…
```

Accepted forms: `SHA256:…`, PuTTY's `ssh-ed25519 255 SHA256:…` line, or an
MD5 colon-hex fingerprint from older PuTTY. If the VPS is genuinely re-keyed
(rebuild, provider migration), verify the new key on the provider console and
update `.env.deploy` — never work around the error by disabling the check.
`DEPLOY_KNOWN_HOSTS=/path/to/known_hosts` bypasses the keyscan when you manage
the key yourself.

**The password stays out of `ps`.** `sshpass -p "$PASS"` and `plink -pw "$PASS"`
put the root password in argv, readable via `ps`, `/proc/<pid>/cmdline` and Task
Manager by any local process. All OpenSSH paths now use `SSHPASS=… sshpass -e`;
PuTTY uses `-pwfile` (a 0600 temp file, wiped on exit) when available.

> **Known gap — PuTTY older than 0.77 has no `-pwfile`.** The helper falls back
> to `-pw` and prints a warning; there is no other way to feed plink a password
> non-interactively. Upgrade PuTTY, or remove the problem entirely.

**The permanent fix is an ed25519 deploy key** — then no password exists to leak
and the fallback above is unreachable:

```bash
ssh-keygen -t ed25519 -C demli-deploy -f ~/.ssh/demli_deploy
ssh-copy-id -i ~/.ssh/demli_deploy.pub root@<vps>
# then drop DEPLOY_PASS from .env.deploy; every script's key/agent branch takes over
```

Verify with `bash scripts/test-remote-ssh.sh` (also under `pnpm test:deploy`),
which generates two real keys and asserts the impostor is refused.

## Database backups

The production database is Supabase-managed, on a plan with **no automatic
backups and no PITR**, and `deploy.sh` applies generated migrations to it
unattended on every deploy. Until 2026-07-31 there was no dump of it anywhere —
one generated `DROP COLUMN` and the data of real users would have been gone.

Two scripts, one rule: **an untested backup is not a backup.**

```bash
bash scripts/backup-db.sh                 # take one (cron + ad-hoc)
bash scripts/backup-db.sh --label predeploy   # what deploy.sh runs, automatically
bash scripts/restore-db-verify.sh         # PROVE the newest one restores
bash scripts/restore-db-verify.sh /srv/demli-backups/demli-….sql.gz
```

### What is taken, and what is not

| | |
|---|---|
| Format | plain SQL, gzipped (`psql` is the only tool a restore needs) |
| Schemas | `public` **and** `drizzle` |
| Where | `/srv/demli-backups`, mode 600 (`BACKUP_DIR` to change) |
| Retention | 14 daily; the 1st-of-month dump kept 180 days |
| Client | `pg_dump` from a pinned `postgres:17-alpine` container |

`drizzle` is not optional. `drizzle.__drizzle_migrations` is the migration
ledger; a `public`-only dump restores perfectly and then the next deploy replays
every migration from `0000` against the restored data — the recovery becomes the
second outage.

The dump contains **no `DROP` statements** (no `--clean`), deliberately: the
artifact must not be able to destroy a live database if it is ever applied to the
wrong target during an incident. It is also `--no-owner --no-privileges`, because
Supabase's roles do not exist in a recovery target; platform grants are re-applied
by the platform when you restore into a fresh project.

**NOT in the backup — the gap that loses media even when the database is safe:**

- **Supabase Storage buckets** — `attachments` (message media) and `avatars`
  (profile photos *and* banners). The database stores only paths/URLs, so a
  restore gives you rows pointing at files that no longer exist. Copying bucket
  contents is a separate job (Supabase CLI / S3-compatible sync) and is **not
  automated yet**.
- Supabase's own `auth`/`storage`/`extensions` schemas — the platform's, not ours.
- Redis (presence, fan-out) — derived state, intentionally not backed up.
- The VPS itself (Caddy certs, `/srv/demli-dl`) — rebuildable by a deploy.

Both scripts print this list on every run so nobody infers a wider promise than
the file makes.

### Where the copies live (and the honest limit)

The database is at Supabase; the dumps are on the VPS. Two providers, so no single
failure takes both — that is the good property. The limit is the other direction:
**losing the VPS disk loses the backup history** (the live database is untouched).
Set `BACKUP_MIRROR_DIR` to drop each dump on a second destination, and pull one
off-box periodically if the data matters more than the convenience.

`/srv/demli-backups` is outside the git checkout (`deploy-remote.sh` does
`git reset --hard` on `/opt/demli`) and outside every host tree bind-mounted into
Caddy — a dump under `/srv/demli-dl` would be a public download of every user's
messages and password hashes. `pnpm lint:deploy` fails if those ever overlap.

### The daily job

Not installed automatically — cron is the operator's, not a deploy's, to write:

```bash
(crontab -l 2>/dev/null; echo '17 3 * * * cd /opt/demli && bash scripts/backup-db.sh >> /var/log/demli-backup.log 2>&1') | crontab -
```

`deploy.sh` does not take that on trust: it looks for a dump that **no deploy
wrote** from the last two days and warns when there is none. A cron entry that
exists proves nothing; a recent file does.

### Restoring (the procedure that is actually tested)

Restore into a **new, empty** database — never over a live one:

```bash
createdb demli_recovered                                  # or a fresh Supabase project
psql -d demli_recovered -c 'DROP SCHEMA IF EXISTS public CASCADE'
gzip -cd demli-2026-07-31T031700Z.sql.gz | psql -v ON_ERROR_STOP=1 --single-transaction -d demli_recovered
```

The `DROP SCHEMA` line is load-bearing and was found by running this for real: a
schema-scoped dump emits `CREATE SCHEMA public;`, every fresh database already has
one, and with `ON_ERROR_STOP` the whole restore rolls back — leaving an empty
database and a dump that had passed every integrity check. `--single-transaction`
is what makes that failure honest: a restore either completes or leaves nothing.

`scripts/restore-db-verify.sh` runs exactly those steps in a throwaway container
(`--network none`, so it can reach nothing) and then compares the result with the
dump table by table: same tables, same row counts, migration ledger present,
foreign keys and indexes back. It exits non-zero if any of that is untrue. It has
no "restore into this URL" option on purpose — production can never be its target.

Run it after any change to the backup path, and periodically on a real dump.

## Deploy safety (`scripts/deploy.sh`)

The order inside the deploy is load-bearing, so it is documented rather than
re-derived at 3am:

| # | Step | If it fails |
|---|---|---|
| 1 | preflight: env file, DNS; render + **prove** `deploy/livekit.runtime.yaml` (no placeholder left, webhook key = `LIVEKIT_API_KEY`, secret absent) | nothing touched yet |
| 2 | build images | the running stack keeps serving |
| 3 | `scripts/backup-db.sh --label predeploy` — the pre-migration dump | **stops here**; an irreversible migration never runs without a recovery point |
| 4 | `compose run --rm migrate` — schema migrations | **stops here**; the new code never serves against an old schema |
| 5 | `compose up -d --remove-orphans` | — |
| 6 | API health | deploy fails loudly |
| 7 | LiveKit: recreate **only if** the running SFU's config differs from the render; prove the SFU reaches the join-check webhook | a config that does not boot is rolled back to the old one and the deploy fails; an unreachable webhook fails the deploy |
| 8 | Caddy config proof, real `https://api.…/health` | deploy fails loudly |
| 9 | release-feed proof: every published artifact answers 200 through the public edge | deploy fails |

**Step 3 is the only step whose failure cannot be undone by re-running the
deploy.** `git reset && redeploy` restores code; it does not un-drop a column. So
the dump is taken immediately before the schema is touched, and a failed backup
aborts. Overriding is possible but must be deliberate and per-run:
`DEPLOY_SKIP_BACKUP=1 bash scripts/deploy.sh` — it says in the log exactly what
was given up. See "Database backups" above.

**The feed must be served, not merely present.** Step 6 requests the desktop
manifest, `Demli-Setup.exe` and the advertised APK over
`https://api.<DOMAIN>/dl/…`. A file that exists on disk but does not answer 200 is
always a routing/mount fault — and warning about it is how it once got missed,
with the mobile self-updater stuck in the endless update loop of CLAUDE.md §32.

Every one of these behaviours is tested against a fake Docker in
`scripts/test-deploy-migration.sh` (`pnpm test:deploy`).

### The LiveKit join-check webhook (step 7)

A LiveKit token cannot be revoked. A member who is kicked, banned or timed out is
force-removed at that moment, but the token they hold still verifies for up to ten
minutes and a modified client can connect again with it — no request reaches the
token endpoints. The SFU sees that join, so `deploy/livekit.yaml` has it report
every join:

```yaml
webhook:
  api_key: "${LIVEKIT_API_KEY}"        # rendered by deploy.sh; the SECRET stays in LIVEKIT_KEYS
  urls:
    - http://api:4000/hooks/livekit    # internal compose network, never the public edge
```

On `participant_joined` the API (`apps/api/src/modules/livekit-webhook`) re-runs
the token endpoints' authorization against the database as it is now and removes
anyone who fails it. It fails OPEN on its own errors (a DB hiccup never removes a
legitimate participant) and ignores rooms/identities that are not ours.

Three things about this block are not obvious and each has bitten or would bite:

- **A wrong `api_key` takes voice down, not just the check.** If it names no key in
  `LIVEKIT_KEYS`, LiveKit refuses to start (`api_key is required to use webhooks`,
  verified on 1.9.12). deploy.sh therefore proves the rendered value in step 1,
  before anything is touched, and `pnpm lint:deploy` proves that every placeholder
  in the template is in deploy.sh's (single-quoted) envsubst list.
- **A new LiveKit config never reached the running SFU on its own.** LiveKit reads
  its config once, and compose recreates a container only when its *definition*
  changes — a new `livekit.runtime.yaml` is not that. deploy.sh now moves the
  render into place as a new inode, so the single-file bind mount keeps showing the
  container the file it booted with; equal hashes mean nothing to do, different
  hashes mean `up -d --no-deps --force-recreate livekit` (after the API is healthy)
  and a wait until the container serves the new hash. If it does not boot, the
  config the old container was running is restored and recreated, and the deploy
  fails. (This also means LiveKit config changes made before this — e.g. the
  active-speaker tuning — only took effect if the container restarted for some
  other reason.)
- **Recreating LiveKit interrupts every active call.** livekit-client reconnects
  on its own with the token it holds — measured on 1.9.12 with raw clients: an
  abrupt SFU restart with 1.8 s downtime, both peers back after ~5 s. Docker's
  SIGTERM grace period and the apps' own voice state machine come on top and were
  **not** measured. It only happens when the config actually changed; ship such a
  change when nobody is in a call. To defer it, run
  `DEPLOY_SKIP_LIVEKIT_RECREATE=1 bash scripts/deploy.sh`; the log then says the
  new config (and the join check) is **not** in effect.

The last proof is an unsigned POST from inside the livekit container to
`http://api:4000/hooks/livekit`: it must come back **401** from the handler, which
proves name resolution, the network path and the route at once without being able
to trigger anything. Anything else fails the deploy.

**Verify after the first deploy that carries it:**

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml logs livekit | grep 'sent webhook' | tail -3
docker compose --env-file .env.prod -f docker-compose.prod.yml logs api | grep -c '/hooks/livekit'
```

A `401` on `/hooks/livekit` in the api log means the SFU signs with a different
key than the API verifies with — the check is off.

## App Links (`assetlinks.json`)

The Android package must be listed in the live verification file served at
`https://app.<DOMAIN>/.well-known/assetlinks.json`, or a shared `/kat/` link opens
the browser instead of the app:

```bash
bash scripts/add-assetlinks-package.sh          # defaults to app.demli.mobile
```

It reads the live file, appends the statement, writes it back with a timestamped
backup, and verifies the served result. Idempotent. The file is not in git on
purpose — it is a fact about the signing key, not about the source tree.

## `CLIENT_GATE` — the kill switch

When a build has to be retired, this is what stops it reaching the server. Current
clients identify themselves; a retired build cannot, and **absence of the mark is
the signal**:

- REST: `x-demli-client: demli-<app>/<version>` → missing ⇒ **426**
  `CLIENT_UPDATE_REQUIRED` (body carries `downloadUrl`).
- WebSocket: `?client=demli-<app>/<version>` → missing ⇒ close **4426**.

Both doors must close together. Gating only HTTP leaves an old client reading chat
over the socket while it can no longer send.

Always exempt, and this list is the escape hatch — remove an entry and a refused
client can never learn what to install: `/health`, `/mobile/version`, `/hooks/*`,
and every `OPTIONS` (CORS preflight).

**Arming it.** `CLIENT_GATE=on` in `.env.prod` on the VPS, then
`bash scripts/deploy-remote.sh`. Only the literal `on` arms it — empty, `true`,
`1`, `ON` all leave it disarmed, because failing to arm is harmless and arming by
accident locks every real user out. It is deliberately **not** pinned in
`docker-compose.prod.yml` (unlike `MOBILE_LATEST_RUNTIME`), so no commit can flip
it. Ship the arming deploy **alone**, with no other change.

**Verify immediately after arming:**

```bash
curl -fsS https://api.getdemli.com/health                                  # 200 — exemption live
curl -s -o /dev/null -w '%{http_code}\n' https://api.getdemli.com/groups   # 426 — unmarked refused
curl -s -o /dev/null -w '%{http_code}\n' -H 'x-demli-client: demli-desktop/0.0.81' \
     -H "Authorization: Bearer $TOKEN" https://api.getdemli.com/groups     # 200 — marked passes
curl -fsS https://api.getdemli.com/mobile/version                          # 200 — exemption live
```

**Rollback** is server-side only and takes minutes: blank/comment `CLIENT_GATE` in
`.env.prod`, re-run `deploy-remote.sh`. Nothing is needed on any client — which
matters, because the state you would be rolling back from is the one where nobody
can reach the server.

## Media & NAT traversal

The product requirement (ADR 0003): two peers in different cities, one on mobile
cellular, connect **without a VPN**. LiveKit is an SFU, so each client makes an
**outbound** connection to the VPS — the reachability ladder is:

1. **UDP 7882** direct media (works for most networks incl. most cellular).
2. **TCP 7881** ICE-over-TCP fallback (UDP fully blocked but outbound TCP ok).
3. **TURN/UDP 3478** relay (symmetric-NAT cases).
4. **TURN over TLS/443** — only for DPI / "only 443 allowed" networks. Not
   shipped by default (see below).

`rtc.use_external_ip: true` makes LiveKit advertise the VPS public IP in ICE
candidates from behind Docker's bridge.

### Hostile networks (TURN over TLS / 443)

The strongest traversal is TURN over **TLS on 443/tcp**, but Caddy already owns
443/tcp for HTTPS/WSS — they cannot share the port on one IP. So the default
config ships TURN on **UDP 3478** only (LiveKit built-in; auth derived from the
LiveKit token, no separate credentials). If a specific peer on a locked-down
network still cannot connect, escalate to **coturn** (documented alternative,
requires a Project Director decision because it needs one of):

- a **second public IP** dedicated to coturn on 443/tcp+udp, or
- an **SNI-routing layer-4 proxy** on 443 to split `turn.DOMAIN` (→ coturn) from
  the web vhosts (→ Caddy), which needs a custom Caddy build (`caddy-l4`), or
- moving TURN-TLS to **5349** and accepting that a few DPI networks won't relay.

coturn sketch (only if adopted): a `coturn/coturn` service with
`--use-auth-secret --static-auth-secret=$TURN_SHARED_SECRET`, its own cert for
`turn.DOMAIN`, `listening-port=3478`, `tls-listening-port=5349` (or 443 on a
second IP), and a `min/max-port` relay range opened in the firewall.
`.env.prod.example` reserves the commented `TURN_SHARED_SECRET` for this.

> Note vs ADR 0003: the ADR named coturn as the primary TURN. This branch ships
> **LiveKit's built-in TURN** as primary (per the Phase D task) and keeps coturn
> as the documented escalation — both intents are honored.

## Firewall (ufw)

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp          # SSH (restrict to your IP if possible)
sudo ufw allow 80/tcp          # HTTP (ACME challenge + redirect to HTTPS)
sudo ufw allow 443/tcp         # HTTPS / WSS (Caddy)
sudo ufw allow 7881/tcp        # LiveKit ICE-over-TCP fallback
sudo ufw allow 7882/udp        # LiveKit media (UDP mux)
sudo ufw allow 3478/udp        # LiveKit built-in TURN (UDP)
sudo ufw enable
```

Do **not** open 7880 (LiveKit signaling), 4000/4001 (app), or 6379 (Redis) —
they are internal to the Docker network and reached only via Caddy. If you later
add coturn TURN/TLS, also open `5349/tcp` (or `443` on the second IP) and the
coturn relay range (e.g. `49160:49200/udp`).

## Reusing an existing VPS (destructive)

If the box you are deploying onto already runs something else, it is **wiped**
first — this destroys whatever was on it.

> **BACK IT UP FIRST.** Export the existing workloads' data and configuration,
> copy them off the VPS, and verify the backup opens — **before** wiping. This
> step is irreversible.

## What you must provide

The deploy is gated on three things only the instance owner can supply:

1. **Supabase connection string** — the direct/session `DATABASE_URL` (with the
   DB password), from an existing Supabase project.
2. **VPS SSH access** — root/sudo on a wiped Linux VPS (~2 vCPU / 4 GB is
   sufficient) with Docker + the compose plugin installed, and its public IP.
3. **A domain** — with the ability to add A records for `api`, `ws`, `livekit`,
   and `turn` subdomains.

## First-deploy runbook

Run from the repo root (locally on the VPS, or from your workstation with
`DOCKER_HOST=ssh://user@vps` / a docker context pointed at the VPS).

1. **DNS** — add A records `api.DOMAIN`, `ws.DOMAIN`, `livekit.DOMAIN`,
   `turn.DOMAIN`, all → the VPS IP. Wait for propagation (`dig api.DOMAIN`).
2. **Back up, then wipe** the VPS if it is already in use (see warning above). Install Docker +
   compose. Apply the firewall rules above.
3. **Configure** — `cp .env.prod.example .env.prod` and fill in: `DOMAIN`,
   `ACME_EMAIL`, `DATABASE_URL` (Supabase, `?sslmode=require`), `CORS_ORIGIN`,
   `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_URL=wss://livekit.DOMAIN`.
   Generate LiveKit keys: `openssl rand -hex 16` / `openssl rand -hex 32`.
4. **Deploy** — `bash scripts/deploy.sh`. It renders the LiveKit config, builds
   images, runs migrations (aborting on failure), starts the stack, and waits
   for API health. Caddy obtains TLS certs automatically on first start (needs
   80/443 reachable + DNS resolving).
5. **Verify**:
   - `curl -fsS https://api.DOMAIN/health` → `{"status":"ok",...}`
   - `wss://ws.DOMAIN` reachable (the desktop app connects with a session token)
   - Join a voice channel from two networks (one on cellular) and confirm
     screen-share-with-audio holds.
6. **Point clients** at `https://api.DOMAIN`, `wss://ws.DOMAIN`,
   `wss://livekit.DOMAIN`.

Re-deploys: just re-run `bash scripts/deploy.sh` — it is idempotent (rebuilds,
re-migrates, refreshes containers). Migrations are additive/idempotent; the seed
script is **never** run in production (it wipes data).

## Commands

```bash
bash scripts/deploy.sh                                             # full deploy / refresh
bash scripts/backup-db.sh                                          # database dump (cron + ad-hoc)
bash scripts/restore-db-verify.sh                                  # prove the newest dump restores
bash scripts/publish-landing.sh                                    # build + upload the landing site
DRY_RUN=1 bash scripts/publish-landing.sh                          # resolve + list, upload nothing
docker compose --env-file .env.prod -f docker-compose.prod.yml ps       # status
docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f  # tail logs
docker compose --env-file .env.prod -f docker-compose.prod.yml down     # stop (volumes kept)

pnpm lint:deploy      # static invariants: host-key pinning, no password in argv,
                      # stop-before-rm ordering, APP_ENV pinned, dev ports on loopback
pnpm test:deploy      # behavioural: host-key pinning vs a real impostor key, and
                      # deploy.sh's migration/rollback against a fake Docker
```
