/**
 * #110 — the presence READER's push gate. `filterAway` is the WhatsApp model:
 * a user is "away" (and pushed) when NO live connection is foreground — offline
 * OR every connection backgrounded. The InMemory reader is exercised purely; the
 * Redis reader is exercised against the very `appstate` hash the gateway writer
 * maintains (live Redis, skipped when unreachable).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRedisClient, type RedisClient } from "../redis/client.js";
import { InMemoryPresenceReader, RedisPresenceReader } from "../redis/presence-reader.js";
import { refuseToSkipIfRequired } from "../testing.js";

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";

describe("InMemoryPresenceReader", () => {
  it("filterOffline is unchanged — only users with no connection at all", async () => {
    const reader = new InMemoryPresenceReader(["online-user"]);
    reader.setBackground("bg-user"); // connected → NOT offline
    expect(
      (await reader.filterOffline(["online-user", "bg-user", "off-user"])).sort(),
    ).toEqual(["off-user"]);
  });

  it("filterAway includes offline AND backgrounded, excludes foreground", async () => {
    const reader = new InMemoryPresenceReader();
    reader.setForeground("fg-user");
    reader.setBackground("bg-user");
    // off-user never connects
    expect(
      (await reader.filterAway(["fg-user", "bg-user", "off-user"])).sort(),
    ).toEqual(["bg-user", "off-user"]);
  });

  it("constructor-supplied online users are FOREGROUND (backward compatible)", async () => {
    const reader = new InMemoryPresenceReader(["a", "b"]);
    expect(await reader.filterAway(["a", "b"])).toEqual([]); // both reachable
  });

  it("setForeground clears a prior background mark (round trip)", async () => {
    const reader = new InMemoryPresenceReader();
    reader.setBackground("u");
    expect(await reader.filterAway(["u"])).toEqual(["u"]); // away
    reader.setForeground("u");
    expect(await reader.filterAway(["u"])).toEqual([]); // reachable
    reader.setOffline("u");
    expect(await reader.filterAway(["u"])).toEqual(["u"]); // offline → away
  });

  it("short-circuits an empty input", async () => {
    const reader = new InMemoryPresenceReader(["a"]);
    expect(await reader.filterAway([])).toEqual([]);
    expect(await reader.filterOffline([])).toEqual([]);
  });

  it("countPublicOnline counts connected users, masking invisible ones", async () => {
    const reader = new InMemoryPresenceReader(["on"]);
    reader.setInvisible("ghost"); // connected but publicly offline ⇒ excluded
    reader.setBackground("bg"); // backgrounded is still publicly online
    // "off" never connects.
    expect(await reader.countPublicOnline(["on", "ghost", "bg", "off"])).toBe(2);
    expect(await reader.countPublicOnline([])).toBe(0);
  });

  it("setOnline clears a prior invisible mark (round trip)", async () => {
    const reader = new InMemoryPresenceReader();
    reader.setInvisible("u");
    expect(await reader.countPublicOnline(["u"])).toBe(0);
    reader.setOnline("u");
    expect(await reader.countPublicOnline(["u"])).toBe(1);
    reader.setOffline("u");
    expect(await reader.countPublicOnline(["u"])).toBe(0);
  });

  it("invisible users are still connected for push purposes (not away)", async () => {
    // The invisible mask is a PEER-VISIBILITY rule only: the user has a live
    // foreground connection, so the push gate must keep treating them as
    // reachable (no OS push) even though the public online count excludes them.
    const reader = new InMemoryPresenceReader();
    reader.setInvisible("u");
    expect(await reader.filterOffline(["u"])).toEqual([]);
    expect(await reader.filterAway(["u"])).toEqual([]);
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
  console.warn("[presence-reader.test] REDIS unreachable — skipping RedisPresenceReader.filterAway");
}

describe.skipIf(!redisUp)("RedisPresenceReader.filterAway (live Redis)", () => {
  let redis: RedisClient;
  const prefix = `test:presence:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(() => {
    redis = createRedisClient(REDIS_URL);
    redis.on("error", () => undefined);
  });

  afterAll(async () => {
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  /**
   * Simulate the gateway writer: a live socket seeds `conns` + an `appstate` field
   * + a `connstatus` field. Mirrors `RedisPresenceStore.connect` (which defaults
   * app state to foreground and status to online) / setAppState / setStatus.
   */
  async function connect(
    userId: string,
    connId: string,
    state: string,
    status = "online",
  ): Promise<void> {
    await redis.sadd(`${prefix}:conns:${userId}`, connId);
    await redis.hset(`${prefix}:appstate:${userId}`, connId, state);
    await redis.hset(`${prefix}:connstatus:${userId}`, connId, status);
  }

  it("returns offline and all-backgrounded users, never a foreground one", async () => {
    const reader = new RedisPresenceReader(redis, prefix);
    await connect("fg", "c1", "foreground");
    await connect("bg", "c1", "background");
    // A user with BOTH a foreground and a background connection is reachable.
    await connect("mixed", "c1", "background");
    await connect("mixed", "c2", "foreground");
    // "off" never connects.

    const away = await reader.filterAway(["fg", "bg", "mixed", "off"]);
    expect(away.sort()).toEqual(["bg", "off"]);

    expect(await reader.filterAway([])).toEqual([]);
  });

  it("countPublicOnline reads the gateway's conns + connstatus keys, masking invisible", async () => {
    const reader = new RedisPresenceReader(redis, prefix);
    // Simulate the gateway writer: conns SET = live sockets, connstatus HASH =
    // what each of those sockets declared (ADR 0020; an empty hash ⇒ online).
    await connect("pub", "c1", "foreground");
    await connect("ghost", "c1", "foreground", "invisible"); // masked ⇒ excluded
    await connect("idler", "c1", "background", "idle"); // idle is publicly online
    // "nobody" never connects; a lingering status without conns must not count.
    await redis.hset(`${prefix}:connstatus:stale`, "c1", "online");

    expect(
      await reader.countPublicOnline(["pub", "ghost", "idler", "nobody", "stale"]),
    ).toBe(2);
    expect(await reader.countPublicOnline([])).toBe(0);
  });

  it("derives over ALL of a user's connections, so a second device cannot unmask invisible", async () => {
    const reader = new RedisPresenceReader(redis, prefix);
    // The reader must apply the SAME reduction the gateway does (ADR 0020): the
    // invisible declaration outranks the other device's plain "online", so this
    // user stays out of the invite card's count.
    await connect("hidden", "desktop", "foreground", "invisible");
    await connect("hidden", "phone", "foreground", "online");
    expect(await reader.countPublicOnline(["hidden"])).toBe(0);

    // All-idle is still publicly online (amber dot, counted once).
    await connect("sleepy", "desktop", "background", "idle");
    await connect("sleepy", "phone", "background", "idle");
    expect(await reader.countPublicOnline(["sleepy"])).toBe(1);
  });

  it("ignores a leftover pre-ADR-0020 per-user status STRING", async () => {
    const reader = new RedisPresenceReader(redis, prefix);
    // Live production Redis still holds these when this version deploys. The new
    // key name (`connstatus`) means the STRING cannot WRONGTYPE the hash read, and
    // its stale "invisible" must not mask a user who is plainly online.
    await connect("legacy", "c1", "foreground");
    await redis.set(`${prefix}:status:legacy`, "invisible");
    expect(await reader.countPublicOnline(["legacy"])).toBe(1);
  });
});
