# ADR 0001 — Initial Tech Stack

**Status:** accepted
**Date:** 2026-07-02

## Context

Demli is a Windows-first Electron desktop communication app (voice, screen share, chat) for
private friend groups, built by a small multi-agent team. We need a stack that starts lean,
ships a working voice product fast, and does not block later growth. CLAUDE.md §3 sets the
preferred stack; this ADR records the concrete choices and tradeoffs.

## Decision

- **Desktop:** Electron + React + TypeScript + Vite (electron-vite), Tailwind CSS,
  shadcn/ui on Radix primitives.
- **Client state:** Zustand (local UI/app state) + TanStack Query (server state) — planned,
  lands with Milestone 1/2. Voice lifecycle uses the FSM in `packages/media`, not ad-hoc state.
- **API:** **Fastify over NestJS.** The app starts lean; Fastify is fast, simple, and
  TypeScript-friendly. Revisit NestJS only if module boundaries become large.
- **Database:** PostgreSQL with **Drizzle planned over Prisma** — lighter runtime, SQL-close,
  plays well with explicit schema/migrations. Locked in when Milestone 2 starts.
- **Realtime events:** WebSocket via the **`ws`** library in a dedicated `apps/realtime`
  gateway, with the typed contract in `packages/protocol`. No socket.io — we want a thin,
  fully typed layer.
- **Media:** **LiveKit over mediasoup.** SFU, client SDKs, reconnect and track management out
  of the box. mediasoup only if we later need deeper custom media control.
- **Monorepo:** **pnpm workspace without Turborepo for now** — deferred until the build graph
  justifies it (build times or task orchestration pain).
- **Infra:** Redis for presence/fan-out; Docker compose for local postgres/redis/livekit.

## Consequences

- Fast start with few moving parts; every layer is typed end-to-end via shared packages.
- Fastify means we hand-roll module structure discipline (see architecture/overview.md).
- Drizzle "planned" means `packages/db` stays a stub until Milestone 2 — acceptable.
- LiveKit adds a service dependency (self-host vs cloud decision deferred to Milestone 3).
- No Turborepo means plain `pnpm -r` scripts; acceptable at current repo size, revisit later.

## Alternatives considered

- **NestJS** — more structure, but heavy for a lean start; deferred, not rejected.
- **Prisma** — great DX, but heavier runtime/engine; Drizzle fits our explicit-schema rule.
- **mediasoup** — maximum control, but we'd rebuild what LiveKit already provides.
- **socket.io** — rooms/reconnect built in, but obscures the wire format; `ws` + our own
  typed envelope keeps the contract explicit.
- **Turborepo** — useful later; premature for ~10 small packages today.
- **Tauri** — smaller binaries, but weaker desktop-capture/ecosystem maturity for our media needs.
