/**
 * M9 roles & permissions API integration tests — real Postgres from
 * docker-compose. Skipped automatically (with a console notice) when the
 * database is down.
 *
 * Covers (ADR 0007 / roles-implementation-plan §6):
 * - role CRUD + escalation guard matrix (grant/deny per bit; MANAGE_ROLES
 *   owner-only; assignment escalation)
 * - guest role-assignment rejected
 * - invite policy both modes ("members" / "roles")
 * - channel visibility filter: restricted channel hidden from the member list,
 *   and message list/send/media-token answer 404 (existence not leaked)
 * - kick permission (owner ∨ KICK_MEMBERS)
 * - message-delete moderation (owner ∨ MANAGE_MESSAGES)
 * - member DTO `roleIds`
 * - role endpoints 404 on flat group chats
 * - group-scoped events published on the mutation bus
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  applyMigrations,
  createDb,
  createRepositories,
  InMemoryMutationBus,
  type DbClient,
  type RealtimeMutation,
  type Repositories,
} from "@demli/db";
import { SERVER_EVENT } from "@demli/protocol";
import { PERMISSIONS } from "@demli/types";
import { buildApp } from "../app.js";
import { loadEnv } from "../env.js";
import { refuseToSkipIfRequired } from "@demli/db/testing";

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
  console.warn("[roles.int.test] DATABASE unreachable — skipping integration tests");
}

describe.skipIf(!dbUp)("m9 roles & permissions API", () => {
  let client: DbClient;
  let repos: Repositories;
  let app: FastifyInstance;
  let bus: InMemoryMutationBus;
  const published: RealtimeMutation[] = [];

  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const password = "correct-horse-9";

  // Shared users; each test spins up its own fresh server.
  let ownerToken: string;
  let aToken: string;
  let aId: string;
  let bToken: string;
  let bId: string;
  let guestId: string;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async function register(username: string, displayName: string) {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { username, password, displayName },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { token: string; user: { id: string } };
  }

  /** Fresh server owned by ownerToken, plus its auto #general text channel. */
  async function makeServer(name: string): Promise<{ serverId: string; generalId: string }> {
    const created = await app.inject({
      method: "POST",
      url: "/groups",
      headers: auth(ownerToken),
      payload: { name },
    });
    expect(created.statusCode).toBe(201);
    const serverId = created.json().group.id as string;
    const general = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/channels`,
      headers: auth(ownerToken),
      payload: { name: "general", kind: "text" },
    });
    expect(general.statusCode).toBe(201);
    return { serverId, generalId: general.json().channel.id as string };
  }

  /** Bring `token`'s user into `serverId` as a plain member (invite + redeem). */
  async function join(serverId: string, token: string): Promise<void> {
    const invite = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/invites`,
      headers: auth(ownerToken),
      payload: {},
    });
    expect(invite.statusCode).toBe(201);
    const redeem = await app.inject({
      method: "POST",
      url: `/invites/${invite.json().invite.code}/redeem`,
      headers: auth(token),
    });
    expect(redeem.statusCode).toBe(200);
  }

  async function createRole(
    serverId: string,
    token: string,
    body: { name: string; color?: string | null; permissions?: number },
  ) {
    return app.inject({
      method: "POST",
      url: `/groups/${serverId}/roles`,
      headers: auth(token),
      payload: body,
    });
  }

  async function setMemberRoles(
    serverId: string,
    targetId: string,
    token: string,
    roleIds: string[],
  ) {
    return app.inject({
      method: "PUT",
      url: `/groups/${serverId}/members/${targetId}/roles`,
      headers: auth(token),
      payload: { roleIds },
    });
  }

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);
    bus = new InMemoryMutationBus();
    await bus.subscribe((m) => published.push(m));
    app = await buildApp({ repos, env: loadEnv({ DATABASE_URL }), mutationBus: bus, logger: false });

    const owner = await register(`m9own_${suffix}`, "M9 Owner");
    const a = await register(`m9a_${suffix}`, "M9 A");
    const b = await register(`m9b_${suffix}`, "M9 B");
    const guest = await register(`m9g_${suffix}`, "M9 Guest");
    ownerToken = owner.token;
    aToken = a.token;
    aId = a.user.id;
    bToken = b.token;
    bId = b.user.id;
    guestId = guest.user.id;
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("creates roles (owner) and publishes role.created group-scoped", async () => {
    const { serverId } = await makeServer("M9 CRUD");
    published.length = 0;

    const res = await createRole(serverId, ownerToken, {
      name: "Moderator",
      color: "#22c55e",
      permissions: PERMISSIONS.MANAGE_MESSAGES | PERMISSIONS.KICK_MEMBERS,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().role.name).toBe("Moderator");
    expect(res.json().role.permissions).toBe(
      PERMISSIONS.MANAGE_MESSAGES | PERMISSIONS.KICK_MEMBERS,
    );

    const event = published.find(
      (m) => m.groupId === serverId && m.event.type === SERVER_EVENT.roleCreated,
    );
    expect(event).toBeDefined();
    // Group-scoped: no channelId on the mutation envelope.
    expect(event?.channelId).toBeUndefined();
  });

  it("rejects role management from a member without MANAGE_ROLES", async () => {
    const { serverId } = await makeServer("M9 NoPerm");
    await join(serverId, aToken);

    const res = await createRole(serverId, aToken, { name: "Nope" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  it("enforces the escalation guard: subset-only bits + MANAGE_ROLES owner-only", async () => {
    const { serverId } = await makeServer("M9 Escalation");
    await join(serverId, aToken); // A becomes a delegated admin

    // A holds MANAGE_ROLES + MANAGE_MESSAGES (but NOT KICK_MEMBERS).
    const staff = await createRole(serverId, ownerToken, {
      name: "Staff",
      permissions: PERMISSIONS.MANAGE_ROLES | PERMISSIONS.MANAGE_MESSAGES,
    });
    expect(staff.statusCode).toBe(201);
    expect(
      (await setMemberRoles(serverId, aId, ownerToken, [staff.json().role.id])).statusCode,
    ).toBe(200);

    // A may create a role with a bit it holds.
    const ok = await createRole(serverId, aToken, {
      name: "Helper",
      permissions: PERMISSIONS.MANAGE_MESSAGES,
    });
    expect(ok.statusCode).toBe(201);

    // A may NOT create a role with a bit it lacks (KICK_MEMBERS).
    const escalate = await createRole(serverId, aToken, {
      name: "Kicker",
      permissions: PERMISSIONS.KICK_MEMBERS,
    });
    expect(escalate.statusCode).toBe(403);

    // A holds MANAGE_ROLES but may NOT hand it out (owner-only distribution).
    const handOut = await createRole(serverId, aToken, {
      name: "MiniAdmin",
      permissions: PERMISSIONS.MANAGE_ROLES,
    });
    expect(handOut.statusCode).toBe(403);
  });

  it("blocks assigning a role whose bits exceed the actor's (assignment escalation)", async () => {
    const { serverId } = await makeServer("M9 AssignEsc");
    await join(serverId, aToken);
    await join(serverId, bToken);

    // A is a delegated role-manager holding only MANAGE_ROLES.
    const manager = await createRole(serverId, ownerToken, {
      name: "Manager",
      permissions: PERMISSIONS.MANAGE_ROLES,
    });
    await setMemberRoles(serverId, aId, ownerToken, [manager.json().role.id]);

    // A high role only the owner should be able to hand out.
    const kickers = await createRole(serverId, ownerToken, {
      name: "Kickers",
      permissions: PERMISSIONS.KICK_MEMBERS,
    });

    // A (MANAGE_ROLES only) cannot assign a KICK_MEMBERS role to B.
    const denied = await setMemberRoles(serverId, bId, aToken, [kickers.json().role.id]);
    expect(denied.statusCode).toBe(403);

    // The owner can.
    const ok = await setMemberRoles(serverId, bId, ownerToken, [kickers.json().role.id]);
    expect(ok.statusCode).toBe(200);
  });

  it("refuses to assign roles to a guest", async () => {
    const { serverId } = await makeServer("M9 Guest");
    // Guests never arrive via invite (they'd be members); insert one directly.
    await repos.groups.addMember(serverId, guestId, "guest");
    const role = await createRole(serverId, ownerToken, { name: "AnyRole" });

    const res = await setMemberRoles(serverId, guestId, ownerToken, [role.json().role.id]);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/guest/i);
  });

  it("assigns roles and exposes roleIds on the member DTO + publishes member.roles_updated", async () => {
    const { serverId } = await makeServer("M9 RoleIds");
    await join(serverId, aToken);
    const mod = await createRole(serverId, ownerToken, {
      name: "Mod",
      permissions: PERMISSIONS.MANAGE_MESSAGES,
    });
    const modId = mod.json().role.id as string;

    published.length = 0;
    const assign = await setMemberRoles(serverId, aId, ownerToken, [modId]);
    expect(assign.statusCode).toBe(200);
    expect(assign.json().roleIds).toEqual([modId]);

    expect(
      published.some(
        (m) => m.groupId === serverId && m.event.type === SERVER_EVENT.memberRolesUpdated,
      ),
    ).toBe(true);

    const details = await app.inject({
      method: "GET",
      url: `/groups/${serverId}`,
      headers: auth(ownerToken),
    });
    const member = (details.json().members as Array<{ userId: string; roleIds: string[] }>).find(
      (m) => m.userId === aId,
    );
    expect(member?.roleIds).toEqual([modId]);
  });

  it("honors invite policy: 'members' lets any member invite, 'roles' gates on CREATE_INVITE", async () => {
    const { serverId } = await makeServer("M9 InvitePolicy");
    await join(serverId, aToken);

    // Default policy "members": A (plain member) can create an invite.
    const asMember = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/invites`,
      headers: auth(aToken),
      payload: {},
    });
    expect(asMember.statusCode).toBe(201);

    // Switch to "roles" (owner only).
    const patch = await app.inject({
      method: "PATCH",
      url: `/groups/${serverId}`,
      headers: auth(ownerToken),
      payload: { invitePolicy: "roles" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().group.invitePolicy).toBe("roles");

    // A (no CREATE_INVITE) is now blocked.
    const blocked = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/invites`,
      headers: auth(aToken),
      payload: {},
    });
    expect(blocked.statusCode).toBe(403);

    // Grant CREATE_INVITE and A can invite again.
    const inviter = await createRole(serverId, ownerToken, {
      name: "Inviter",
      permissions: PERMISSIONS.CREATE_INVITE,
    });
    await setMemberRoles(serverId, aId, ownerToken, [inviter.json().role.id]);
    const allowed = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/invites`,
      headers: auth(aToken),
      payload: {},
    });
    expect(allowed.statusCode).toBe(201);

    // The owner can always invite regardless of policy.
    const asOwner = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/invites`,
      headers: auth(ownerToken),
      payload: {},
    });
    expect(asOwner.statusCode).toBe(201);
  });

  it("hides a restricted channel and 404s its messages/media until a role grants access", async () => {
    const { serverId, generalId } = await makeServer("M9 Visibility");
    await join(serverId, aToken);

    const staffText = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/channels`,
      headers: auth(ownerToken),
      payload: { name: "staff", kind: "text" },
    });
    const staffId = staffText.json().channel.id as string;
    const vault = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/channels`,
      headers: auth(ownerToken),
      payload: { name: "vault", kind: "voice" },
    });
    const vaultId = vault.json().channel.id as string;

    const mods = await createRole(serverId, ownerToken, { name: "Mods" });
    const modsId = mods.json().role.id as string;

    // Restrict both channels to Mods; publishes channel.access_changed.
    published.length = 0;
    const restrictText = await app.inject({
      method: "PUT",
      url: `/channels/${staffId}/access`,
      headers: auth(ownerToken),
      payload: { roleIds: [modsId] },
    });
    expect(restrictText.statusCode).toBe(200);
    await app.inject({
      method: "PUT",
      url: `/channels/${vaultId}/access`,
      headers: auth(ownerToken),
      payload: { roleIds: [modsId] },
    });
    expect(
      published.some(
        (m) => m.groupId === serverId && m.event.type === SERVER_EVENT.channelAccessChanged,
      ),
    ).toBe(true);

    // A (no role) cannot see the restricted channels.
    const detailsBefore = await app.inject({
      method: "GET",
      url: `/groups/${serverId}`,
      headers: auth(aToken),
    });
    const visibleIds = (detailsBefore.json().channels as Array<{ id: string }>).map((c) => c.id);
    expect(visibleIds).toContain(generalId);
    expect(visibleIds).not.toContain(staffId);
    expect(visibleIds).not.toContain(vaultId);

    // ...and every channel-scoped request answers a plain 404 (no leak).
    const listMsgs = await app.inject({
      method: "GET",
      url: `/channels/${staffId}/messages`,
      headers: auth(aToken),
    });
    expect(listMsgs.statusCode).toBe(404);
    const sendMsg = await app.inject({
      method: "POST",
      url: `/channels/${staffId}/messages`,
      headers: auth(aToken),
      payload: { content: "sneaking in" },
    });
    expect(sendMsg.statusCode).toBe(404);
    const token = await app.inject({
      method: "POST",
      url: "/media/token",
      headers: auth(aToken),
      payload: { channelId: vaultId },
    });
    expect(token.statusCode).toBe(404);

    // The owner sees the restricted channel, flagged.
    const ownerDetails = await app.inject({
      method: "GET",
      url: `/groups/${serverId}`,
      headers: auth(ownerToken),
    });
    const staffForOwner = (
      ownerDetails.json().channels as Array<{ id: string; restricted: boolean }>
    ).find((c) => c.id === staffId);
    expect(staffForOwner?.restricted).toBe(true);

    // Grant Mods to A → the channel appears and messages resolve.
    await setMemberRoles(serverId, aId, ownerToken, [modsId]);
    const detailsAfter = await app.inject({
      method: "GET",
      url: `/groups/${serverId}`,
      headers: auth(aToken),
    });
    const afterIds = (detailsAfter.json().channels as Array<{ id: string }>).map((c) => c.id);
    expect(afterIds).toContain(staffId);
    const listAfter = await app.inject({
      method: "GET",
      url: `/channels/${staffId}/messages`,
      headers: auth(aToken),
    });
    expect(listAfter.statusCode).toBe(200);
  });

  it("gates kick on owner ∨ KICK_MEMBERS and never kicks the owner", async () => {
    const { serverId } = await makeServer("M9 Kick");
    await join(serverId, aToken); // A = would-be kicker
    await join(serverId, bToken); // B = victim

    // A without KICK_MEMBERS cannot remove B.
    const denied = await app.inject({
      method: "DELETE",
      url: `/groups/${serverId}/members/${bId}`,
      headers: auth(aToken),
    });
    expect(denied.statusCode).toBe(403);

    // Grant A a KICK_MEMBERS role.
    const kicker = await createRole(serverId, ownerToken, {
      name: "Bouncer",
      permissions: PERMISSIONS.KICK_MEMBERS,
    });
    await setMemberRoles(serverId, aId, ownerToken, [kicker.json().role.id]);

    const kicked = await app.inject({
      method: "DELETE",
      url: `/groups/${serverId}/members/${bId}`,
      headers: auth(aToken),
    });
    expect(kicked.statusCode).toBe(204);

    // The owner is never kickable.
    const ownerId = (
      await app.inject({ method: "GET", url: `/groups/${serverId}`, headers: auth(ownerToken) })
    ).json().group.ownerId as string;
    const noOwner = await app.inject({
      method: "DELETE",
      url: `/groups/${serverId}/members/${ownerId}`,
      headers: auth(aToken),
    });
    expect(noOwner.statusCode).toBe(400);
  });

  it("gates deleting another member's message on owner ∨ MANAGE_MESSAGES", async () => {
    const { serverId, generalId } = await makeServer("M9 Moderate");
    await join(serverId, aToken); // author
    await join(serverId, bToken); // would-be moderator

    const msg = await app.inject({
      method: "POST",
      url: `/channels/${generalId}/messages`,
      headers: auth(aToken),
      payload: { content: "delete me" },
    });
    const messageId = msg.json().message.id as string;

    // B without MANAGE_MESSAGES cannot delete A's message.
    const denied = await app.inject({
      method: "DELETE",
      url: `/messages/${messageId}`,
      headers: auth(bToken),
    });
    expect(denied.statusCode).toBe(403);

    // Grant B MANAGE_MESSAGES → allowed.
    const modRole = await createRole(serverId, ownerToken, {
      name: "Cleaner",
      permissions: PERMISSIONS.MANAGE_MESSAGES,
    });
    await setMemberRoles(serverId, bId, ownerToken, [modRole.json().role.id]);
    const moderated = await app.inject({
      method: "DELETE",
      url: `/messages/${messageId}`,
      headers: auth(bToken),
    });
    expect(moderated.statusCode).toBe(204);
  });

  it("404s every role endpoint on a flat group chat", async () => {
    const chat = await app.inject({
      method: "POST",
      url: "/group-chats",
      headers: auth(ownerToken),
      payload: { name: "M9 Flat" },
    });
    expect(chat.statusCode).toBe(201);
    const chatId = chat.json().group.id as string;

    const list = await app.inject({
      method: "GET",
      url: `/groups/${chatId}/roles`,
      headers: auth(ownerToken),
    });
    expect(list.statusCode).toBe(404);

    const create = await app.inject({
      method: "POST",
      url: `/groups/${chatId}/roles`,
      headers: auth(ownerToken),
      payload: { name: "Nope" },
    });
    expect(create.statusCode).toBe(404);
  });
});
