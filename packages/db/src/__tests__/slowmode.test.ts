import { afterAll, describe, expect, it } from "vitest";
import { createRedisClient } from "../redis/client.js";
import { InMemorySlowmodeStore, RedisSlowmodeStore } from "../redis/slowmode.js";
import { refuseToSkipIfRequired } from "../testing.js";

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";

describe("InMemorySlowmodeStore", () => {
  it("allows the first send and blocks within the window", async () => {
    let now = 1_000_000;
    const store = new InMemorySlowmodeStore(() => now);

    expect(await store.check("ch1", "u1", 10)).toEqual({ ok: true });

    now += 4_000; // 4s of a 10s window elapsed
    const blocked = await store.check("ch1", "u1", 10);
    expect(blocked).toEqual({ ok: false, retryAfterSeconds: 6 });

    now += 6_000; // window over
    expect(await store.check("ch1", "u1", 10)).toEqual({ ok: true });
  });

  it("scopes slots per channel and per user", async () => {
    const now = 1_000_000;
    const store = new InMemorySlowmodeStore(() => now);

    expect(await store.check("ch1", "u1", 10)).toEqual({ ok: true });
    // Different user, same channel — own slot.
    expect(await store.check("ch1", "u2", 10)).toEqual({ ok: true });
    // Same user, different channel — own slot.
    expect(await store.check("ch2", "u1", 10)).toEqual({ ok: true });
    expect((await store.check("ch1", "u1", 10)).ok).toBe(false);
  });

  it("treats seconds <= 0 as slowmode off", async () => {
    const store = new InMemorySlowmodeStore();
    expect(await store.check("ch1", "u1", 0)).toEqual({ ok: true });
    expect(await store.check("ch1", "u1", 0)).toEqual({ ok: true });
  });

  it("honors a LOWERED slowmode immediately", async () => {
    let now = 1_000_000;
    const store = new InMemorySlowmodeStore(() => now);

    expect(await store.check("ch1", "u1", 600)).toEqual({ ok: true });
    now += 15_000; // 15s later the owner lowered slowmode to 10s
    expect(await store.check("ch1", "u1", 10)).toEqual({ ok: true });
  });
});

// Redis-backed store — verified against the real Redis from docker-compose,
// skipped (with a notice) when it is down.
async function isRedisUp(): Promise<boolean> {
  const probe = createRedisClient(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0 });
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

const redisUp = await isRedisUp();
if (!redisUp) {
  refuseToSkipIfRequired("redis");
  console.warn("[slowmode.test] REDIS unreachable — skipping RedisSlowmodeStore tests");
}

describe.skipIf(!redisUp)("RedisSlowmodeStore", () => {
  const redis = createRedisClient(REDIS_URL);
  const prefix = `slowmode-test-${Date.now().toString(36)}`;
  const store = new RedisSlowmodeStore(redis, prefix);

  afterAll(async () => {
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  it("claims a slot atomically and reports remaining wait", async () => {
    expect(await store.check("chA", "u1", 30)).toEqual({ ok: true });

    const blocked = await store.check("chA", "u1", 30);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(30);
    }
    // Other users/channels are unaffected.
    expect(await store.check("chA", "u2", 30)).toEqual({ ok: true });
    expect(await store.check("chB", "u1", 30)).toEqual({ ok: true });
  });

  it("honors a LOWERED slowmode immediately (stale longer TTL)", async () => {
    expect(await store.check("chC", "u1", 600)).toEqual({ ok: true });
    // Simulate the slot having been claimed 15s ago under the old setting.
    await redis.set(`${prefix}:chC:u1`, String(Date.now() - 15_000), "EX", 600);
    expect(await store.check("chC", "u1", 10)).toEqual({ ok: true });
  });

  it("treats seconds <= 0 as slowmode off", async () => {
    expect(await store.check("chD", "u1", 0)).toEqual({ ok: true });
    expect(await store.check("chD", "u1", 0)).toEqual({ ok: true });
  });
});
