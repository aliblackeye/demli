/**
 * Migration 0013 — notification-mutes repo integration tests (real Postgres from
 * docker-compose; auto-skips when unreachable). `applyMigrations` in beforeAll
 * also proves migration 0013 applies cleanly. Covers setMute upsert, clearMute
 * idempotency, listForUser, and the push-filter primitive
 * `listActiveForRecipients` including the `until` expiry predicate.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, createDb, createRepositories, type DbClient, type Repositories } from "../index.js";
import { refuseToSkipIfRequired } from "../testing.js";

const DATABASE_URL =
  process.env["DATABASE_URL"] ?? "postgresql://postgres:postgres@localhost:5432/demli";

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

function uniq(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

const dbUp = await isDbUp();
if (!dbUp) {
  refuseToSkipIfRequired("postgres");
  console.warn("[notification-mutes.int.test] DATABASE unreachable — skipping");
}

describe.skipIf(!dbUp)("notificationMutesRepo (live Postgres)", () => {
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

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);
  });

  afterAll(async () => {
    await client?.close();
  });

  it("setMute inserts a channel mute and listForUser returns it", async () => {
    const userId = await newUser("nm_set");
    const targetId = randomUUID();
    const mute = await repos.notificationMutes.setMute({
      userId,
      scope: "channel",
      targetId,
      mode: "all",
      until: null,
    });
    expect(mute).toMatchObject({ userId, scope: "channel", targetId, mode: "all", until: null });
    expect(mute.updatedAt).toBeNull();

    const list = await repos.notificationMutes.listForUser(userId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ scope: "channel", targetId, mode: "all" });
  });

  it("setMute upserts on (user, scope, target) — changes mode/until, sets updatedAt", async () => {
    const userId = await newUser("nm_up");
    const targetId = randomUUID();
    await repos.notificationMutes.setMute({
      userId,
      scope: "group",
      targetId,
      mode: "all",
      until: null,
    });
    const until = new Date(Date.now() + 60 * 60 * 1000);
    const updated = await repos.notificationMutes.setMute({
      userId,
      scope: "group",
      targetId,
      mode: "mentions",
      until,
    });
    expect(updated.mode).toBe("mentions");
    expect(updated.until).toBe(until.toISOString());
    expect(updated.updatedAt).not.toBeNull();

    // Still ONE row (upsert, not a second insert).
    expect(await repos.notificationMutes.listForUser(userId)).toHaveLength(1);
  });

  it("clearMute is idempotent (true then false) and scoped to the user", async () => {
    const userId = await newUser("nm_clr");
    const other = await newUser("nm_other");
    const targetId = randomUUID();
    await repos.notificationMutes.setMute({
      userId,
      scope: "channel",
      targetId,
      mode: "all",
      until: null,
    });

    // A different user cannot clear it.
    expect(await repos.notificationMutes.clearMute(other, "channel", targetId)).toBe(false);
    expect(await repos.notificationMutes.listForUser(userId)).toHaveLength(1);

    expect(await repos.notificationMutes.clearMute(userId, "channel", targetId)).toBe(true);
    expect(await repos.notificationMutes.clearMute(userId, "channel", targetId)).toBe(false);
    expect(await repos.notificationMutes.listForUser(userId)).toHaveLength(0);
  });

  it("listActiveForRecipients matches channel- and group-scope targets", async () => {
    const alice = await newUser("nm_a");
    const bob = await newUser("nm_b");
    const channelId = randomUUID();
    const groupId = randomUUID();
    await repos.notificationMutes.setMute({
      userId: alice,
      scope: "channel",
      targetId: channelId,
      mode: "all",
      until: null,
    });
    await repos.notificationMutes.setMute({
      userId: bob,
      scope: "group",
      targetId: groupId,
      mode: "mentions",
      until: null,
    });

    const rows = await repos.notificationMutes.listActiveForRecipients({
      userIds: [alice, bob],
      channelId,
      groupId,
    });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.userId === alice)).toMatchObject({ scope: "channel", mode: "all" });
    expect(rows.find((r) => r.userId === bob)).toMatchObject({ scope: "group", mode: "mentions" });
  });

  it("listActiveForRecipients excludes an EXPIRED mute (until in the past)", async () => {
    const userId = await newUser("nm_exp");
    const channelId = randomUUID();
    const groupId = randomUUID();
    const past = new Date(Date.now() - 60 * 1000);
    await repos.notificationMutes.setMute({
      userId,
      scope: "channel",
      targetId: channelId,
      mode: "all",
      until: past,
    });

    // Active as of a moment before it expired…
    const beforeExpiry = await repos.notificationMutes.listActiveForRecipients({
      userIds: [userId],
      channelId,
      groupId,
      now: new Date(past.getTime() - 1000),
    });
    expect(beforeExpiry).toHaveLength(1);

    // …but not now (past the expiry).
    const nowRows = await repos.notificationMutes.listActiveForRecipients({
      userIds: [userId],
      channelId,
      groupId,
    });
    expect(nowRows).toHaveLength(0);

    // The row is NOT deleted — it still shows in the full list.
    expect(await repos.notificationMutes.listForUser(userId)).toHaveLength(1);
  });

  it("listActiveForRecipients short-circuits on empty inputs", async () => {
    expect(
      await repos.notificationMutes.listActiveForRecipients({ userIds: [], channelId: randomUUID() }),
    ).toEqual([]);
    // No target at all ⇒ nothing can match.
    const userId = await newUser("nm_notgt");
    expect(
      await repos.notificationMutes.listActiveForRecipients({ userIds: [userId] }),
    ).toEqual([]);
  });
});
