/**
 * M9 roles/permissions repo-level integration tests — real Postgres.
 * Skipped automatically (with a console notice) when the database is down.
 *
 * Covers migration 0005 + rolesRepo/channelAccessRepo:
 * - effectivePermissions = bitwise OR of held roles (and the empty case)
 * - composite-FK cleanup (member leaves / role deleted) and cross-group /
 *   non-member rejection
 * - visibleChannelIdsForUser combinations (public / restricted / owner / multi-role
 *   / non-member) and setChannelRoles replace semantics
 * - invite_policy default + update
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSIONS } from "@demli/types";
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
  console.warn("[roles.int.test] DATABASE unreachable — skipping");
}

/**
 * Per-file random tag. Test files run in parallel workers against ONE shared
 * Postgres, so a fixture id must be unique across files, not just within one.
 * `Date.now()` + a small counter is NOT enough — two files can mint the same
 * millisecond and counter value and collide on `users_username_unique`. This
 * UUID tag gives every username in this file its own namespace.
 */
const RUN = randomUUID().slice(0, 8);

describe.skipIf(!dbUp)("m9 roles & permissions (repo level)", () => {
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

  /** Distinct username each call so parallel/repeat runs never collide. */
  async function makeUser(label: string): Promise<string> {
    uniq += 1;
    const suffix = `${RUN}${uniq.toString(36)}`;
    const u = await repos.users.create({
      username: `${label}_${suffix}`,
      displayName: label,
      passwordHash: "not-used",
    });
    return u.id;
  }

  /** A server owned by a fresh user; returns the group id + owner id. */
  async function makeServer(): Promise<{ groupId: string; ownerId: string }> {
    const ownerId = await makeUser("owner");
    const group = await repos.groups.create({ name: "Role Test", ownerId });
    return { groupId: group.id, ownerId };
  }

  // ---- effectivePermissions -------------------------------------------------

  it("effectivePermissions ORs every held role; empty set is 0", async () => {
    const { groupId } = await makeServer();
    const member = await makeUser("member");
    await repos.groups.addMember(groupId, member, "member");

    expect(await repos.roles.effectivePermissions(groupId, member)).toBe(0);

    const modMsgs = await repos.roles.create({
      groupId,
      name: "MsgMod",
      permissions: PERMISSIONS.MANAGE_MESSAGES,
    });
    const kicker = await repos.roles.create({
      groupId,
      name: "Kicker",
      permissions: PERMISSIONS.KICK_MEMBERS,
    });
    await repos.roles.assign(groupId, member, modMsgs.id);
    await repos.roles.assign(groupId, member, kicker.id);

    expect(await repos.roles.effectivePermissions(groupId, member)).toBe(
      PERMISSIONS.MANAGE_MESSAGES | PERMISSIONS.KICK_MEMBERS,
    );

    const held = await repos.roles.rolesForMember(groupId, member);
    expect(held.map((r) => r.name).sort()).toEqual(["Kicker", "MsgMod"]);
  });

  it("persists a large permission bitfield exactly (bigint round-trip)", async () => {
    const { groupId } = await makeServer();
    const all =
      PERMISSIONS.MANAGE_CHANNELS |
      PERMISSIONS.MANAGE_MESSAGES |
      PERMISSIONS.KICK_MEMBERS |
      PERMISSIONS.CREATE_INVITE |
      PERMISSIONS.MANAGE_ROLES;
    const role = await repos.roles.create({ groupId, name: "Admin", permissions: all });
    const back = await repos.roles.findById(role.id);
    expect(back?.permissions).toBe(all);
    expect(typeof back?.permissions).toBe("number");
  });

  // ---- composite-FK cleanup + rejection ------------------------------------

  it("removes a member's role assignments when they leave the group", async () => {
    const { groupId } = await makeServer();
    const member = await makeUser("leaver");
    await repos.groups.addMember(groupId, member, "member");
    const role = await repos.roles.create({ groupId, name: "Temp", permissions: 0 });
    await repos.roles.assign(groupId, member, role.id);
    expect(await repos.roles.roleIdsForMember(groupId, member)).toEqual([role.id]);

    await repos.groups.removeMember(groupId, member);

    expect(await repos.roles.roleIdsForMember(groupId, member)).toEqual([]);
    // The role itself survives — only the assignment cascaded.
    expect(await repos.roles.findById(role.id)).not.toBeNull();
  });

  it("removes assignments AND channel access when a role is deleted", async () => {
    const { groupId } = await makeServer();
    const member = await makeUser("holder");
    await repos.groups.addMember(groupId, member, "member");
    const role = await repos.roles.create({ groupId, name: "Doomed", permissions: 0 });
    const channel = await repos.channels.create({ groupId, kind: "text", name: "locked" });
    await repos.roles.assign(groupId, member, role.id);
    await repos.channelAccess.setChannelRoles(groupId, channel.id, [role.id]);
    expect(await repos.channelAccess.isRestricted(channel.id)).toBe(true);

    await repos.roles.delete(role.id);

    expect(await repos.roles.roleIdsForMember(groupId, member)).toEqual([]);
    expect(await repos.channelAccess.roleIdsForChannel(channel.id)).toEqual([]);
    // With its only access row gone, the channel is public again.
    expect(await repos.channelAccess.isRestricted(channel.id)).toBe(false);
  });

  it("rejects assigning a role across servers (composite FK)", async () => {
    const a = await makeServer();
    const b = await makeServer();
    const member = await makeUser("crossmember");
    await repos.groups.addMember(b.groupId, member, "member");
    const roleInA = await repos.roles.create({ groupId: a.groupId, name: "A-only", permissions: 0 });

    // member IS in B, but the role belongs to A → role/group FK fails.
    await expect(repos.roles.assign(b.groupId, member, roleInA.id)).rejects.toThrow();
  });

  it("rejects assigning a role to a non-member (composite FK)", async () => {
    const { groupId } = await makeServer();
    const outsider = await makeUser("outsider");
    const role = await repos.roles.create({ groupId, name: "Ghost", permissions: 0 });

    await expect(repos.roles.assign(groupId, outsider, role.id)).rejects.toThrow();
  });

  // ---- setMemberRoles replace semantics ------------------------------------

  it("setMemberRoles replaces the member's full role set", async () => {
    const { groupId } = await makeServer();
    const member = await makeUser("swapper");
    await repos.groups.addMember(groupId, member, "member");
    const r1 = await repos.roles.create({ groupId, name: "R1", permissions: 0 });
    const r2 = await repos.roles.create({ groupId, name: "R2", permissions: 0 });
    const r3 = await repos.roles.create({ groupId, name: "R3", permissions: 0 });

    await repos.roles.setMemberRoles(groupId, member, [r1.id, r2.id]);
    expect((await repos.roles.roleIdsForMember(groupId, member)).sort()).toEqual(
      [r1.id, r2.id].sort(),
    );

    await repos.roles.setMemberRoles(groupId, member, [r3.id]);
    expect(await repos.roles.roleIdsForMember(groupId, member)).toEqual([r3.id]);

    await repos.roles.setMemberRoles(groupId, member, []);
    expect(await repos.roles.roleIdsForMember(groupId, member)).toEqual([]);
  });

  // ---- reorder --------------------------------------------------------------

  it("reorder rewrites positions by array index, scoped to the group", async () => {
    const { groupId } = await makeServer();
    const a = await repos.roles.create({ groupId, name: "Alpha", permissions: 0 });
    const b = await repos.roles.create({ groupId, name: "Bravo", permissions: 0 });
    const c = await repos.roles.create({ groupId, name: "Charlie", permissions: 0 });

    const reordered = await repos.roles.reorder(groupId, [c.id, a.id, b.id]);
    expect(reordered.map((r) => r.name)).toEqual(["Charlie", "Alpha", "Bravo"]);
    expect(reordered.map((r) => r.position)).toEqual([0, 1, 2]);
  });

  // ---- visibility -----------------------------------------------------------

  it("visibleChannelIdsForUser: public to all, restricted to role holders, all to owner", async () => {
    const { groupId, ownerId } = await makeServer();
    const inRole = await makeUser("insider");
    const noRole = await makeUser("plainmember");
    const stranger = await makeUser("stranger");
    await repos.groups.addMember(groupId, inRole, "member");
    await repos.groups.addMember(groupId, noRole, "member");

    const general = await repos.channels.create({ groupId, kind: "text", name: "general" });
    const staff = await repos.channels.create({ groupId, kind: "text", name: "staff" });

    const mod = await repos.roles.create({ groupId, name: "Mod", permissions: 0 });
    await repos.roles.assign(groupId, inRole, mod.id);
    await repos.channelAccess.setChannelRoles(groupId, staff.id, [mod.id]);

    const ownerSees = await repos.channelAccess.visibleChannelIdsForUser(groupId, ownerId);
    expect(ownerSees).toContain(general.id);
    expect(ownerSees).toContain(staff.id);

    const inRoleSees = await repos.channelAccess.visibleChannelIdsForUser(groupId, inRole);
    expect(inRoleSees).toContain(general.id);
    expect(inRoleSees).toContain(staff.id);

    const noRoleSees = await repos.channelAccess.visibleChannelIdsForUser(groupId, noRole);
    expect(noRoleSees).toContain(general.id);
    expect(noRoleSees).not.toContain(staff.id);

    // Non-member sees nothing, not even public channels.
    expect(await repos.channelAccess.visibleChannelIdsForUser(groupId, stranger)).toEqual([]);

    // Single-channel guard mirrors the list.
    expect(await repos.channelAccess.canUserSeeChannel(groupId, staff.id, noRole)).toBe(false);
    expect(await repos.channelAccess.canUserSeeChannel(groupId, staff.id, inRole)).toBe(true);
  });

  it("visibility matches when a channel lists ANY of several roles", async () => {
    const { groupId } = await makeServer();
    const member = await makeUser("multi");
    await repos.groups.addMember(groupId, member, "member");
    const r1 = await repos.roles.create({ groupId, name: "One", permissions: 0 });
    const r2 = await repos.roles.create({ groupId, name: "Two", permissions: 0 });
    const secret = await repos.channels.create({ groupId, kind: "text", name: "secret" });
    await repos.channelAccess.setChannelRoles(groupId, secret.id, [r1.id, r2.id]);

    // Holds only r2 — still visible because the channel lists r2.
    await repos.roles.assign(groupId, member, r2.id);
    expect(
      await repos.channelAccess.visibleChannelIdsForUser(groupId, member),
    ).toContain(secret.id);
  });

  it("setChannelRoles([]) makes a restricted channel public again", async () => {
    const { groupId } = await makeServer();
    const member = await makeUser("watcher");
    await repos.groups.addMember(groupId, member, "member");
    const role = await repos.roles.create({ groupId, name: "Gate", permissions: 0 });
    const channel = await repos.channels.create({ groupId, kind: "text", name: "gated" });

    await repos.channelAccess.setChannelRoles(groupId, channel.id, [role.id]);
    expect(
      await repos.channelAccess.visibleChannelIdsForUser(groupId, member),
    ).not.toContain(channel.id);
    expect(await repos.channelAccess.restrictedChannelIds(groupId)).toContain(channel.id);

    await repos.channelAccess.setChannelRoles(groupId, channel.id, []);
    expect(
      await repos.channelAccess.visibleChannelIdsForUser(groupId, member),
    ).toContain(channel.id);
    expect(await repos.channelAccess.restrictedChannelIds(groupId)).not.toContain(channel.id);
  });

  it("setChannelRoles replaces the access list", async () => {
    const { groupId } = await makeServer();
    const role1 = await repos.roles.create({ groupId, name: "First", permissions: 0 });
    const role2 = await repos.roles.create({ groupId, name: "Second", permissions: 0 });
    const channel = await repos.channels.create({ groupId, kind: "text", name: "swap" });

    await repos.channelAccess.setChannelRoles(groupId, channel.id, [role1.id]);
    expect(await repos.channelAccess.roleIdsForChannel(channel.id)).toEqual([role1.id]);

    await repos.channelAccess.setChannelRoles(groupId, channel.id, [role2.id]);
    expect(await repos.channelAccess.roleIdsForChannel(channel.id)).toEqual([role2.id]);
  });

  // ---- invite policy --------------------------------------------------------

  it("invite_policy defaults to 'members' and can be switched to 'roles'", async () => {
    const { groupId } = await makeServer();
    expect((await repos.groups.findById(groupId))?.invitePolicy).toBe("members");

    await repos.groups.update(groupId, { invitePolicy: "roles" });
    expect((await repos.groups.findById(groupId))?.invitePolicy).toBe("roles");

    await repos.groups.update(groupId, { invitePolicy: "members" });
    expect((await repos.groups.findById(groupId))?.invitePolicy).toBe("members");
  });
});
