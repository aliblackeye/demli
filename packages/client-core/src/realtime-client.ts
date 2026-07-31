/**
 * Realtime WebSocket client for the gateway (apps/realtime). Shared by desktop
 * and mobile (ADR 0002) — framework-, store-, and DOM-free.
 *
 * - Handshake: session token as a `token` query param (gateway contract).
 * - Every inbound frame is validated with the zod envelope schema from
 *   @demli/protocol before it reaches a handler — no trusting the wire.
 * - `seq` is monotonic per connection; a gap means events were dropped and
 *   the owner must refetch over HTTP (handlers.onGap).
 * - Reconnects with capped exponential backoff + jitter. The gateway
 *   re-subscribes the connection to all of the user's channels on every
 *   handshake, so "resubscribe" == reconnect.
 *
 * `realtimeUrl` is injected via config (desktop passes VITE_REALTIME_URL); the
 * timers use the bare `setTimeout`/`clearTimeout` globals (browser, Electron
 * renderer, and React Native all provide them). Dispatching into stores lives
 * in the per-app glue (desktop: src/realtime/connection.ts).
 */

import {
  serverEnvelopeSchema,
  type ClientToServerEvent,
  type PresencePlatform,
  type ServerToClientEvent,
} from "@demli/protocol";
import {
  readClientUpdateRequiredClose,
  type ClientUpdateRequired,
} from "./client-gate.js";
import {
  CLIENT_SIGNATURE_QUERY_PARAM,
  isValidClientSignature,
} from "@demli/config";

/** Gateway close code for a missing/invalid/expired session token. */
const CLOSE_UNAUTHORIZED = 4401;

const BACKOFF_BASE_MS = 1_000;
/**
 * Backoff ceiling. Deliberately left at 30 s: a client that has been down
 * longer already shows "reconnecting", and stretching this further would make
 * recovery from a long outage feel dead. The herd is broken up by JITTER (see
 * below), not by waiting longer.
 */
const BACKOFF_MAX_MS = 30_000;
/**
 * Jitter on the FIRST retry. Small on purpose — a one-off blip must heal almost
 * instantly, so attempt 0 keeps the original ~1.0-1.5 s behavior.
 */
const BACKOFF_JITTER_BASE_MS = 500;
/**
 * Jitter ceiling once backoff has grown.
 *
 * A 0-500 ms spread is nowhere near enough after a server restart: every client
 * is disconnected within the same instant, so they retry in lockstep, and each
 * handshake costs 8-12 DB queries against a 10-connection pool — a textbook
 * thundering herd. Jitter therefore SCALES with the attempt (capped here), which
 * puts the widest spread exactly on the later attempts, the ones that are
 * actually synchronized across the fleet, while leaving the first retry fast.
 */
const BACKOFF_JITTER_MAX_MS = 5_000;

export type RealtimeStatus = "idle" | "connecting" | "online" | "reconnecting";

/** Injected transport config for {@link RealtimeClient}. */
export interface RealtimeClientConfig {
  /** Gateway websocket base URL, e.g. ws://localhost:4001 (no trailing slash). */
  realtimeUrl: string;
  /**
   * This build's identity mark, `demli-<app>/<version>` — the same value the
   * api client sends as a header, built with `formatClientSignature` from
   * `@demli/config`.
   *
   * It rides the QUERY STRING here and not a header for one reason: a browser
   * cannot set custom headers on a WebSocket handshake. `platform` below is the
   * existing precedent for the same constraint.
   *
   * REQUIRED for the same reason as on the api client: gating BOTH transports
   * is the point. Gate only HTTP and a retired build keeps reading live chat
   * over its socket — the hole the whole mechanism was built to close.
   */
  clientSignature: string;
  /**
   * The client kind this app runs as — desktop passes "desktop", mobile passes
   * "mobile" (task #47). Sent as a handshake query param so the gateway can tag
   * this connection's presence. Optional: omitted, the gateway records no
   * platform for the connection (older behavior), so it is fully additive.
   */
  platform?: PresencePlatform;
}

export interface RealtimeHandlers {
  onEvent: (event: ServerToClientEvent) => void;
  onStatus: (status: RealtimeStatus) => void;
  /** Envelope seq gap detected — events were missed, refetch via HTTP. */
  onGap: () => void;
  /** The gateway rejected the session token — the session is dead. */
  onAuthExpired: () => void;
  /**
   * The gateway rejected this BUILD (close 4426, see client-gate.ts). Optional
   * so a surface that has no migration screen keeps compiling — but note what
   * happens either way: the client STOPS retrying, because a build the server
   * has retired will be refused on every future handshake and a backoff loop
   * against it is pure noise (and, on mobile, battery).
   */
  onClientUpdateRequired?: (info: ClientUpdateRequired) => void;
}

export class RealtimeClient {
  private socket: WebSocket | null = null;
  private token: string | null = null;
  private lastSeq = 0;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private status: RealtimeStatus = "idle";
  private everConnected = false;

  constructor(
    private readonly config: RealtimeClientConfig,
    private readonly handlers: RealtimeHandlers,
  ) {
    // Same reasoning as createApiClient: a malformed mark type-checks, then
    // reads to the gate exactly like no mark at all. Fail at construction so it
    // cannot ship.
    if (!isValidClientSignature(config.clientSignature)) {
      throw new Error(
        `RealtimeClient: invalid clientSignature ${JSON.stringify(config.clientSignature)} — ` +
          "expected `demli-<app>/<version>`; build it with formatClientSignature() from @demli/config.",
      );
    }
  }

  getStatus(): RealtimeStatus {
    return this.status;
  }

  /** Open (or replace) the connection for this session token. */
  connect(token: string): void {
    this.token = token;
    this.attempts = 0;
    this.everConnected = false;
    this.openSocket("connecting");
  }

  /**
   * Tear down and immediately re-handshake. Used after membership changes
   * (group/channel created, invite redeemed) so the gateway subscribes this
   * connection to the new channels.
   */
  reconnectNow(): void {
    if (!this.token) return;
    this.openSocket(this.everConnected ? "reconnecting" : "connecting");
  }

  disconnect(): void {
    this.token = null;
    this.intentionalClose = true;
    this.clearReconnectTimer();
    this.socket?.close(1000, "client disconnect");
    this.socket = null;
    this.setStatus("idle");
  }

  /** Returns false when the socket is not open (caller marks the send failed). */
  send(event: ClientToServerEvent): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(event));
    return true;
  }

  // -------------------------------------------------------------------------

  private openSocket(pendingStatus: Extract<RealtimeStatus, "connecting" | "reconnecting">): void {
    if (!this.token) return;
    this.clearReconnectTimer();

    // Silence the close handler of any previous socket before replacing it.
    if (this.socket) {
      this.intentionalClose = true;
      this.socket.close(1000, "replaced");
    }
    this.intentionalClose = false;
    this.lastSeq = 0;
    this.setStatus(pendingStatus);

    // `platform` (optional) tags this connection's presence at the gateway; a
    // client without it simply carries no platform (fully backward compatible).
    const platformParam = this.config.platform
      ? `&platform=${encodeURIComponent(this.config.platform)}`
      : "";
    // `client` is the gate's mark (see RealtimeClientConfig.clientSignature).
    // Sent on every handshake INCLUDING reconnects: the gateway re-checks each
    // one, so dropping it on a retry would retire a live build mid-session.
    const clientParam = `&${CLIENT_SIGNATURE_QUERY_PARAM}=${encodeURIComponent(
      this.config.clientSignature,
    )}`;
    const url = `${this.config.realtimeUrl}/?token=${encodeURIComponent(this.token)}${platformParam}${clientParam}`;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.onmessage = (message) => {
      if (socket !== this.socket) return;
      this.handleFrame(message.data);
    };

    socket.onclose = (event) => {
      if (socket !== this.socket) return;
      this.socket = null;
      if (this.intentionalClose) return;
      if (event.code === CLOSE_UNAUTHORIZED) {
        this.setStatus("idle");
        this.handlers.onAuthExpired();
        return;
      }
      const retired = readClientUpdateRequiredClose(event.code);
      if (retired !== null) {
        // Terminal: drop the token so nothing re-opens the socket behind the
        // migration screen, and never schedule a reconnect (see the handler doc).
        this.token = null;
        this.setStatus("idle");
        this.handlers.onClientUpdateRequired?.(retired);
        return;
      }
      this.scheduleReconnect();
    };

    // Errors are always followed by close; nothing extra to do here.
    socket.onerror = () => undefined;
  }

  private handleFrame(data: unknown): void {
    if (typeof data !== "string") return; // binary frames are not part of the protocol
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const result = serverEnvelopeSchema.safeParse(parsed);
    if (!result.success) {
      console.warn("[realtime] dropped invalid envelope");
      return;
    }

    const { event, seq } = result.data;
    if (this.lastSeq > 0 && seq !== this.lastSeq + 1) {
      this.handlers.onGap();
    }
    this.lastSeq = seq;

    // The first event after a successful handshake is auth.succeeded.
    if (this.status !== "online") {
      this.attempts = 0;
      this.everConnected = true;
      this.setStatus("online");
    }

    this.handlers.onEvent(event);
  }

  private scheduleReconnect(): void {
    if (!this.token) return;
    this.setStatus("reconnecting");
    // Exponential backoff + attempt-scaled jitter. Attempt 0 lands in
    // [1.0, 1.5) s — unchanged, so a blip still heals instantly — and the spread
    // widens with each failure (2 s + [0,1), 4 s + [0,2), … 30 s + [0,5)), so a
    // fleet that all dropped at the same moment arrives back spread over
    // seconds instead of in one burst against the DB pool.
    const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.attempts);
    const jitter = Math.min(BACKOFF_JITTER_MAX_MS, BACKOFF_JITTER_BASE_MS * 2 ** this.attempts);
    const delay = backoff + Math.random() * jitter;
    this.attempts += 1;
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket("reconnecting");
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setStatus(status: RealtimeStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.handlers.onStatus(status);
  }
}
