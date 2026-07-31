/**
 * Server-ban repo + invite ban-gate integration tests (migration 0017) — real
 * Postgres. Skipped automatically (with a console notice) when the database is
 * down.
 *
 * Covers:
 * - groupBansRepo ban/unban/isBanned/listForGroup round-trip + idempotent re-ban
 * - the ban gate inside invitesRepo.redeem: a banned user cannot rejoin via a
 *   valid invite (reason "banned"), and unbanning restores access
 * - FK cascade: deleting the group reaps its bans
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createDb,
  createRepositories,
  type DbClient,
  type Repositories,
} from "../index.js";
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

const dbUp = await isDbUp();
if (!dbUp) {
  refuseToSkipIfRequired("postgres");
  console.warn("[group-bans.int.test] DATABASE unreachable — skipping");
}

const RUN = randomUUID().slice(0, 8);

describe.skipIf(!dbUp)("group bans (repo + invite gate)", () => {
  let client: DbClient;
  let repos: Repositories;
  let uniq = 0;

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);
  });

  afterAll(async () => {
    await client?.close();
  });

  async function makeUser(label: string): Promise<string> {
    uniq += 1;
    const u = await repos.users.create({
      username: `${label}_${RUN}${uniq.toString(36)}`,
      displayName: label,
      passwordHash: "not-used",
    });
    return u.id;
  }

  async function makeServer(): Promise<{ groupId: string; ownerId: string }> {
    const ownerId = await makeUser("banowner");
    const group = await repos.groups.create({ name: "Ban Test", ownerId });
    return { groupId: group.id, ownerId };
  }

  it("ban → isBanned true; unban → isBanned false", async () => {
    const { groupId, ownerId } = await makeServer();
    const target = await makeUser("target");

    expect(await repos.groupBans.isBanned(groupId, target)).toBe(false);

    const ban = await repos.groupBans.ban({
      groupId,
      userId: target,
      bannedBy: ownerId,
      reason: "spam",
    });
    expect(ban).toMatchObject({ groupId, userId: target, bannedBy: ownerId, reason: "spam" });
    expect(await repos.groupBans.isBanned(groupId, target)).toBe(true);

    expect(await repos.groupBans.unban(groupId, target)).toBe(true);
    expect(await repos.groupBans.isBanned(groupId, target)).toBe(false);
    // Unbanning a user who is not banned is a no-op false.
    expect(await repos.groupBans.unban(groupId, target)).toBe(false);
  });

  it("re-ban upserts (idempotent, refreshes reason) — never duplicates", async () => {
    const { groupId, ownerId } = await makeServer();
    const target = await makeUser("target");

    await repos.groupBans.ban({ groupId, userId: target, bannedBy: ownerId, reason: "one" });
    await repos.groupBans.ban({ groupId, userId: target, bannedBy: ownerId, reason: "two" });

    const bans = await repos.groupBans.listForGroup(groupId);
    expect(bans).toHaveLength(1);
    expect(bans[0]?.reason).toBe("two");
    // The list hydrates the banned user for the moderation UI.
    expect(bans[0]?.user.id).toBe(target);
  });

  it("blocks rejoin via a valid invite (redeem → reason 'banned')", async () => {
    const { groupId, ownerId } = await makeServer();
    const target = await makeUser("target");
    const invite = await repos.invites.create({
      groupId,
      createdBy: ownerId,
      expiresAt: null,
      maxUses: null,
    });

    await repos.groupBans.ban({ groupId, userId: target, bannedBy: ownerId, reason: null });

    const banned = await repos.invites.redeem(invite.code, target);
    expect(banned).toEqual({ ok: false, reason: "banned" });
    // Still not a member (the ban gate ran before the membership insert).
    expect(await repos.groups.getMembership(groupId, target)).toBeNull();

    // Unban → the same invite now works.
    await repos.groupBans.unban(groupId, target);
    const ok = await repos.invites.redeem(invite.code, target);
    expect(ok.ok).toBe(true);
    expect(await repos.groups.getMembership(groupId, target)).not.toBeNull();
  });

  it("deleting the group cascades its bans away", async () => {
    const { groupId, ownerId } = await makeServer();
    const target = await makeUser("target");
    await repos.groupBans.ban({ groupId, userId: target, bannedBy: ownerId });
    expect(await repos.groupBans.isBanned(groupId, target)).toBe(true);

    await repos.groups.delete(groupId);
    expect(await repos.groupBans.isBanned(groupId, target)).toBe(false);
  });
});
