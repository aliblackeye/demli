# ADR 0003 — Hybrid Deployment: Supabase Postgres + Self-Hosted Media VPS

**Status:** accepted
**Date:** 2026-07-04

## Context

Demli's core use case is two people in different Turkish cities watching a film
together over screen share + audio, **without a VPN**. The mainstream chat apps are
blocked in Turkey by their specific domains/IPs; a freshly-provisioned server on
an unblocked IP is reachable normally. So the product must run on infrastructure we control, on an unblocked address,
with a real domain + TLS.

The hard requirement is the **media path**: stable screen-share-with-audio between peers
behind different NATs needs a WebRTC SFU (LiveKit) plus a TURN server for restrictive
(especially mobile-carrier) NATs. This must sit on a public IP with open UDP — a managed
backend cannot provide it.

The founder already owns a VPS (running an unrelated workload) that can be wiped to plain Linux,
**and holds a paid Supabase membership** they want to use.

## Decision

**Hybrid: Supabase for the database, a single self-hosted VPS for everything else.**

- **Database → Supabase (managed Postgres).** Supabase *is* Postgres, so our existing
  Milestone 2 schema (Drizzle) and backend run against it **unchanged** — we simply point
  `DATABASE_URL` at the Supabase connection string (direct/session connection for
  migrations, not the transaction pooler). We get managed backups + a dashboard and the
  founder's membership is used. Auth stays our own (argon2 + session tokens); Supabase
  Auth/Realtime/Storage can be adopted later, incrementally and non-destructively.
  Use the **direct/session connection** string with `?sslmode=require` for BOTH migrations
  and runtime — NOT the transaction pooler (6543): `postgres-js` prepared statements are
  incompatible with it (verified in Phase D).
- **VPS → self-hosted media + app tier.** One `docker-compose.prod.yml` runs the API, the
  realtime gateway, **LiveKit** (production keys, not `--dev`), **coturn** (TURN over 443
  tcp/udp), Redis, and **Caddy** (automatic HTTPS/WSS reverse proxy for `api.DOMAIN`,
  `ws.DOMAIN`, `livekit.DOMAIN`). No Postgres container in prod — it lives on Supabase.
- Secrets in an un-committed `.env.prod`; one-command `scripts/deploy.sh` over
  SSH/docker-context; desktop and mobile clients point at the domain.

"Everything on Supabase" is impossible: voice/screen media cannot traverse Supabase, so a
self-hosted LiveKit + TURN VPS is unavoidable regardless of the database choice.

## Consequences

- Managed, backed-up Postgres with zero rewrite (Supabase is Postgres); the tested M2
  backend and its 46 tests stay green pointing at the new `DATABASE_URL`.
- The VPS shrinks to the media + app tier (no DB to operate); media stays on an unblocked
  IP → VPN-free.
- Supabase connection: use the **direct/session connection + `?sslmode=require`** for both
  migrations and the app runtime. The transaction pooler (6543) is NOT usable — `postgres-js`
  prepared statements break on it (Phase D finding).
- TURN/coturn credentials and LiveKit keys are real secrets to manage/review (security
  agent, Phase F).
- The VPS must be **backed up then wiped** before it becomes the Demli host.
- Requires the founder to provide, at Phase D: the **Supabase project connection string**,
  **VPS SSH access**, and a **domain** (~2 vCPU / 4 GB VPS is sufficient).

## Alternatives considered

- **Full Supabase (Postgres + Auth + Realtime + Storage), minimal VPS for LiveKit** —
  maximizes the membership but rewrites the tested M2 auth + WS gateway against
  GoTrue/Realtime for no net gain, and still needs the media VPS. Deferred; can be adopted
  layer-by-layer later.
- **Full self-host including Postgres (no Supabase)** — most "ours" but the founder would
  operate the DB and its backups, and leaves the paid membership unused. Rejected in favor
  of managed Postgres.
- **LiveKit Cloud instead of self-hosted media** — easier scaling but third-party, variable
  cost, less "ours"; the founder preferred self-host. Deferred, not rejected.
