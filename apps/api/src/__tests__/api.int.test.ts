/**
 * API integration tests — run against the real Postgres from docker-compose.
 * Skipped automatically (with a console notice) when the database is down.
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
  console.warn("[api.int.test] DATABASE unreachable — skipping integration tests");
}

describe.skipIf(!dbUp)("api integration", () => {
  let client: DbClient;
  let app: FastifyInstance;
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const userA = `inta_${suffix}`;
  const userB = `intb_${suffix}`;
  const userC = `intc_${suffix}`;
  const password = "correct-horse-9";

  let tokenA: string;
  let tokenB: string;
  let tokenC: string;
  let groupId: string;
  let channelId: string;

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    app = await buildApp({
      repos: createRepositories(client.db),
      env: loadEnv({ DATABASE_URL }),
      logger: false,
    });
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  it("registers users and rejects duplicates", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { username: userA, password, displayName: "Int A" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { token: string; user: { username: string } };
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.user).not.toHaveProperty("passwordHash");
    tokenA = body.token;

    const dup = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { username: userA.toUpperCase(), password },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("CONFLICT");

    tokenB = (
      await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: { username: userB, password },
      })
    ).json().token;
    tokenC = (
      await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: { username: userC, password },
      })
    ).json().token;
  });

  it("validates register input at the boundary", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { username: "x", password: "short" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("logs in with valid credentials only", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: userA, password: "wrong-password" },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe("UNAUTHORIZED");

    const good = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: userA, password },
    });
    expect(good.statusCode).toBe(200);
    expect(good.json().token).toBeTruthy();
  });

  it("enforces session tokens on protected routes", async () => {
    expect((await app.inject({ method: "GET", url: "/users/me" })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/users/me",
          headers: auth("forged-token"),
        })
      ).statusCode,
    ).toBe(401);

    const me = await app.inject({ method: "GET", url: "/users/me", headers: auth(tokenA) });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.username).toBe(userA);
  });

  it("invalidates the session on logout", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: userA, password },
    });
    const throwaway = login.json().token as string;
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/auth/logout",
          headers: auth(throwaway),
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ method: "GET", url: "/users/me", headers: auth(throwaway) }))
        .statusCode,
    ).toBe(401);
  });

  it("creates a group with owner membership and hides it from non-members", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/groups",
      headers: auth(tokenA),
      payload: { name: "Int Crew" },
    });
    expect(created.statusCode).toBe(201);
    groupId = created.json().group.id;

    const asB = await app.inject({
      method: "GET",
      url: `/groups/${groupId}`,
      headers: auth(tokenB),
    });
    expect(asB.statusCode).toBe(404);
  });

  it("lets only the owner create channels", async () => {
    const channel = await app.inject({
      method: "POST",
      url: `/groups/${groupId}/channels`,
      headers: auth(tokenA),
      payload: { name: "int-general", kind: "text" },
    });
    expect(channel.statusCode).toBe(201);
    channelId = channel.json().channel.id;
  });

  it("redeems invites with max-use and duplicate-member rules", async () => {
    const invite = await app.inject({
      method: "POST",
      url: `/groups/${groupId}/invites`,
      headers: auth(tokenA),
      payload: { maxUses: 1 },
    });
    expect(invite.statusCode).toBe(201);
    const code = invite.json().invite.code as string;

    const redeemB = await app.inject({
      method: "POST",
      url: `/invites/${code}/redeem`,
      headers: auth(tokenB),
    });
    expect(redeemB.statusCode).toBe(200);
    expect(redeemB.json().group.id).toBe(groupId);

    const again = await app.inject({
      method: "POST",
      url: `/invites/${code}/redeem`,
      headers: auth(tokenB),
    });
    expect(again.statusCode).toBe(409);

    const exhausted = await app.inject({
      method: "POST",
      url: `/invites/${code}/redeem`,
      headers: auth(tokenC),
    });
    expect(exhausted.statusCode).toBe(410);
    expect(exhausted.json().error.code).toBe("INVITE_EXHAUSTED");
  });

  it("paginates messages without duplicates across pages", async () => {
    const seeded: string[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await app.inject({
        method: "POST",
        url: `/channels/${channelId}/messages`,
        headers: auth(tokenA),
        payload: { content: `int message ${i}` },
      });
      expect(res.statusCode).toBe(201);
      seeded.push(res.json().message.id as string);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const url: string = `/channels/${channelId}/messages?limit=5${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
      }`;
      const res = await app.inject({ method: "GET", url, headers: auth(tokenB) });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        messages: Array<{ id: string }>;
        nextCursor: string | null;
      };
      seen.push(...body.messages.map((m) => m.id));
      cursor = body.nextCursor;
      if (!cursor) break;
    }

    // No duplicates and no losses across pages. The channel also carries the
    // system "joined" message written by the invite-redeem test above (M7b),
    // so we assert set semantics rather than an exact count.
    expect(new Set(seen).size).toBe(seen.length);
    for (const id of seeded) expect(seen).toContain(id);
  });

  it("enforces author/owner rules on edit and delete", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/channels/${channelId}/messages`,
      headers: auth(tokenB),
      payload: { content: "editable" },
    });
    const messageId = created.json().message.id as string;

    const editByA = await app.inject({
      method: "PATCH",
      url: `/messages/${messageId}`,
      headers: auth(tokenA),
      payload: { content: "hijacked" },
    });
    expect(editByA.statusCode).toBe(403);

    const editByB = await app.inject({
      method: "PATCH",
      url: `/messages/${messageId}`,
      headers: auth(tokenB),
      payload: { content: "edited" },
    });
    expect(editByB.statusCode).toBe(200);
    expect(editByB.json().message.updatedAt).not.toBeNull();

    // Group owner may delete another member's message.
    const del = await app.inject({
      method: "DELETE",
      url: `/messages/${messageId}`,
      headers: auth(tokenA),
    });
    expect(del.statusCode).toBe(204);

    const list = await app.inject({
      method: "GET",
      url: `/channels/${channelId}/messages?limit=100`,
      headers: auth(tokenA),
    });
    const ids = (list.json().messages as Array<{ id: string }>).map((m) => m.id);
    expect(ids).not.toContain(messageId);
  });

  // M20: a voice channel carries its own text chat. This test
  // used to assert the OPPOSITE (400 INVALID_CHANNEL) — it is inverted rather
  // than deleted so the send/read/persist round trip stays pinned on the kind
  // that used to be refused.
  it("accepts messages in a voice channel and persists them", async () => {
    const voice = await app.inject({
      method: "POST",
      url: `/groups/${groupId}/channels`,
      headers: auth(tokenA),
      payload: { name: "int-lobby", kind: "voice" },
    });
    const voiceId = voice.json().channel.id as string;

    const res = await app.inject({
      method: "POST",
      url: `/channels/${voiceId}/messages`,
      headers: auth(tokenA),
      payload: { content: "in the lobby" },
    });
    expect(res.statusCode).toBe(201);
    const messageId = res.json().message.id as string;

    // Persisted: a fresh read of the voice channel's history returns it — the
    // read path never had a kind gate, so this proves the two halves agree.
    const list = await app.inject({
      method: "GET",
      url: `/channels/${voiceId}/messages`,
      headers: auth(tokenA),
    });
    expect(list.statusCode).toBe(200);
    expect((list.json().messages as { id: string }[]).map((m) => m.id)).toContain(messageId);
  });

  it("never leaks stack traces in error responses", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/groups/not-a-uuid",
      headers: auth(tokenA),
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body).toEqual({
      error: { code: "VALIDATION_ERROR", message: expect.any(String) },
    });
    expect(JSON.stringify(body)).not.toMatch(/\bat\s+.*:\d+:\d+/);
  });
});

describe.skipIf(!dbUp)("api → realtime mutation publish", () => {
  let client: DbClient;
  let app: FastifyInstance;
  const bus = new InMemoryMutationBus();
  const published: RealtimeMutation[] = [];

  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let token: string;
  let channelId: string;

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    await bus.subscribe((m) => published.push(m));
    app = await buildApp({
      repos: createRepositories(client.db),
      env: loadEnv({ DATABASE_URL }),
      mutationBus: bus,
      logger: false,
    });

    token = (
      await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: { username: `pub_${suffix}`, password: "correct-horse-9", displayName: "Pub" },
      })
    ).json().token as string;
    const auth = { authorization: `Bearer ${token}` };
    const groupId = (
      await app.inject({ method: "POST", url: "/groups", headers: auth, payload: { name: "Pub Crew" } })
    ).json().group.id as string;
    channelId = (
      await app.inject({
        method: "POST",
        url: `/groups/${groupId}/channels`,
        headers: auth,
        payload: { name: "pub-general", kind: "text" },
      })
    ).json().channel.id as string;
  });

  afterAll(async () => {
    await app?.close();
    await bus.close();
    await client?.close();
  });

  it("publishes message.updated on edit and message.deleted on delete", async () => {
    const auth = { authorization: `Bearer ${token}` };
    const messageId = (
      await app.inject({
        method: "POST",
        url: `/channels/${channelId}/messages`,
        headers: auth,
        payload: { content: "original" },
      })
    ).json().message.id as string;

    published.length = 0;

    const edit = await app.inject({
      method: "PATCH",
      url: `/messages/${messageId}`,
      headers: auth,
      payload: { content: "edited over http" },
    });
    expect(edit.statusCode).toBe(200);

    const del = await app.inject({
      method: "DELETE",
      url: `/messages/${messageId}`,
      headers: auth,
    });
    expect(del.statusCode).toBe(204);

    expect(published).toHaveLength(2);
    const [updated, deleted] = published;
    expect(updated?.channelId).toBe(channelId);
    expect(updated?.event.type).toBe(SERVER_EVENT.messageUpdated);
    if (updated?.event.type === SERVER_EVENT.messageUpdated) {
      expect(updated.event.payload.id).toBe(messageId);
      expect(updated.event.payload.content).toBe("edited over http");
    }
    expect(deleted?.channelId).toBe(channelId);
    expect(deleted?.event.type).toBe(SERVER_EVENT.messageDeleted);
    if (deleted?.event.type === SERVER_EVENT.messageDeleted) {
      expect(deleted.event.payload.messageId).toBe(messageId);
    }
  });
});
