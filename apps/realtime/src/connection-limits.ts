import type { IncomingMessage } from "node:http";
import { TokenBucket } from "./rate-limit.js";

/**
 * Handshake-level abuse limits for the WebSocket gateway.
 *
 * Everything else in this service is rate limited PER CONNECTION (the token
 * buckets in gateway.ts), which by construction can only start counting once a
 * connection exists. The handshake itself sat outside all of it: no
 * `verifyClient`, no `maxConnections`, and no rate limit on the ws vhost in
 * Caddy — while ONE handshake costs ~8-10 database round trips (session lookup,
 * channel list, per-group visibility, group memberships, blocks, presence,
 * custom statuses). A single valid token in an `open()` loop was therefore an
 * unbounded database load generator that never had to send a frame.
 *
 * Two independent limits close it, because they answer different questions:
 *
 *  1. {@link HandshakeLimiter} — HOW FAST may handshakes arrive from one client
 *     address. Bounds the DB round trips per second, and is checked in
 *     `verifyClient`, i.e. BEFORE the HTTP upgrade completes and before the
 *     session lookup, so a refused attempt costs one token and zero queries.
 *  2. {@link MAX_CONNECTIONS_PER_USER} — HOW MANY sockets one account may hold
 *     open at once. Bounds memory/fd growth for an attacker who paces themselves
 *     under (1).
 */

/**
 * Concurrent sockets one ACCOUNT may hold.
 *
 * Legitimate usage in this product is genuinely multi-socket: the same account
 * is normally signed in on the desktop app AND the phone at the same time, and
 * the web build runs one socket per browser tab. The budget:
 *
 *   desktop 1 + phone 1 + ~6 web tabs = 8, plus 2 of headroom for sockets the
 *   server has not yet reaped (a laptop that slept, a network that dropped
 *   without a FIN — those linger until the 30 s heartbeat fails).
 *
 * 10 is therefore several times any real usage while still being a hard bound.
 * The number can be raised safely because eviction (see below) means being at
 * the cap never refuses anyone.
 */
export const MAX_CONNECTIONS_PER_USER = 10;

/**
 * Close code for a socket dropped to make room under
 * {@link MAX_CONNECTIONS_PER_USER}. In the private 4000-4999 range next to 4401
 * (dead session) and 4426 (retired client), and deliberately NOT one of those
 * two: the client's close handler treats 4401 as "session expired, sign out" and
 * 4426 as terminal, whereas this must simply reconnect (which it does — unknown
 * 4xxx codes fall through to the backoff reconnect in
 * `packages/client-core/src/realtime-client.ts`).
 *
 * 4429 mirrors HTTP 429 so it reads correctly in a log without a lookup table.
 */
export const CLOSE_TOO_MANY_CONNECTIONS = 4429;

/**
 * Handshake burst per client address.
 *
 * Sized for the worst LEGITIMATE burst: several people behind one household NAT
 * (or one carrier-grade NAT), each with a desktop, a phone and a couple of tabs,
 * all reconnecting at the same instant after a deploy or a network blip. That is
 * on the order of 20-40 handshakes in a second or two; 60 clears it with room to
 * spare, while still capping a hostile source at 60 bursts before it has to
 * slow to the refill rate.
 */
export const HANDSHAKE_BUCKET_CAPACITY = 60;

/**
 * Sustained handshakes per second per client address. At ~10 DB round trips per
 * handshake this caps one address at ~10 queries/second of steady load — nothing
 * for Postgres, and far above any real client, whose reconnect backoff starts at
 * 1 s and doubles to 30 s.
 */
export const HANDSHAKE_BUCKET_REFILL_PER_SECOND = 1;

/**
 * Distinct client addresses tracked at once. Past this the table is pruned (see
 * {@link HandshakeLimiter.take}) so a source cycling through IPv6 addresses
 * cannot turn the limiter itself into the memory leak it is meant to prevent.
 */
export const MAX_TRACKED_IPS = 20_000;

/**
 * Proxy hops to trust when deriving the client address. THE NUMBER IS THE
 * SECURITY BOUNDARY, exactly as in the HTTP API (`apps/api/src/app.ts`, where
 * `trustProxy: 1` is set for the same reason).
 *
 * In production this gateway is `expose`d, never published: the only way in is
 * through the Caddy in front of it, so `socket.remoteAddress` is Caddy's
 * container address for EVERY client and an address-keyed limit built on it
 * would collapse into one global bucket — throttling all users together.
 *
 * Caddy APPENDS the real peer to `X-Forwarded-For`, so with exactly one trusted
 * hop the RIGHTMOST entry is the address Caddy saw and everything to its left is
 * client-supplied text. Reading the leftmost entry (what "trust every proxy"
 * means) would let an attacker mint a fresh bucket per handshake with a forged
 * header — the precise bug that was found and fixed on the HTTP side.
 *
 * Raise this ONLY by counting real proxies you control.
 */
export const TRUSTED_PROXY_HOPS = 1;

/**
 * The client address to key limits on. With `hops = 0` (no proxy in front — the
 * local dev default of binding 127.0.0.1) the transport address is used and the
 * header is ignored entirely. With `hops = n` the n-th entry from the RIGHT of
 * `X-Forwarded-For` is used, falling back to the transport address when the
 * header is absent or shorter than expected.
 */
export function clientIpFrom(
  request: IncomingMessage,
  hops: number = TRUSTED_PROXY_HOPS,
): string {
  const remote = request.socket.remoteAddress ?? "unknown";
  if (hops <= 0) return remote;
  const header = request.headers["x-forwarded-for"];
  const raw = Array.isArray(header) ? header.join(",") : (header ?? "");
  const chain = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (chain.length === 0) return remote;
  const index = Math.max(chain.length - hops, 0);
  return chain[index] ?? remote;
}

/**
 * Per-address token bucket over WebSocket handshakes. In-memory and
 * single-process, matching the rest of this gateway's connection state (one
 * instance runs; see the presence reset in index.ts).
 */
export class HandshakeLimiter {
  private readonly buckets = new Map<string, { bucket: TokenBucket; lastSeen: number }>();

  constructor(
    private readonly capacity: number = HANDSHAKE_BUCKET_CAPACITY,
    private readonly refillPerSecond: number = HANDSHAKE_BUCKET_REFILL_PER_SECOND,
    private readonly now: () => number = Date.now,
    private readonly maxTracked: number = MAX_TRACKED_IPS,
  ) {}

  /** True when this handshake may proceed; false when the address is over budget. */
  take(ip: string): boolean {
    const at = this.now();
    let entry = this.buckets.get(ip);
    if (!entry) {
      if (this.buckets.size >= this.maxTracked) this.prune(at);
      entry = {
        bucket: new TokenBucket(this.capacity, this.refillPerSecond, this.now),
        lastSeen: at,
      };
      this.buckets.set(ip, entry);
    }
    entry.lastSeen = at;
    return entry.bucket.take();
  }

  /** Tracked address count — for tests and for a future metric. */
  get trackedAddresses(): number {
    return this.buckets.size;
  }

  /**
   * Bound the table. First drop every address idle long enough for its bucket to
   * have refilled completely: those entries carry no information, so dropping
   * them changes no decision. Only if that frees nothing (every tracked address
   * is ACTIVELY over budget — i.e. an attack from tens of thousands of
   * addresses) fall back to dropping the oldest half, which hands those
   * addresses a reset. That trade is deliberate: an unbounded table would let
   * the same attacker exhaust memory instead, which is strictly worse.
   */
  private prune(at: number): void {
    const fullyRefilledAfterMs = (this.capacity / this.refillPerSecond) * 1000;
    for (const [ip, entry] of this.buckets) {
      if (at - entry.lastSeen >= fullyRefilledAfterMs) this.buckets.delete(ip);
    }
    if (this.buckets.size < this.maxTracked) return;
    let remaining = Math.ceil(this.buckets.size / 2);
    for (const ip of this.buckets.keys()) {
      if (remaining <= 0) break;
      this.buckets.delete(ip);
      remaining -= 1;
    }
  }
}
