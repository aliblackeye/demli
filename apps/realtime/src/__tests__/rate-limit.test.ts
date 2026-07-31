import { describe, expect, it } from "vitest";
import { TokenBucket } from "../rate-limit.js";

describe("TokenBucket", () => {
  it("allows bursts up to capacity, then blocks", () => {
    const now = 0;
    const bucket = new TokenBucket(3, 1, () => now);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
  });

  it("refills over time at the configured rate", () => {
    let now = 0;
    const bucket = new TokenBucket(2, 2, () => now); // 2 tokens/sec
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);

    now = 500; // +1 token
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);

    now = 10_000; // long idle — capped at capacity
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
  });
});
