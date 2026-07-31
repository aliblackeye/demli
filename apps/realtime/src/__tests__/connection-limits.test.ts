/**
 * Unit tests for the handshake-abuse primitives (connection-limits.ts): client
 * address derivation and the per-address handshake bucket.
 *
 * The address function is the one that must not be got wrong. In production this
 * gateway only ever sees Caddy's container address on the socket, so a limit
 * keyed on it would be ONE bucket for every user on the platform; and reading the
 * header the naive way (leftmost entry) would let any client mint a fresh bucket
 * per handshake with a forged header — the exact bug that was found and fixed on
 * the HTTP side of this product.
 */

import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { clientIpFrom, HandshakeLimiter } from "../connection-limits.js";

/** A request stub carrying just what `clientIpFrom` reads. */
function request(remoteAddress: string | undefined, forwardedFor?: string | string[]) {
  return {
    socket: { remoteAddress },
    headers: forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor },
  } as unknown as IncomingMessage;
}

describe("clientIpFrom", () => {
  it("uses the transport address when no proxy is trusted", () => {
    expect(clientIpFrom(request("198.51.100.7", "1.2.3.4"), 0)).toBe("198.51.100.7");
  });

  it("falls back to the transport address when the header is missing", () => {
    expect(clientIpFrom(request("198.51.100.7"), 1)).toBe("198.51.100.7");
  });

  it("takes the RIGHTMOST entry with one trusted hop — the address Caddy appended", () => {
    expect(clientIpFrom(request("172.18.0.3", "203.0.113.9"), 1)).toBe("203.0.113.9");
  });

  it("ignores forged entries to the LEFT of the trusted hop", () => {
    // The client sent `X-Forwarded-For: 9.9.9.9` and Caddy appended the address
    // it actually saw. Trusting the leftmost value here would hand every attacker
    // an unlimited supply of fresh rate-limit buckets.
    const ip = clientIpFrom(request("172.18.0.3", "9.9.9.9, 8.8.8.8, 203.0.113.9"), 1);
    expect(ip).toBe("203.0.113.9");
  });

  it("handles a repeated header and stray whitespace", () => {
    expect(clientIpFrom(request("172.18.0.3", ["9.9.9.9", "  203.0.113.9 "]), 1)).toBe(
      "203.0.113.9",
    );
  });

  it("never returns an empty string when the header is junk", () => {
    expect(clientIpFrom(request("172.18.0.3", " , ,"), 1)).toBe("172.18.0.3");
    expect(clientIpFrom(request(undefined), 1)).toBe("unknown");
  });
});

describe("HandshakeLimiter", () => {
  it("allows a burst up to capacity and refuses the next handshake", () => {
    const limiter = new HandshakeLimiter(3, 1, () => 1000);
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
  });

  it("keys buckets per address — one abuser cannot spend everyone's budget", () => {
    const limiter = new HandshakeLimiter(1, 1, () => 1000);
    expect(limiter.take("attacker")).toBe(true);
    expect(limiter.take("attacker")).toBe(false);
    // A different household is untouched.
    expect(limiter.take("someone-else")).toBe(true);
  });

  it("refills over time so a paced client is never permanently locked out", () => {
    let now = 1000;
    const limiter = new HandshakeLimiter(2, 1, () => now);
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
    now += 1000; // one second → one token
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
  });

  it("bounds its own table so address cycling cannot exhaust memory", () => {
    let now = 1000;
    const limiter = new HandshakeLimiter(1, 1, () => now, 10);
    for (let i = 0; i < 200; i++) {
      now += 1; // same instant-ish: nothing has time to refill
      limiter.take(`addr-${i}`);
    }
    expect(limiter.trackedAddresses).toBeLessThanOrEqual(10);
  });

  it("prunes idle addresses first and keeps the bucket of one actively over budget", () => {
    let now = 0;
    // Capacity 2 at 1/s ⇒ a bucket is provably full again after 2 s of silence.
    const limiter = new HandshakeLimiter(2, 1, () => now, 4);
    limiter.take("idle-1");
    limiter.take("idle-2");

    now = 5_000; // both idlers are now long past their refill window
    limiter.take("abuser");
    limiter.take("abuser");
    expect(limiter.take("abuser")).toBe(false); // empty, and hot

    limiter.take("fresh"); // 4th entry
    limiter.take("trigger"); // at the cap ⇒ prune runs

    // The two idle entries went, the hot ones stayed.
    expect(limiter.trackedAddresses).toBe(3);
    // The decisive assertion: the abuser's EMPTY bucket survived the prune, so
    // pruning is not an accidental amnesty for whoever is attacking right now.
    expect(limiter.take("abuser")).toBe(false);
  });
});
