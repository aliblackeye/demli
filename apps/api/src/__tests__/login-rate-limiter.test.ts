import { describe, expect, it } from "vitest";
import { LoginRateLimiter } from "../lib/login-rate-limiter.js";

describe("LoginRateLimiter (per-username login throttle — H1 second dimension)", () => {
  it("throttles a username after maxFailures failed attempts, regardless of source", () => {
    const limiter = new LoginRateLimiter({ maxFailures: 3, windowMs: 60_000 });
    const now = 1_000_000;

    // The key is the username only — failures from different IPs all count here.
    expect(limiter.isLimited("alice", now)).toBe(false);
    limiter.recordFailure("alice", now);
    limiter.recordFailure("alice", now + 1);
    expect(limiter.isLimited("alice", now + 2)).toBe(false);
    limiter.recordFailure("alice", now + 2);
    // 3 failures inside the window -> limited.
    expect(limiter.isLimited("alice", now + 3)).toBe(true);
  });

  it("keeps usernames independent", () => {
    const limiter = new LoginRateLimiter({ maxFailures: 2, windowMs: 60_000 });
    limiter.recordFailure("alice");
    limiter.recordFailure("alice");
    expect(limiter.isLimited("alice")).toBe(true);
    expect(limiter.isLimited("bob")).toBe(false);
  });

  it("clears the window on a successful login", () => {
    const limiter = new LoginRateLimiter({ maxFailures: 2, windowMs: 60_000 });
    limiter.recordFailure("alice");
    limiter.recordFailure("alice");
    expect(limiter.isLimited("alice")).toBe(true);
    limiter.clear("alice");
    expect(limiter.isLimited("alice")).toBe(false);
  });

  it("expires failures once they fall outside the sliding window", () => {
    const limiter = new LoginRateLimiter({ maxFailures: 2, windowMs: 1_000 });
    const t0 = 5_000;
    limiter.recordFailure("alice", t0);
    limiter.recordFailure("alice", t0 + 100);
    expect(limiter.isLimited("alice", t0 + 200)).toBe(true);
    // Both timestamps are now older than the 1s window.
    expect(limiter.isLimited("alice", t0 + 1_200)).toBe(false);
  });
});
