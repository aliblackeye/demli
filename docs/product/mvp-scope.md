# MVP Scope — Milestones (FROZEN HISTORICAL SNAPSHOT)

> ⚠️ **This document is history, not status.** It is the original milestone plan, frozen as
> written on **2026-07-04**. Everything below under "In progress" and "Next" has since
> **shipped and runs in production** — screen-share publishing, the deploy stack, the shared
> `client-core`, the Expo mobile app, and the hardening milestone are all done, along with a
> long list of programs that this plan never mentions (roles, attachments, i18n, friends/DMs,
> DM calls, watch party, multi-account, a web client).
>
> Kept because the sequencing and the reasoning are worth reading. **Do not use it to decide
> what exists.** For that:
> - current per-platform status → [feature-parity.md](./feature-parity.md)
> - product direction → [vision.md](./vision.md)

## Product goal (expanded)

A premium, **self-hosted** private communication app — text/voice/screen share — that
works on **desktop (Electron)** and **mobile (React Native/Expo, Android APK first, iOS
later)**. The driving use case: two people in different Turkish cities watch a film
together over screen share + audio, **without a VPN** (the mainstream chat apps are
blocked in Turkey by their own domains/IPs; a fresh self-hosted server on an unblocked
IP is not). See ADR 0002 (shared client-core),
ADR 0003 (hybrid deploy), ADR 0004 (mobile stack).

## Done ✅

- **M0 Bootstrap** — monorepo, secure Electron shell, API/realtime skeletons, `.claude`
  operating system, docs.
- **M1 Desktop UI** — dark app shell, 19 components, virtualized message list, mock voice.
- **M2 Backend + Realtime Chat** — Drizzle schema+migrations, auth (argon2 + session
  tokens), groups/channels/messages/invites, WS gateway (typed events, presence, typing),
  rate limits. 46 tests + 12/12 e2e smoke on live PostgreSQL.
- **M2b Desktop → real backend** — typed api client, session auth store + auth screen,
  realtime WS client (reconnect + seq-gap detection), chat on TanStack Query with
  optimistic send, presence/typing. Verified live.
- **M3 Voice engine** — platform-agnostic LiveKit voice FSM (`@demli/media`,
  injectable room adapter), `POST /media/token` with membership checks, docker LiveKit,
  e2e token smoke. FSM 35 tests.

## In progress 🚧

- **A3 Desktop voice UI** — voice store drives the real `createVoiceEngine`
  (`fetchToken` → `/media/token`); join/leave/mute/deafen/speaking/reconnect from the FSM.
- **Phase B (capture layer)** — Electron `desktopCapturer` + `setDisplayMediaRequestHandler`
  with **loopback system audio** (the film's sound), secure IPC + preload bridge.
- **Phase D (deploy scaffolding)** — `docker-compose.prod.yml` (Supabase Postgres + Redis
  + API + realtime + LiveKit + TURN + Caddy auto-HTTPS), `deploy.sh`, operator runbook.
- **Chat reliability** — server-side nonce dedupe (no duplicate messages on retry) +
  Redis pub/sub so API-originated edit/delete broadcast in realtime; Redis-backed presence.

## Next ⏭

- **Phase B (renderer)** — publish the screen-share track (video + film audio) through
  LiveKit, `ScreenShareFocusView` focus mode, track-ended/permission handling. *The heart
  of film night.*
- **Phase C `@demli/client-core`** — extract the HTTP + realtime clients (config-injected,
  storage adapter, id generator) so desktop and mobile share them; keep `livekit.ts`
  web-only. ADR 0002.
- **Phase D (execute)** — stand the stack up on the project's VPS (existing workload wiped → plain
  Linux) with Supabase `DATABASE_URL` + a domain. **First real VPN-free film night
  (desktop ↔ desktop).**
- **Phase E Mobile (Expo)** — `apps/mobile`: auth, groups/channels, chat, join voice,
  **watch the shared screen + audio**, talk. LiveKit RN adapter, SecureStore token,
  Android APK via EAS (iOS later). **Real cross-city film night (mobile watcher).**
- **Phase F Hardening (M5)** — invite deep links, real device settings, security review
  (Electron/IPC, auth, TURN creds, rate limits), desktop installer, QA checklist for the
  two-person film-night scenario, docs.

## Global non-goals (all milestones)

Bots, public discovery, boosts, Nitro-like features, sticker/GIF marketplace,
forum/stage channels, complex role hierarchies. See `docs/product/vision.md`.

## Hard rules

- Voice/video **never** over WebSocket — WebRTC/LiveKit only (CLAUDE.md §35).
- Database on Supabase (managed Postgres); media (LiveKit + TURN) self-hosted on the VPS —
  a managed backend cannot carry WebRTC media (ADR 0003).
- Realtime event names only in `@demli/protocol`; domain types only in
  `@demli/types` — both shared with mobile.
