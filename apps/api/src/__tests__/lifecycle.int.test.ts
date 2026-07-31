/**
 * Channel & member lifecycle publish tests (task #43) — real Postgres from
 * docker-compose. Skipped automatically (with a console notice) when the
 * database is down.
 *
 * Proves the HTTP API fans the group-scoped lifecycle events onto the mutation
 * bus so the gateway can (un)subscribe connections and clients can refresh:
 * - POST   /groups/:id/channels   → channel.created
 * - PATCH  /channels/:id          → channel.updated
 * - DELETE /channels/:id          → channel.deleted
 * - POST   /invites/:code/redeem  → member.joined
 * - DELETE /groups/:id/members/:u → member.left
 *
 * Every lifecycle event is group-scoped: it carries `groupId` and NO `channelId`
 * on the mutation envelope (the bus routes it to the whole server's connections).
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
  console.warn("[lifecycle.int.test] DATABASE unreachable — skipping integration tests");
}

describe.skipIf(!dbUp)("channel & member lifecycle publishes", () => {
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

  async function createChannel(serverId: string, name: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/channels`,
      headers: auth(ownerToken),
      payload: { name, kind: "text" },
    });
    expect(res.statusCode).toBe(201);
    return res.json().channel.id as string;
  }

  /** Bring the joiner into `serverId` as a member; returns the invite code used. */
  async function joinAsMember(serverId: string): Promise<void> {
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

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);
    bus = new InMemoryMutationBus();
    await bus.subscribe((m) => published.push(m));
    app = await buildApp({ repos, env: loadEnv({ DATABASE_URL }), mutationBus: bus, logger: false });

    const owner = await register(`lc_own_${suffix}`, "LC Owner");
    const joiner = await register(`lc_join_${suffix}`, "LC Joiner");
    ownerToken = owner.token;
    joinerToken = joiner.token;
    joinerId = joiner.user.id;
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("publishes channel.created group-scoped on channel create", async () => {
    const serverId = await makeServer("LC Create");
    published.length = 0;

    const res = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/channels`,
      headers: auth(ownerToken),
      payload: { name: "fresh", kind: "text" },
    });
    expect(res.statusCode).toBe(201);
    const channelId = res.json().channel.id as string;

    const event = published.find(
      (m) => m.groupId === serverId && m.event.type === SERVER_EVENT.channelCreated,
    );
    expect(event).toBeDefined();
    expect(event?.channelId).toBeUndefined(); // group-scoped
    if (event?.event.type === SERVER_EVENT.channelCreated) {
      expect(event.event.payload.id).toBe(channelId);
      expect(event.event.payload.groupId).toBe(serverId);
      expect(event.event.payload.name).toBe("fresh");
    }
  });

  it("publishes channel.updated group-scoped on channel rename", async () => {
    const serverId = await makeServer("LC Update");
    const channelId = await createChannel(serverId, "before");
    published.length = 0;

    const res = await app.inject({
      method: "PATCH",
      url: `/channels/${channelId}`,
      headers: auth(ownerToken),
      payload: { name: "after" },
    });
    expect(res.statusCode).toBe(200);

    const event = published.find(
      (m) => m.groupId === serverId && m.event.type === SERVER_EVENT.channelUpdated,
    );
    expect(event).toBeDefined();
    expect(event?.channelId).toBeUndefined();
    if (event?.event.type === SERVER_EVENT.channelUpdated) {
      expect(event.event.payload.id).toBe(channelId);
      expect(event.event.payload.name).toBe("after");
    }
  });

  it("publishes channel.deleted group-scoped on channel delete", async () => {
    const serverId = await makeServer("LC Delete");
    const channelId = await createChannel(serverId, "doomed");
    published.length = 0;

    const res = await app.inject({
      method: "DELETE",
      url: `/channels/${channelId}`,
      headers: auth(ownerToken),
    });
    expect(res.statusCode).toBe(204);

    const event = published.find(
      (m) => m.groupId === serverId && m.event.type === SERVER_EVENT.channelDeleted,
    );
    expect(event).toBeDefined();
    expect(event?.channelId).toBeUndefined();
    if (event?.event.type === SERVER_EVENT.channelDeleted) {
      expect(event.event.payload).toEqual({ channelId, groupId: serverId });
    }
  });

  it("publishes member.joined group-scoped on invite redeem", async () => {
    const serverId = await makeServer("LC Join");
    published.length = 0;

    await joinAsMember(serverId);

    const event = published.find(
      (m) => m.groupId === serverId && m.event.type === SERVER_EVENT.memberJoined,
    );
    expect(event).toBeDefined();
    expect(event?.channelId).toBeUndefined();
    if (event?.event.type === SERVER_EVENT.memberJoined) {
      expect(event.event.payload.groupId).toBe(serverId);
      expect(event.event.payload.user.id).toBe(joinerId);
      expect(event.event.payload.member.userId).toBe(joinerId);
      expect(event.event.payload.member.role).toBe("member");
    }
  });

  it("publishes member.left group-scoped on member removal (kick/leave)", async () => {
    const serverId = await makeServer("LC Leave");
    await joinAsMember(serverId);
    published.length = 0;

    // Owner kicks the member.
    const res = await app.inject({
      method: "DELETE",
      url: `/groups/${serverId}/members/${joinerId}`,
      headers: auth(ownerToken),
    });
    expect(res.statusCode).toBe(204);

    const event = published.find(
      (m) => m.groupId === serverId && m.event.type === SERVER_EVENT.memberLeft,
    );
    expect(event).toBeDefined();
    expect(event?.channelId).toBeUndefined();
    if (event?.event.type === SERVER_EVENT.memberLeft) {
      expect(event.event.payload).toEqual({ groupId: serverId, userId: joinerId });
    }
  });
});
