/**
 * Group (server / flat group chat) lifecycle tests (task #49/#50) — real
 * Postgres from docker-compose. Skipped automatically (with a console notice)
 * when the database is down.
 *
 * Proves the HTTP API:
 * - publishes `group.updated` on a server rename;
 * - publishes `group.deleted` on an owner delete (server AND group chat);
 * - auto-deletes a server/group chat when its LAST member leaves, publishing
 *   `group.deleted` (not member.left) and removing the row + its cascade;
 * - keeps the owner from LEAVING while other members remain (must delete);
 * - publishes `member.left` on a normal (non-emptying) group-chat leave;
 * - refuses a non-owner deleting a group chat (403).
 *
 * Every event is group-scoped: it carries `groupId` and NO `channelId` on the
 * mutation envelope (the bus routes it to the whole server's connections).
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
  console.warn("[group-lifecycle.int.test] DATABASE unreachable — skipping integration tests");
}

describe.skipIf(!dbUp)("group lifecycle publishes", () => {
  let client: DbClient;
  let repos: Repositories;
  let app: FastifyInstance;
  let bus: InMemoryMutationBus;
  const published: RealtimeMutation[] = [];

  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const password = "correct-horse-9";

  let ownerToken: string;
  let joinerToken: string;
  let joinerId: string;
  let joinerUsername: string;

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

  /** Bring the joiner into a server as a member. */
  async function joinServer(serverId: string): Promise<void> {
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
      headers: auth(joinerToken),
    });
    expect(redeem.statusCode).toBe(200);
  }

  async function makeGroupChat(name: string): Promise<string> {
    const created = await app.inject({
      method: "POST",
      url: "/group-chats",
      headers: auth(ownerToken),
      payload: { name },
    });
    expect(created.statusCode).toBe(201);
    return created.json().group.id as string;
  }

  async function addGroupChatMember(groupId: string): Promise<void> {
    const res = await app.inject({
      method: "POST",
      url: `/group-chats/${groupId}/members`,
      headers: auth(ownerToken),
      payload: { username: joinerUsername },
    });
    expect(res.statusCode).toBe(201);
  }

  function findEvent(groupId: string, type: string): RealtimeMutation | undefined {
    return published.find((m) => m.groupId === groupId && m.event.type === type);
  }

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);
    bus = new InMemoryMutationBus();
    await bus.subscribe((m) => published.push(m));
    app = await buildApp({ repos, env: loadEnv({ DATABASE_URL }), mutationBus: bus, logger: false });

    joinerUsername = `gl_join_${suffix}`;
    const owner = await register(`gl_own_${suffix}`, "GL Owner");
    const joiner = await register(joinerUsername, "GL Joiner");
    ownerToken = owner.token;
    joinerToken = joiner.token;
    joinerId = joiner.user.id;
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  // --- Servers ---------------------------------------------------------------

  it("publishes group.updated group-scoped on server rename", async () => {
    const serverId = await makeServer("GL Rename Before");
    published.length = 0;

    const res = await app.inject({
      method: "PATCH",
      url: `/groups/${serverId}`,
      headers: auth(ownerToken),
      payload: { name: "GL Rename After" },
    });
    expect(res.statusCode).toBe(200);

    const event = findEvent(serverId, SERVER_EVENT.groupUpdated);
    expect(event).toBeDefined();
    expect(event?.channelId).toBeUndefined();
    if (event?.event.type === SERVER_EVENT.groupUpdated) {
      expect(event.event.payload.group.id).toBe(serverId);
      expect(event.event.payload.group.name).toBe("GL Rename After");
    }
  });

  it("publishes group.deleted group-scoped on owner server delete", async () => {
    const serverId = await makeServer("GL Delete");
    published.length = 0;

    const res = await app.inject({
      method: "DELETE",
      url: `/groups/${serverId}`,
      headers: auth(ownerToken),
    });
    expect(res.statusCode).toBe(204);

    const event = findEvent(serverId, SERVER_EVENT.groupDeleted);
    expect(event).toBeDefined();
    expect(event?.channelId).toBeUndefined();
    if (event?.event.type === SERVER_EVENT.groupDeleted) {
      expect(event.event.payload).toEqual({ groupId: serverId });
    }
    // The row (and cascade) is gone.
    expect(await repos.groups.findById(serverId)).toBeNull();
  });

  it("rejects an owner leaving a server while other members remain (400)", async () => {
    const serverId = await makeServer("GL Owner Stays");
    await joinServer(serverId);
    const ownerId = (await repos.groups.findById(serverId))!.ownerId;

    const res = await app.inject({
      method: "DELETE",
      url: `/groups/${serverId}/members/${ownerId}`,
      headers: auth(ownerToken),
    });
    expect(res.statusCode).toBe(400);
    // Still present, owner still a member.
    expect(await repos.groups.getMembership(serverId, ownerId)).not.toBeNull();
  });

  it("auto-deletes a server when its last member (solo owner) leaves → group.deleted", async () => {
    const serverId = await makeServer("GL Auto Prune");
    const ownerId = (await repos.groups.findById(serverId))!.ownerId;
    published.length = 0;

    const res = await app.inject({
      method: "DELETE",
      url: `/groups/${serverId}/members/${ownerId}`,
      headers: auth(ownerToken),
    });
    expect(res.statusCode).toBe(204);

    // group.deleted (NOT member.left) fired, and the row is gone.
    expect(findEvent(serverId, SERVER_EVENT.groupDeleted)).toBeDefined();
    expect(findEvent(serverId, SERVER_EVENT.memberLeft)).toBeUndefined();
    expect(await repos.groups.findById(serverId)).toBeNull();
  });

  // --- Flat group chats ------------------------------------------------------

  it("publishes group_chat.added USER-scoped to the added member on member add", async () => {
    const groupId = await makeGroupChat("GL GC Added");
    published.length = 0;
    await addGroupChatMember(groupId);

    // USER-scoped (carries userId, NOT groupId/channelId): the added member is
    // reached via connectionsByUser — a flat group chat is not in the gateway's
    // group index — so this is the group-chat twin of dm.created.
    const event = published.find(
      (m) => m.userId === joinerId && m.event.type === SERVER_EVENT.groupChatAdded,
    );
    expect(event).toBeDefined();
    expect(event?.channelId).toBeUndefined();
    expect(event?.groupId).toBeUndefined();
    if (event?.event.type === SERVER_EVENT.groupChatAdded) {
      expect(event.event.payload.group.id).toBe(groupId);
      // The stream id lets the client surface + subscribe in one shot.
      expect(typeof event.event.payload.group.streamId).toBe("string");
    }
  });

  it("publishes member.left on a normal group-chat leave (group survives)", async () => {
    const groupId = await makeGroupChat("GL GC Leave");
    await addGroupChatMember(groupId);
    published.length = 0;

    const res = await app.inject({
      method: "DELETE",
      url: `/group-chats/${groupId}/members/${joinerId}`,
      headers: auth(joinerToken),
    });
    expect(res.statusCode).toBe(204);

    const event = findEvent(groupId, SERVER_EVENT.memberLeft);
    expect(event).toBeDefined();
    expect(event?.channelId).toBeUndefined();
    if (event?.event.type === SERVER_EVENT.memberLeft) {
      expect(event.event.payload).toEqual({ groupId, userId: joinerId });
    }
    // Group survives (owner remains).
    expect(await repos.groupChats.findById(groupId)).not.toBeNull();
  });

  it("publishes group.deleted on owner delete of a group chat; non-owner gets 403", async () => {
    const groupId = await makeGroupChat("GL GC Delete");
    await addGroupChatMember(groupId);

    // A non-owner member cannot delete it.
    const forbidden = await app.inject({
      method: "DELETE",
      url: `/group-chats/${groupId}`,
      headers: auth(joinerToken),
    });
    expect(forbidden.statusCode).toBe(403);

    published.length = 0;
    const res = await app.inject({
      method: "DELETE",
      url: `/group-chats/${groupId}`,
      headers: auth(ownerToken),
    });
    expect(res.statusCode).toBe(204);

    expect(findEvent(groupId, SERVER_EVENT.groupDeleted)).toBeDefined();
    expect(await repos.groupChats.findById(groupId)).toBeNull();
  });

  it("auto-deletes a group chat when its last member (solo owner) leaves → group.deleted", async () => {
    const groupId = await makeGroupChat("GL GC Auto Prune");
    const ownerId = (await repos.groupChats.findById(groupId))!.ownerId;
    published.length = 0;

    const res = await app.inject({
      method: "DELETE",
      url: `/group-chats/${groupId}/members/${ownerId}`,
      headers: auth(ownerToken),
    });
    expect(res.statusCode).toBe(204);

    expect(findEvent(groupId, SERVER_EVENT.groupDeleted)).toBeDefined();
    expect(findEvent(groupId, SERVER_EVENT.memberLeft)).toBeUndefined();
    expect(await repos.groupChats.findById(groupId)).toBeNull();
  });
});
