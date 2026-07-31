# ADR 0002 — Shared `@demli/client-core` (HTTP + Realtime clients)

**Status:** accepted
**Date:** 2026-07-04

## Context

The desktop renderer's server-communication logic — the typed HTTP client
(`apps/desktop/src/renderer/src/lib/api-client.ts`) and the realtime WS client
(`.../lib/realtime-client.ts`) — is already React-free, store-free, and DOM-free. The
upcoming mobile app (ADR 0004) must talk to the same backend with the same wire protocol.
Duplicating this logic in `apps/mobile` would create two drifting copies of the most
protocol-sensitive code we have.

Exploration confirmed both files are portable with only trivial, well-scoped couplings:
- `import.meta.env.VITE_*` for base URLs (Vite-only).
- `window.setTimeout`/`clearTimeout` in the realtime client (RN has bare `setTimeout`).
- `crypto.randomUUID()` used by the desktop glue (`realtime/connection.ts`), not the
  clients themselves (RN needs a polyfill).
- Auth-token **persistence** lives in the store layer (`stores/auth-store.ts`,
  `localStorage`), NOT in the HTTP client (which holds the token in a module var via
  `setAuthToken`). So storage is a clean seam.

## Decision

Extract a new workspace package **`@demli/client-core`** containing the transport
clients, consumed by both `apps/desktop` and `apps/mobile`:

- **`createApiClient(config)`** — the current `api-client.ts` logic, with `baseUrl` (and
  any other env) passed in via a config object instead of read from `import.meta.env`.
  Exports the same endpoint surface, `ApiClientError`, `friendlyErrorMessage`, DTOs, and
  `setAuthToken`.
- **`RealtimeClient(config)`** — the current `realtime-client.ts` (handshake, zod-validated
  envelopes, seq-gap detection, backoff reconnect), with `realtimeUrl` injected and
  `window.setTimeout` → bare `setTimeout`.
- **Injected primitives:** a config object supplies `{ baseUrl, realtimeUrl }`; an
  optional `idGenerator` (default `crypto.randomUUID` where available) covers the nonce/id
  needs of the glue layer.
- **Token-storage adapter** (interface, not implementation) lives at the store layer, not
  in client-core:
  ```ts
  interface TokenStorage {
    get(): Promise<string | null>;
    set(token: string): Promise<void>;
    clear(): Promise<void>;
  }
  ```
  Desktop implements it with `localStorage` (later Electron `safeStorage` via the preload
  bridge, M5); mobile implements it with `expo-secure-store`.
- The per-app **glue** (`realtime/connection.ts` — optimistic send / nonce reconciliation /
  typing throttle, wired to concrete zustand + TanStack stores) stays in each app. Only
  the transport is shared.
- `@demli/media`'s web-only `livekit.ts` moves behind a web entry so the RN bundle
  never pulls `livekit-client` (related, handled with this extraction).

Depends on `@demli/types`, `@demli/protocol`, `@demli/config`, `zod` — all
RN-safe. No React, DOM, or Node-only imports.

## Consequences

- One implementation of the wire protocol for desktop + mobile → far less drift on the
  most protocol-sensitive code.
- Desktop is refactored to consume `client-core`; behavior must be unchanged (the M2b live
  two-user flow is the regression gate).
- Mobile reuses `client-core` directly, supplying a SecureStore token adapter and an RN id
  generator.
- A small amount of ceremony (config object, storage adapter) replaces the previous
  implicit `import.meta.env` / `localStorage` coupling — an acceptable, explicit seam.

## Alternatives considered

- **Duplicate the clients in `apps/mobile`** — fastest to start, but two copies of the
  protocol client guarantee drift and double the maintenance of reconnect/validation
  logic. Rejected.
- **Put the clients in `@demli/protocol`** — conflates the wire *contract* (pure
  data + schemas) with transport *behavior* (fetch/WebSocket/reconnect). Keep protocol
  pure; transport is its own package. Rejected.
