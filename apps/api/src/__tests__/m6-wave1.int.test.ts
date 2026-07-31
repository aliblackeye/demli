/**
 * M6 Wave 1 API integration tests — group chats, server management, channel
 * management, and profile endpoints. Real Postgres from docker-compose;
 * auto-skipped (with a notice) when the database is unreachable.
 *
 * Focus: server-side auth guards (owner-only, membership never leaked), the
 * flat group-chat flow (ADR 0005), and delete cascades.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  applyMigrations,
  createDb,
  createRepositories,
  type DbClient,
} from "@demli/db";
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
  console.warn("[m6-wave1.int.test] DATABASE unreachable — skipping integration tests");
}

describe.skipIf(!dbUp)("M6 wave 1 API", () => {
  let client: DbClient;
  let app: FastifyInstance;
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // A = owner, B = member, C = outsider.
  let tokenA: string;
  let tokenB: string;
  let tokenC: string;
  let userAId: string;
  let userBId: string;
  const usernameB = `w1b_${suffix}`;
  const password = "correct-horse-9";

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async function register(username: string): Promise<{ token: string; id: string }> {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { username, password, displayName: username },
    });
    const body = res.json() as { token: string; user: { id: string } };
    return { token: body.token, id: body.user.id };
  }

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    app = await buildApp({
      repos: createRepositories(client.db),
      env: loadEnv({ DATABASE_URL }),
      logger: false,
    });

    const a = await register(`w1a_${suffix}`);
    const b = await register(usernameB);
    const c = await register(`w1c_${suffix}`);
    tokenA = a.token;
    userAId = a.id;
    tokenB = b.token;
    userBId = b.id;
    tokenC = c.token;
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  // -------------------------------------------------------------------------
  // Flat group chats (ADR 0005)
  // -------------------------------------------------------------------------
  describe("group chats", () => {
    let groupId: string;
    let streamId: string;

    it("creates a group chat with the caller as owner", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/group-chats",
        headers: auth(tokenA),
        payload: { name: "Film Night" },
      });
      expect(res.statusCode).toBe(201);
      const group = res.json().group as { id: string; streamId: string; ownerId: string };
      expect(group.ownerId).toBe(userAId);
      expect(group.streamId).toMatch(/[0-9a-f-]{36}/);
      groupId = group.id;
      streamId = group.streamId;
    });

    it("lists only the caller's group chats", async () => {
      const mine = await app.inject({
        method: "GET",
        url: "/group-chats",
        headers: auth(tokenA),
      });
      expect(mine.statusCode).toBe(200);
      expect((mine.json().groups as Array<{ id: string }>).map((g) => g.id)).toContain(
        groupId,
      );

      const outsider = await app.inject({
        method: "GET",
        url: "/group-chats",
        headers: auth(tokenC),
      });
      expect((outsider.json().groups as unknown[]).length).toBe(0);
    });

    it("hides details from non-members (404, not 403)", async () => {
      const asC = await app.inject({
        method: "GET",
        url: `/group-chats/${groupId}`,
        headers: auth(tokenC),
      });
      expect(asC.statusCode).toBe(404);
    });

    it("only the owner may add members; enforces unknown/duplicate", async () => {
      // Outsider cannot add (not a member → 404).
      const byC = await app.inject({
        method: "POST",
        url: `/group-chats/${groupId}/members`,
        headers: auth(tokenC),
        payload: { username: usernameB },
      });
      expect(byC.statusCode).toBe(404);

      // Unknown username → 404.
      const unknown = await app.inject({
        method: "POST",
        url: `/group-chats/${groupId}/members`,
        headers: auth(tokenA),
        payload: { username: `nope_${suffix}` },
      });
      expect(unknown.statusCode).toBe(404);

      // Owner adds B → 201, returns public member (no password hash).
      const added = await app.inject({
        method: "POST",
        url: `/group-chats/${groupId}/members`,
        headers: auth(tokenA),
        payload: { username: usernameB },
      });
      expect(added.statusCode).toBe(201);
      const member = added.json().member as { userId: string; user: unknown };
      expect(member.userId).toBe(userBId);
      expect(JSON.stringify(member)).not.toMatch(/passwordHash/i);

      // Adding again → 409.
      const dup = await app.inject({
        method: "POST",
        url: `/group-chats/${groupId}/members`,
        headers: auth(tokenA),
        payload: { username: usernameB },
      });
      expect(dup.statusCode).toBe(409);
    });

    it("a non-owner member cannot add members", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/group-chats/${groupId}/members`,
        headers: auth(tokenB),
        payload: { username: `w1c_${suffix}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("reuses the channel message pipeline via streamId", async () => {
      const send = await app.inject({
        method: "POST",
        url: `/channels/${streamId}/messages`,
        headers: auth(tokenA),
        payload: { content: "starting the film" },
      });
      expect(send.statusCode).toBe(201);

      const asB = await app.inject({
        method: "GET",
        url: `/channels/${streamId}/messages`,
        headers: auth(tokenB),
      });
      expect(asB.statusCode).toBe(200);
      expect((asB.json().messages as Array<{ content: string }>)[0]?.content).toBe(
        "starting the film",
      );
    });

    it("enforces member-removal rules", async () => {
      // The owner cannot be removed (must delete the group instead).
      const removeOwner = await app.inject({
        method: "DELETE",
        url: `/group-chats/${groupId}/members/${userAId}`,
        headers: auth(tokenA),
      });
      expect(removeOwner.statusCode).toBe(400);

      // A member may remove themselves.
      const selfLeave = await app.inject({
        method: "DELETE",
        url: `/group-chats/${groupId}/members/${userBId}`,
        headers: auth(tokenB),
      });
      expect(selfLeave.statusCode).toBe(204);

      // Re-add B, then the owner removes B.
      await app.inject({
        method: "POST",
        url: `/group-chats/${groupId}/members`,
        headers: auth(tokenA),
        payload: { username: usernameB },
      });
      const ownerRemoves = await app.inject({
        method: "DELETE",
        url: `/group-chats/${groupId}/members/${userBId}`,
        headers: auth(tokenA),
      });
      expect(ownerRemoves.statusCode).toBe(204);
    });
  });

  // -------------------------------------------------------------------------
  // Server management: PATCH / DELETE /groups/:id
  // -------------------------------------------------------------------------
  describe("server management", () => {
    let serverId: string;

    beforeAll(async () => {
      const res = await app.inject({
        method: "POST",
        url: "/groups",
        headers: auth(tokenA),
        payload: { name: "Squad" },
      });
      serverId = res.json().group.id as string;
      // B joins as a member via invite.
      const code = (
        await app.inject({
          method: "POST",
          url: `/groups/${serverId}/invites`,
          headers: auth(tokenA),
          payload: {},
        })
      ).json().invite.code as string;
      await app.inject({
        method: "POST",
        url: `/invites/${code}/redeem`,
        headers: auth(tokenB),
      });
    });

    it("owner renames the server; non-members 404, non-owner members 403", async () => {
      const byC = await app.inject({
        method: "PATCH",
        url: `/groups/${serverId}`,
        headers: auth(tokenC),
        payload: { name: "Hijacked" },
      });
      expect(byC.statusCode).toBe(404);

      const byB = await app.inject({
        method: "PATCH",
        url: `/groups/${serverId}`,
        headers: auth(tokenB),
        payload: { name: "Hijacked" },
      });
      expect(byB.statusCode).toBe(403);

      const byA = await app.inject({
        method: "PATCH",
        url: `/groups/${serverId}`,
        headers: auth(tokenA),
        payload: { name: "Squad Renamed", iconUrl: "https://cdn.example.com/i.png" },
      });
      expect(byA.statusCode).toBe(200);
      expect(byA.json().group.name).toBe("Squad Renamed");
      expect(byA.json().group.iconUrl).toBe("https://cdn.example.com/i.png");
    });

    it("does not manage a group chat via /groups (server-kind only)", async () => {
      const gc = await app.inject({
        method: "POST",
        url: "/group-chats",
        headers: auth(tokenA),
        payload: { name: "Not A Server" },
      });
      const gcId = gc.json().group.id as string;
      const res = await app.inject({
        method: "PATCH",
        url: `/groups/${gcId}`,
        headers: auth(tokenA),
        payload: { name: "x" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("deletes the server and cascades its channels + messages", async () => {
      const doomed = (
        await app.inject({
          method: "POST",
          url: "/groups",
          headers: auth(tokenA),
          payload: { name: "Doomed" },
        })
      ).json().group.id as string;
      const channelId = (
        await app.inject({
          method: "POST",
          url: `/groups/${doomed}/channels`,
          headers: auth(tokenA),
          payload: { name: "general", kind: "text" },
        })
      ).json().channel.id as string;
      await app.inject({
        method: "POST",
        url: `/channels/${channelId}/messages`,
        headers: auth(tokenA),
        payload: { content: "bye" },
      });

      // Non-owner cannot delete.
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: `/groups/${doomed}`,
            headers: auth(tokenC),
          })
        ).statusCode,
      ).toBe(404);

      const del = await app.inject({
        method: "DELETE",
        url: `/groups/${doomed}`,
        headers: auth(tokenA),
      });
      expect(del.statusCode).toBe(204);

      // Group gone (owner now 404), and the channel's messages are unreachable.
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/groups/${doomed}`,
            headers: auth(tokenA),
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/channels/${channelId}/messages`,
            headers: auth(tokenA),
          })
        ).statusCode,
      ).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Channel management: PATCH / DELETE /channels/:id
  // -------------------------------------------------------------------------
  describe("channel management", () => {
    let serverId: string;
    let textId: string;
    let voiceId: string;
    let groupStreamId: string;

    beforeAll(async () => {
      serverId = (
        await app.inject({
          method: "POST",
          url: "/groups",
          headers: auth(tokenA),
          payload: { name: "Chan Squad" },
        })
      ).json().group.id as string;
      const code = (
        await app.inject({
          method: "POST",
          url: `/groups/${serverId}/invites`,
          headers: auth(tokenA),
          payload: {},
        })
      ).json().invite.code as string;
      await app.inject({
        method: "POST",
        url: `/invites/${code}/redeem`,
        headers: auth(tokenB),
      });
      textId = (
        await app.inject({
          method: "POST",
          url: `/groups/${serverId}/channels`,
          headers: auth(tokenA),
          payload: { name: "general", kind: "text" },
        })
      ).json().channel.id as string;
      voiceId = (
        await app.inject({
          method: "POST",
          url: `/groups/${serverId}/channels`,
          headers: auth(tokenA),
          payload: { name: "lobby", kind: "voice" },
        })
      ).json().channel.id as string;
      groupStreamId = (
        await app.inject({
          method: "POST",
          url: "/group-chats",
          headers: auth(tokenA),
          payload: { name: "Stream Owner" },
        })
      ).json().group.streamId as string;
    });

    it("owner edits name + description; non-owner is forbidden", async () => {
      const byB = await app.inject({
        method: "PATCH",
        url: `/channels/${textId}`,
        headers: auth(tokenB),
        payload: { name: "nope" },
      });
      expect(byB.statusCode).toBe(403);

      const byA = await app.inject({
        method: "PATCH",
        url: `/channels/${textId}`,
        headers: auth(tokenA),
        payload: { name: "general-chat", description: "Main text channel" },
      });
      expect(byA.statusCode).toBe(200);
      expect(byA.json().channel.name).toBe("general-chat");
      expect(byA.json().channel.description).toBe("Main text channel");
    });

    it("maxParticipants is voice-only", async () => {
      const onText = await app.inject({
        method: "PATCH",
        url: `/channels/${textId}`,
        headers: auth(tokenA),
        payload: { maxParticipants: 5 },
      });
      expect(onText.statusCode).toBe(400);
      expect(onText.json().error.code).toBe("INVALID_CHANNEL");

      const onVoice = await app.inject({
        method: "PATCH",
        url: `/channels/${voiceId}`,
        headers: auth(tokenA),
        payload: { maxParticipants: 5 },
      });
      expect(onVoice.statusCode).toBe(200);
      expect(onVoice.json().channel.maxParticipants).toBe(5);
    });

    it("does not manage a group chat's hidden stream channel (404)", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/channels/${groupStreamId}`,
        headers: auth(tokenA),
        payload: { name: "leak" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("owner deletes a channel and its messages", async () => {
      await app.inject({
        method: "POST",
        url: `/channels/${textId}/messages`,
        headers: auth(tokenA),
        payload: { content: "soon gone" },
      });

      expect(
        (
          await app.inject({
            method: "DELETE",
            url: `/channels/${textId}`,
            headers: auth(tokenB),
          })
        ).statusCode,
      ).toBe(403);

      const del = await app.inject({
        method: "DELETE",
        url: `/channels/${textId}`,
        headers: auth(tokenA),
      });
      expect(del.statusCode).toBe(204);

      expect(
        (
          await app.inject({
            method: "GET",
            url: `/channels/${textId}/messages`,
            headers: auth(tokenA),
          })
        ).statusCode,
      ).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Profile
  // -------------------------------------------------------------------------
  describe("profile", () => {
    it("PATCH /users/me updates the caller's own profile", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/users/me",
        headers: auth(tokenA),
        payload: { displayName: "Ali (updated)" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().user.displayName).toBe("Ali (updated)");
      expect(JSON.stringify(res.json())).not.toMatch(/passwordHash/i);
    });

    it("GET /users/:id returns a public profile; /users/me still resolves", async () => {
      const pub = await app.inject({
        method: "GET",
        url: `/users/${userBId}`,
        headers: auth(tokenA),
      });
      expect(pub.statusCode).toBe(200);
      expect(pub.json().user.id).toBe(userBId);
      expect(JSON.stringify(pub.json())).not.toMatch(/passwordHash/i);

      const missing = await app.inject({
        method: "GET",
        url: `/users/${crypto.randomUUID()}`,
        headers: auth(tokenA),
      });
      expect(missing.statusCode).toBe(404);

      // Static /users/me is not shadowed by the :id route.
      const me = await app.inject({
        method: "GET",
        url: "/users/me",
        headers: auth(tokenA),
      });
      expect(me.statusCode).toBe(200);
      expect(me.json().user.id).toBe(userAId);
    });

    it("rejects unauthenticated profile reads", async () => {
      expect(
        (await app.inject({ method: "GET", url: `/users/${userBId}` })).statusCode,
      ).toBe(401);
    });
  });
});
