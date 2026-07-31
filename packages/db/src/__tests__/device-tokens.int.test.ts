/**
 * Task #46 — device-tokens repo + presence reader integration tests.
 *
 * `device_tokens` uses real Postgres; the `RedisPresenceReader` uses real Redis
 * (both from docker-compose). Each suite auto-skips (with a notice) when its
 * backend is unreachable. `applyMigrations` runs in beforeAll, so a green suite
 * also proves migration 0009 applies cleanly.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createDb,
  createRedisClient,
  createRepositories,
  RedisPresenceReader,
  schema,
  type DbClient,
  type RedisClient,
  type Repositories,
} from "../index.js";
import { refuseToSkipIfRequired } from "../testing.js";

const DATABASE_URL =
  process.env["DATABASE_URL"] ?? "postgresql://postgres:postgres@localhost:5432/demli";
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";

async function isDbUp(): Promise<boolean> {
  const { sql, close } = createDb(DATABASE_URL, { max: 1 });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await close();
  }
}

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

/** Unique per row so parallel suites never collide (the username trap). */
function uniq(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

const dbUp = await isDbUp();
if (!dbUp) {
  refuseToSkipIfRequired("postgres");
  console.warn("[device-tokens.int.test] DATABASE unreachable — skipping");
}

describe.skipIf(!dbUp)("deviceTokensRepo (live Postgres)", () => {
  let client: DbClient;
  let repos: Repositories;

  async function newUser(prefix: string): Promise<string> {
    const u = await repos.users.create({
      username: uniq(prefix),
      displayName: prefix,
      passwordHash: "not-used",
    });
    return u.id;
  }

  /** A syntactically valid-enough Expo token; the repo does not validate format. */
  function token(): string {
    return `ExponentPushToken[${uniq("t")}]`;
  }

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);
  });

  afterAll(async () => {
    await client?.close();
  });

  it("upsert inserts a new device row", async () => {
    const userId = await newUser("dt");
    const t = token();

    const row = await repos.deviceTokens.upsert(userId, t, "ios");

    expect(row.userId).toBe(userId);
    expect(row.token).toBe(t);
    expect(row.platform).toBe("ios");
    expect(row.createdAt).toBeTruthy();
    expect(row.lastSeenAt).toBeTruthy();

    const list = await repos.deviceTokens.listForUser(userId);
    expect(list).toHaveLength(1);
    expect(list[0]?.token).toBe(t);
  });

  it("upsert on the same token re-binds to the new owner and bumps last_seen_at", async () => {
    const alice = await newUser("dt_a");
    const bob = await newUser("dt_b");
    const t = token();

    const first = await repos.deviceTokens.upsert(alice, t, "android");
    // Small gap so the timestamp advance is observable.
    await new Promise((r) => setTimeout(r, 5));
    const second = await repos.deviceTokens.upsert(bob, t, "ios");

    // Same physical device (unique token) → one row, now owned by bob.
    expect(second.id).toBe(first.id);
    expect(second.userId).toBe(bob);
    expect(second.platform).toBe("ios");
    expect(new Date(second.lastSeenAt).getTime()).toBeGreaterThanOrEqual(
      new Date(first.lastSeenAt).getTime(),
    );

    // Alice no longer owns it; bob does.
    expect(await repos.deviceTokens.listForUser(alice)).toHaveLength(0);
    const bobList = await repos.deviceTokens.listForUser(bob);
    expect(bobList.map((r) => r.token)).toContain(t);
  });

  it("listForUser returns every device of a user only", async () => {
    const userId = await newUser("dt_multi");
    const other = await newUser("dt_other");
    const t1 = token();
    const t2 = token();
    await repos.deviceTokens.upsert(userId, t1, "ios");
    await repos.deviceTokens.upsert(userId, t2, "android");
    await repos.deviceTokens.upsert(other, token(), "ios");

    const list = await repos.deviceTokens.listForUser(userId);
    expect(list.map((r) => r.token).sort()).toEqual([t1, t2].sort());
  });

  it("listTokensForUsers flattens tokens across a set of users (empty short-circuits)", async () => {
    const a = await newUser("dt_fa");
    const b = await newUser("dt_fb");
    const ta = token();
    const tb1 = token();
    const tb2 = token();
    await repos.deviceTokens.upsert(a, ta, "ios");
    await repos.deviceTokens.upsert(b, tb1, "android");
    await repos.deviceTokens.upsert(b, tb2, "android");

    expect(await repos.deviceTokens.listTokensForUsers([])).toEqual([]);

    const rows = await repos.deviceTokens.listTokensForUsers([a, b]);
    const byUser = new Map<string, string[]>();
    for (const r of rows) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r.token]);
    expect(byUser.get(a)).toEqual([ta]);
    expect((byUser.get(b) ?? []).sort()).toEqual([tb1, tb2].sort());
  });

  it("deleteForUser is scoped to the owner — cannot delete another user's token", async () => {
    const owner = await newUser("dt_own");
    const attacker = await newUser("dt_atk");
    const t = token();
    await repos.deviceTokens.upsert(owner, t, "ios");

    // Attacker presenting the owner's token deletes nothing.
    expect(await repos.deviceTokens.deleteForUser(attacker, t)).toBe(false);
    expect(await repos.deviceTokens.listForUser(owner)).toHaveLength(1);

    // The owner can remove it.
    expect(await repos.deviceTokens.deleteForUser(owner, t)).toBe(true);
    expect(await repos.deviceTokens.listForUser(owner)).toHaveLength(0);
    // Idempotent: deleting again is a no-op false.
    expect(await repos.deviceTokens.deleteForUser(owner, t)).toBe(false);
  });

  it("deleteByTokens prunes dead tokens regardless of owner (empty short-circuits)", async () => {
    const userId = await newUser("dt_dead");
    const t1 = token();
    const t2 = token();
    await repos.deviceTokens.upsert(userId, t1, "ios");
    await repos.deviceTokens.upsert(userId, t2, "android");

    expect(await repos.deviceTokens.deleteByTokens([])).toBe(0);

    const removed = await repos.deviceTokens.deleteByTokens([t1, t2, "ExponentPushToken[absent]"]);
    expect(removed).toBe(2);
    expect(await repos.deviceTokens.listForUser(userId)).toHaveLength(0);
  });

  it("deletes a user's tokens by FK cascade", async () => {
    const userId = await newUser("dt_cascade");
    const t = token();
    await repos.deviceTokens.upsert(userId, t, "ios");
    // Remove the user directly; the device row should vanish with it.
    await client.db.delete(schema.users).where(eq(schema.users.id, userId));
    expect(await repos.deviceTokens.deleteByTokens([t])).toBe(0);
  });
});

const redisUp = await isRedisUp();
if (!redisUp) {
  refuseToSkipIfRequired("redis");
  console.warn("[device-tokens.int.test] REDIS unreachable — skipping presence reader");
}

describe.skipIf(!redisUp)("RedisPresenceReader (live Redis)", () => {
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

  /** Simulate the gateway's write side: a live socket for `userId`. */
  async function connect(userId: string): Promise<void> {
    await redis.sadd(`${prefix}:conns:${userId}`, `conn-${Math.random().toString(36).slice(2)}`);
  }

  it("isOnline reflects a live connection", async () => {
    const reader = new RedisPresenceReader(redis, prefix);
    expect(await reader.isOnline("offline-user")).toBe(false);
    await connect("online-user");
    expect(await reader.isOnline("online-user")).toBe(true);
  });

  it("filterOffline returns only users with no live connection", async () => {
    const reader = new RedisPresenceReader(redis, prefix);
    await connect("on-1");
    await connect("on-2");
    // off-1 / off-2 never connect.
    const offline = await reader.filterOffline(["on-1", "off-1", "on-2", "off-2"]);
    expect(offline.sort()).toEqual(["off-1", "off-2"]);

    // Empty input short-circuits.
    expect(await reader.filterOffline([])).toEqual([]);
  });
});
