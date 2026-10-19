/**
 * Server-moderation API integration tests (migration 0017) — real Postgres from
 * docker-compose. Skipped automatically (with a console notice) when the database
 * is down.
 *
 * Covers the kick / ban / unban / list-bans / voice-disconnect endpoints:
 * - permission gate (owner ∨ KICK_MEMBERS) on every action
 * - owner-immunity + self-target rejection
 * - kick removes membership + publishes member.left (group) + member.kicked (user)
 * - ban removes membership + records a group_bans row + blocks rejoin (GROUP_BANNED)
 * - unban restores rejoin; list-bans hydrates the banned user
 * - voice-disconnect force-removes the SFU participant (injected fake) + publishes
 *   voice.disconnected (user-scoped) WITHOUT touching membership
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
  console.warn("[moderation.int.test] DATABASE unreachable — skipping integration tests");
}

describe.skipIf(!dbUp)("server moderation API", () => {
  let client: DbClient;
  let repos: Repositories;
  let app: FastifyInstance;
  let bus: InMemoryMutationBus;
  const published: RealtimeMutation[] = [];
  const removeParticipant = vi.fn().mockResolvedValue(undefined);

  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const password = "correct-horse-9";

  let ownerToken: string;
  let ownerId: string;
  let aToken: string;
  let aId: string;
  let bToken: string;
  let bId: string;

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

  async function makeServer(name: string): Promise<string> {
    const created = await app.inject({
      method: "POST",
      url: "/groups",
      headers: auth(ownerToken),
      payload: { name },
    });
    expect(created.statusCode).toBe(201);
    return created.json().group.id as string;
  }

  async function makeVoiceChannel(serverId: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/channels`,
      headers: auth(ownerToken),
      payload: { name: "lobby", kind: "voice" },
    });
    expect(res.statusCode).toBe(201);
    return res.json().channel.id as string;
  }

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

  /** Grant `targetId` a KICK_MEMBERS role in `serverId`. */
  async function grantKick(serverId: string, targetId: string): Promise<void> {
    const role = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/roles`,
      headers: auth(ownerToken),
      payload: { name: "mods", permissions: PERMISSIONS.KICK_MEMBERS },
    });
    expect(role.statusCode).toBe(201);
    const assign = await app.inject({
      method: "PUT",
      url: `/groups/${serverId}/members/${targetId}/roles`,
      headers: auth(ownerToken),
      payload: { roleIds: [role.json().role.id] },
    });
    expect(assign.statusCode).toBe(200);
  }

  function findEvent(
    predicate: (m: RealtimeMutation) => boolean,
  ): RealtimeMutation | undefined {
    return published.find(predicate);
  }

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);
    bus = new InMemoryMutationBus();
    await bus.subscribe((m) => published.push(m));
    app = await buildApp({
      repos,
      env: loadEnv({ DATABASE_URL }),
      mutationBus: bus,
      voiceModerator: { removeParticipant },
      logger: false,
    });

    const owner = await register(`mod_own_${suffix}`, "Mod Owner");
    const a = await register(`mod_a_${suffix}`, "Mod A");
    const b = await register(`mod_b_${suffix}`, "Mod B");
    ownerToken = owner.token;
    ownerId = owner.user.id;
    aToken = a.token;
    aId = a.user.id;
    bToken = b.token;
    bId = b.user.id;
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  // --- Kick ------------------------------------------------------------------

  it("owner kicks a member → 204, membership gone, member.left + member.kicked", async () => {
    const serverId = await makeServer("Kick OK");
    await join(serverId, bToken);
    published.length = 0;

    const res = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/members/${bId}/kick`,
      headers: auth(ownerToken),
    });
    expect(res.statusCode).toBe(204);
    expect(await repos.groups.getMembership(serverId, bId)).toBeNull();

    // Group-scoped member.left (the gateway's surgery) …
    const left = findEvent(
      (m) => m.groupId === serverId && m.event.type === SERVER_EVENT.memberLeft,
    );
    expect(left).toBeDefined();
    // … plus the user-scoped member.kicked notice.
    const kicked = findEvent(
      (m) => m.userId === bId && m.event.type === SERVER_EVENT.memberKicked,
    );
    expect(kicked).toBeDefined();
    if (kicked?.event.type === SERVER_EVENT.memberKicked) {
      expect(kicked.event.payload.groupId).toBe(serverId);
      expect(kicked.event.payload.groupName).toBe("Kick OK");
    }
  });

  it("a plain member cannot kick (403); with KICK_MEMBERS they can (204)", async () => {
    const serverId = await makeServer("Kick Perm");
    await join(serverId, aToken); // would-be kicker
    await join(serverId, bToken); // victim

    const denied = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/members/${bId}/kick`,
      headers: auth(aToken),
    });
    expect(denied.statusCode).toBe(403);
    expect(await repos.groups.getMembership(serverId, bId)).not.toBeNull();

    await grantKick(serverId, aId);
    const ok = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/members/${bId}/kick`,
      headers: auth(aToken),
    });
    expect(ok.statusCode).toBe(204);
  });

  it("never kicks the owner (403) and never yourself (400)", async () => {
    const serverId = await makeServer("Kick Guards");
    await join(serverId, aToken);
    await grantKick(serverId, aId);

    const owner = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/members/${ownerId}/kick`,
      headers: auth(aToken),
    });
    expect(owner.statusCode).toBe(403);
    expect(await repos.groups.getMembership(serverId, ownerId)).not.toBeNull();

    const self = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/members/${aId}/kick`,
      headers: auth(aToken),
    });
    expect(self.statusCode).toBe(400);
  });

  it("kicking a non-member is 404", async () => {
    const serverId = await makeServer("Kick 404");
    const res = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/members/${bId}/kick`,
      headers: auth(ownerToken),
    });
    expect(res.statusCode).toBe(404);
  });

  // --- Ban / unban / list ----------------------------------------------------

  it("owner bans a member → 201, membership gone, blocks rejoin, then unban restores", async () => {
    const serverId = await makeServer("Ban Flow");
    await join(serverId, bToken);
    published.length = 0;

    const ban = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/bans`,
      headers: auth(ownerToken),
      payload: { userId: bId, reason: "spam" },
    });
    expect(ban.statusCode).toBe(201);
    expect(ban.json().ban).toMatchObject({ groupId: serverId, userId: bId, reason: "spam" });
    expect(await repos.groups.getMembership(serverId, bId)).toBeNull();

    expect(
      findEvent((m) => m.groupId === serverId && m.event.type === SERVER_EVENT.memberLeft),
    ).toBeDefined();
    expect(
      findEvent((m) => m.userId === bId && m.event.type === SERVER_EVENT.memberBanned),
    ).toBeDefined();

    // A banned user cannot rejoin via a fresh, valid invite.
    const invite = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/invites`,
      headers: auth(ownerToken),
      payload: {},
    });
    const blocked = await app.inject({
      method: "POST",
      url: `/invites/${invite.json().invite.code}/redeem`,
      headers: auth(bToken),
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe("GROUP_BANNED");

    // List shows the ban with the hydrated user.
    const list = await app.inject({
      method: "GET",
      url: `/groups/${serverId}/bans`,
      headers: auth(ownerToken),
    });
    expect(list.statusCode).toBe(200);
    const bans = list.json().bans as Array<{ userId: string; user: { id: string } }>;
    expect(bans.some((x) => x.userId === bId && x.user.id === bId)).toBe(true);

    // Unban → the same invite now works.
    const unban = await app.inject({
      method: "DELETE",
      url: `/groups/${serverId}/bans/${bId}`,
      headers: auth(ownerToken),
    });
    expect(unban.statusCode).toBe(204);
    const rejoin = await app.inject({
      method: "POST",
      url: `/invites/${invite.json().invite.code}/redeem`,
      headers: auth(bToken),
    });
    expect(rejoin.statusCode).toBe(200);
  });

  it("ban is permission-gated (plain member → 403) and owner-immune (403)", async () => {
    const serverId = await makeServer("Ban Perm");
    await join(serverId, aToken);
    await join(serverId, bToken);

    const denied = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/bans`,
      headers: auth(aToken),
      payload: { userId: bId },
    });
    expect(denied.statusCode).toBe(403);
    expect(await repos.groupBans.isBanned(serverId, bId)).toBe(false);

    await grantKick(serverId, aId);
    const owner = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/bans`,
      headers: auth(aToken),
      payload: { userId: ownerId },
    });
    expect(owner.statusCode).toBe(403);
  });

  it("unban of a non-banned user is 404", async () => {
    const serverId = await makeServer("Unban 404");
    const res = await app.inject({
      method: "DELETE",
      url: `/groups/${serverId}/bans/${bId}`,
      headers: auth(ownerToken),
    });
    expect(res.statusCode).toBe(404);
  });

  // --- Media teardown on removal ---------------------------------------------

  it("kick, ban, timeout and owner-removal force the target out of the server's voice rooms", async () => {
    // Its OWN target, not the shared `b`. POST /invites/:code/redeem is limited
    // to 10 per user per minute (invites module), and this test alone redeems
    // three times: on top of the eight redeems the other tests already make as
    // `b`, the next `join(…, bToken)` in this file was the 11th inside the same
    // minute and got 429 — the limiter working, the fixture over budget.
    const target = await register(`mod_ev_${suffix}`, "Mod Evict");
    const targetId = target.user.id;
    const targetToken = target.token;

    const serverId = await makeServer("Evict");
    const lobby = await makeVoiceChannel(serverId);
    const rooms = (await repos.channels.listVoiceRoomsForGroup(serverId)).map((r) => r.room);
    expect(rooms).toContain(lobby);

    const removedRooms = () =>
      removeParticipant.mock.calls
        .filter(([, identity]) => identity === targetId)
        .map(([room]) => room);

    await join(serverId, targetToken);
    removeParticipant.mockClear();
    const timeout = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/members/${targetId}/timeout`,
      headers: auth(ownerToken),
      payload: { minutes: 5 },
    });
    expect(timeout.statusCode).toBe(200);
    expect(removedRooms().sort()).toEqual([...rooms].sort());

    removeParticipant.mockClear();
    const kick = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/members/${targetId}/kick`,
      headers: auth(ownerToken),
    });
    expect(kick.statusCode).toBe(204);
    expect(removedRooms().sort()).toEqual([...rooms].sort());

    await join(serverId, targetToken);
    removeParticipant.mockClear();
    const removal = await app.inject({
      method: "DELETE",
      url: `/groups/${serverId}/members/${targetId}`,
      headers: auth(ownerToken),
    });
    expect(removal.statusCode).toBe(204);
    expect(removedRooms().sort()).toEqual([...rooms].sort());

    await join(serverId, targetToken);
    removeParticipant.mockClear();
    const ban = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/bans`,
      headers: auth(ownerToken),
      payload: { userId: targetId },
    });
    expect(ban.statusCode).toBe(201);
    expect(removedRooms().sort()).toEqual([...rooms].sort());

    await app.inject({
      method: "DELETE",
      url: `/groups/${serverId}/bans/${targetId}`,
      headers: auth(ownerToken),
    });
  });

  // --- Voice disconnect ------------------------------------------------------

  it("owner disconnects a member from voice → 204, SFU removeParticipant + voice.disconnected, membership intact", async () => {
    const serverId = await makeServer("VD OK");
    const channelId = await makeVoiceChannel(serverId);
    await join(serverId, bToken);
    published.length = 0;
    removeParticipant.mockClear();

    const res = await app.inject({
      method: "POST",
      url: `/channels/${channelId}/voice/${bId}/disconnect`,
      headers: auth(ownerToken),
    });
    expect(res.statusCode).toBe(204);
    // Room name == channel id for an ordinary voice channel.
    expect(removeParticipant).toHaveBeenCalledWith(channelId, bId);
    // The user stays a member — only the voice session is torn down.
    expect(await repos.groups.getMembership(serverId, bId)).not.toBeNull();

    const evt = findEvent(
      (m) => m.userId === bId && m.event.type === SERVER_EVENT.voiceDisconnected,
    );
    expect(evt).toBeDefined();
    if (evt?.event.type === SERVER_EVENT.voiceDisconnected) {
      expect(evt.event.payload).toEqual({
        roomId: channelId,
        channelId,
        reason: "moderator",
      });
    }
  });

  it("voice disconnect is permission-gated and owner-immune", async () => {
    const serverId = await makeServer("VD Perm");
    const channelId = await makeVoiceChannel(serverId);
    await join(serverId, aToken);
    await join(serverId, bToken);

    // Plain member cannot disconnect anyone.
    const denied = await app.inject({
      method: "POST",
      url: `/channels/${channelId}/voice/${bId}/disconnect`,
      headers: auth(aToken),
    });
    expect(denied.statusCode).toBe(403);

    // Even with KICK_MEMBERS, a non-owner cannot disconnect the owner.
    await grantKick(serverId, aId);
    const owner = await app.inject({
      method: "POST",
      url: `/channels/${channelId}/voice/${ownerId}/disconnect`,
      headers: auth(aToken),
    });
    expect(owner.statusCode).toBe(403);
  });
});
