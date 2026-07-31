# Architecture Overview

Demli is a pnpm workspace monorepo. No Turborepo yet (deferred — see ADR 0001).

## Layout

```txt
apps/
  desktop/    Electron app (main / preload / renderer split — see electron.md)
  mobile/     Expo / React Native client. Started as the "watcher" app (ADR 0004) and has since
              grown to broad parity: auth, chat, voice, camera publish, screen-share watching
              AND publishing (MediaProjection), background talking (foreground service), push,
              Watch Party. Remaining gaps are tracked honestly in feature-parity.md.
              Reuses client-core + the voice FSM; its UI is native, not shared.
  api/        Fastify HTTP API (auth, groups, channels, messages, invites, media tokens,
              friends/DMs, moderation, account lifecycle, avatar/banner uploads)
  realtime/   WebSocket gateway (`ws`) for typed lightweight events — see realtime.md
  web/        Vite SPA shipped at demli.<domain>. NOT a separate UI: it mounts the desktop
              renderer through a `window.demli` bridge, so desktop and web are one product
              UI from one source. Mobile stays separate (native RN).

packages/
  types/        @demli/types       — shared domain types (User, FriendGroup, Channel, Message, …)
  protocol/     @demli/protocol    — typed realtime event contract + envelope
  client-core/  @demli/client-core — shared HTTP + realtime transport clients (ADR 0002)
  media/        @demli/media       — voice/screen-share state machine + engine (VoiceState, VoiceCommand, VoiceError)
  ui/           @demli/ui          — shared UI primitives (shadcn/Radix based; desktop/web only)
  config/       @demli/config      — shared constants (ports, env helpers)
  db/           @demli/db          — database schema + query layer + Redis clients (real from Milestone 2)
```

## Package responsibilities

- **types**: single source of truth for domain shapes. No logic, no dependencies except itself.
- **protocol**: the ONLY place realtime event names and payloads are defined. Depends on `types`.
- **client-core**: the HTTP client and realtime WS client (handshake, envelope validation,
  seq-gap detection, backoff reconnect) — transport only, no UI. Base URLs, id generation, and
  token storage are injected, so it stays DOM- and Node-free and both `apps/desktop` and
  `apps/mobile` consume it unchanged (ADR 0002).
- **media**: voice/screen-share lifecycle model + engine. Framework- and LiveKit-free — the
  LiveKit adapter is injected, so the same FSM runs on desktop (via `@demli/media/web`) and
  mobile (via `@livekit/react-native`). UI reads from it.
- **ui**: presentational primitives only, for desktop/web React. No Electron, no network, no
  domain logic. Not portable to React Native — mobile builds its native UI fresh.
- **config**: tiny shared constants/config. Keep it boring.
- **db**: schema, migrations, queries, and the Redis clients. Only `apps/api`, `apps/realtime`,
  and seeds/tests may use it.

## Dependency direction rules

- **Apps depend on packages. Packages never depend on apps.**
- Packages may depend on other packages only downward:
  `config`/`types` at the bottom → `protocol` → `client-core`/`media`/`db` above them → apps on top.
- **Domain types live only in `packages/types`.** Apps never redeclare `User`, `Message`, etc.
- **Realtime event names live only in `packages/protocol`.** No magic event strings anywhere else.
- **The wire protocol lives once in `packages/client-core`.** Desktop and mobile share it; neither
  re-implements the HTTP/WS transport.
- `apps/desktop` renderer must not import Node/Electron APIs — privileged work goes through
  the preload bridge (see electron.md).

## Runtime topology

```txt
desktop (renderer) ─┐
                    ├──HTTP──────────▶ api (Fastify)          ──▶ PostgreSQL (Supabase in prod)
mobile (Expo)  ─────┤
                    ├──WS (protocol)─▶ realtime (ws gateway)  ──▶ Redis (presence + mutation fan-out)
                    └──WebRTC────────▶ LiveKit (voice + screen share, built-in TURN)
```

`api` and `realtime` are separate processes; HTTP-originated message edits/deletes reach live
sockets through a Redis mutation bus (see realtime.md).

Rule of thumb: if it's a lightweight typed event, it goes over the WebSocket.
If it's audio/video, it goes over LiveKit/WebRTC. Never mix the two (see realtime.md).

## Deploy topology

Hybrid self-host — see [deploy.md](./deploy.md) and ADR 0003. The database runs on **Supabase**
(managed Postgres; the Milestone 2 schema runs against it unchanged). Everything else runs on a
single **VPS** via `docker-compose.prod.yml`: the API, the realtime gateway, **LiveKit**,
**Redis**, and **Caddy** (automatic HTTPS/WSS). TURN is LiveKit's **built-in** TURN on UDP 3478
— a standalone `coturn` container was considered (ADR 0003) but is **not deployed**; see
deploy.md "TURN has no vhost" for why, and for the coturn escalation path if a hostile network
ever needs it. Keeping the media tier on an
unblocked public IP is what makes film-night screen share work VPN-free. This is **live in
production** — the stack runs on the founder's VPS behind Caddy, the desktop app auto-updates
from the API's own release feed, the web SPA is served alongside it, and the mobile app ships
over EAS. Ship steps and credentials handling: CLAUDE.md §32 + `scripts/deploy-remote.sh`.
