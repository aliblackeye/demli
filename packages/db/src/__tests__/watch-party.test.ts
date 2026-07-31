/**
 * Watch-party session store (M20, ADR 0016). The in-memory store is exercised
 * purely; the Redis store runs against live Redis (skipped when unreachable),
 * because the two things worth proving there — the TTL actually being armed and
 * the active-index self-healing when a record expires — are Redis behaviors, not
 * ours, and a fake would prove nothing about either.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WatchQueueItem } from "@demli/protocol";
import { createRedisClient, type RedisClient } from "../redis/client.js";
import {
  InMemoryWatchPartyStore,
  RedisWatchPartyStore,
  type WatchSessionRecord,
} from "../redis/watch-party.js";
import { refuseToSkipIfRequired } from "../testing.js";

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";

function makeSession(channelId: string): WatchSessionRecord {
  return {
    channelId,
    hostId: "user-1",
    source: "youtube",
    videoId: "dQw4w9WgXcQ",
    positionSec: 12.5,
    playing: true,
    updatedAtMs: 1_700_000_000_000,
    startedAtMs: 1_700_000_000_000,
    queue: [],
  };
}

function makeQueueItem(itemId: string, videoId: string): WatchQueueItem {
  return {
    itemId,
    videoId,
    addedBy: "user-1",
    addedAt: "2026-07-28T12:00:00.000Z",
    title: "A video",
    durationSeconds: 251,
  };
}

describe("InMemoryWatchPartyStore", () => {
  it("round-trips one session per channel and lists it as active", async () => {
    const store = new InMemoryWatchPartyStore();
    expect(await store.get("c1")).toBeNull();
    expect(await store.activeChannelIds()).toEqual([]);

    await store.save(makeSession("c1"));
    expect(await store.get("c1")).toMatchObject({ channelId: "c1", videoId: "dQw4w9WgXcQ" });
    expect(await store.activeChannelIds()).toEqual(["c1"]);

    // One session per voice channel: saving again REPLACES rather than appends.
    await store.save({ ...makeSession("c1"), videoId: "9bZkp7q19f0" });
    expect(await store.activeChannelIds()).toEqual(["c1"]);
    expect((await store.get("c1"))?.videoId).toBe("9bZkp7q19f0");

    await store.delete("c1");
    expect(await store.get("c1")).toBeNull();
    expect(await store.activeChannelIds()).toEqual([]);
  });

  it("keeps channels independent", async () => {
    const store = new InMemoryWatchPartyStore();
    await store.save(makeSession("c1"));
    await store.save(makeSession("c2"));
    await store.delete("c1");
    expect((await store.activeChannelIds()).sort()).toEqual(["c2"]);
  });

  it("stores a copy, so a caller mutating its record cannot rewrite history", async () => {
    const store = new InMemoryWatchPartyStore();
    const session = makeSession("c1");
    await store.save(session);
    session.positionSec = 9999;
    expect((await store.get("c1"))?.positionSec).toBe(12.5);
  });

  it("copies the QUEUE too, in both directions", async () => {
    const store = new InMemoryWatchPartyStore();
    const session = { ...makeSession("c1"), queue: [makeQueueItem("i1", "dQw4w9WgXcQ")] };
    await store.save(session);

    // Mutating the array we handed in must not reach the store…
    session.queue.push(makeQueueItem("i2", "9bZkp7q19f0"));
    expect((await store.get("c1"))?.queue).toHaveLength(1);

    // …nor may mutating the array we were handed back. Reordering is exactly
    // what the gateway does with this list, so an aliased array would make the
    // in-memory backend behave differently from Redis under the same code.
    const read = await store.get("c1");
    read?.queue.splice(0, 1);
    expect((await store.get("c1"))?.queue).toHaveLength(1);
  });
});

async function isRedisUp(): Promise<boolean> {
  const client = createRedisClient(REDIS_URL, { lazyConnect: true });
  client.on("error", () => undefined);
  try {
    await client.connect();
    await client.ping();
    return true;
  } catch {
    return false;
  } finally {
    await client.quit().catch(() => undefined);
  }
}

const redisUp = await isRedisUp();
if (!redisUp) {
  refuseToSkipIfRequired("redis");
  console.warn("[watch-party.test] REDIS unreachable — skipping RedisWatchPartyStore");
}

describe.skipIf(!redisUp)("RedisWatchPartyStore (live Redis)", () => {
  let redis: RedisClient;
  const prefix = `test:watch:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(() => {
    redis = createRedisClient(REDIS_URL);
    redis.on("error", () => undefined);
  });

  afterAll(async () => {
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  it("round-trips a session and arms its TTL", async () => {
    const store = new RedisWatchPartyStore(redis, 60, prefix);
    await store.save(makeSession("c1"));

    expect(await store.get("c1")).toEqual(makeSession("c1"));
    expect(await store.activeChannelIds()).toEqual(["c1"]);
    // The TTL is the crash backstop: a session record must never be immortal.
    const ttl = await redis.ttl(`${prefix}:session:c1`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);

    await store.delete("c1");
    expect(await store.get("c1")).toBeNull();
    expect(await store.activeChannelIds()).toEqual([]);
  });

  it("prunes index entries whose record is gone (self-healing active set)", async () => {
    const store = new RedisWatchPartyStore(redis, 60, prefix);
    await store.save(makeSession("live"));
    await store.save(makeSession("expired"));
    // Simulate the record expiring (or a crash between the two writes) while its
    // index membership survives — the exact ghost this prune exists for.
    await redis.del(`${prefix}:session:expired`);

    expect(await store.activeChannelIds()).toEqual(["live"]);
    // The ghost is gone from the index, not merely filtered out of the answer.
    expect(await redis.smembers(`${prefix}:active`)).toEqual(["live"]);

    await store.delete("live");
  });

  it("reads a corrupt record as 'no session' instead of throwing", async () => {
    const store = new RedisWatchPartyStore(redis, 60, prefix);
    await redis.set(`${prefix}:session:junk`, "{not json");
    expect(await store.get("junk")).toBeNull();
    // Structurally valid JSON that is not a session is refused too, so a bad
    // record can never be projected into a playback position.
    await redis.set(`${prefix}:session:junk`, JSON.stringify({ channelId: "junk" }));
    expect(await store.get("junk")).toBeNull();
    await redis.del(`${prefix}:session:junk`);
  });

  it("round-trips a queue and re-reads it as the same list", async () => {
    const store = new RedisWatchPartyStore(redis, 60, prefix);
    const session = {
      ...makeSession("q1"),
      queue: [makeQueueItem("i1", "dQw4w9WgXcQ"), makeQueueItem("i2", "9bZkp7q19f0")],
    };
    await store.save(session);
    const read = await store.get("q1");
    expect(read?.queue.map((item) => item.itemId)).toEqual(["i1", "i2"]);
    expect(read?.queue[0]).toEqual(session.queue[0]);
    await store.delete("q1");
  });

  it("reads a PRE-QUEUE record (live in production today) as an empty queue", async () => {
    const store = new RedisWatchPartyStore(redis, 60, prefix);
    // Exactly what the previous gateway wrote: every field except `queue`. If
    // this read as "malformed", the deploy that introduces the queue would end
    // every watch party that happened to be running at that moment.
    const legacy = { ...makeSession("legacy") } as Partial<WatchSessionRecord>;
    delete legacy.queue;
    await redis.set(`${prefix}:session:legacy`, JSON.stringify(legacy));
    await redis.sadd(`${prefix}:active`, "legacy");

    const read = await store.get("legacy");
    expect(read).not.toBeNull();
    expect(read?.videoId).toBe("dQw4w9WgXcQ");
    expect(read?.queue).toEqual([]);

    await store.delete("legacy");
  });

  it("drops queue rows that are not the shape the contract promises", async () => {
    const store = new RedisWatchPartyStore(redis, 60, prefix);
    // This list is broadcast verbatim to every occupant, so a half-valid row
    // would be a frame our own protocol schema rejects. Drop, never repair.
    const damaged = {
      ...makeSession("damaged"),
      queue: [
        makeQueueItem("good", "dQw4w9WgXcQ"),
        { itemId: "no-video" },
        null,
        "not-an-object",
        { ...makeQueueItem("odd", "9bZkp7q19f0"), title: 42, durationSeconds: "nope" },
      ],
    };
    await redis.set(`${prefix}:session:damaged`, JSON.stringify(damaged));

    const read = await store.get("damaged");
    expect(read?.queue.map((item) => item.itemId)).toEqual(["good", "odd"]);
    // The salvageable row keeps its identity and loses only the junk fields.
    expect(read?.queue[1]).toMatchObject({ title: null, durationSeconds: null });

    await redis.del(`${prefix}:session:damaged`);
  });
});
