/**
 * Desktop re-export shim for the shared realtime transport client.
 *
 * The RealtimeClient implementation (handshake, zod envelope validation,
 * seq-gap detection, backoff reconnect) now lives in `@demli/client-core`
 * (ADR 0002 — shared with mobile). This file keeps the renderer's
 * `../lib/realtime-client` import path stable; the store-dispatch glue (nonce
 * outbox, typing throttle, cache updates) stays in src/realtime/connection.ts.
 */

export { RealtimeClient } from "@demli/client-core";
export type {
  RealtimeStatus,
  RealtimeHandlers,
  RealtimeClientConfig,
} from "@demli/client-core";
