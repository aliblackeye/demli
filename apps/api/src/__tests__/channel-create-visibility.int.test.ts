/**
 * Task #51 — create-time channel visibility. Real Postgres from docker-compose;
 * skipped (with a notice) when the database is down.
 *
 * Covers (ADR 0007 §channel-visibility, task #51):
 * - POST /groups/:groupId/channels with `roleIds` locks the new channel to those
 *   roles atomically: the owner sees it (flagged `restricted`), a member without a
 *   listed role does NOT, a member holding one DOES;
 * - a role id from another group → 400 (VALIDATION_ERROR), and NO channel is left
 *   behind (the create is one transaction);
 * - a member without MANAGE_CHANNELS → 403, regardless of roleIds;
 * - omitted / empty `roleIds` → public (every member sees it), the existing
 *   default;
 * - channel.created is still published group-scoped on the mutation bus.
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
  console.warn("[channel-create-visibility.int.test] DATABASE unreachable — skipping");
}

describe.skipIf(!dbUp)("create-time channel visibility (task #51)", () => {
  let client: DbClient;
  let repos: Repositories;
  let app: FastifyInstance;
  let bus: InMemoryMutationBus;
  const published: RealtimeMutation[] = [];

  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const password = "correct-horse-9";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  let ownerToken: string;
  let memberToken: string;
  let memberId: string;

  async function register(username: string, displayName: string) {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { username, password, displayName },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { token: string; user: { id: string } };
  }

  /** Fresh server owned by ownerToken. */
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

  async function createRole(serverId: string, name: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/roles`,
      headers: auth(ownerToken),
      payload: { name },
    });
    expect(res.statusCode).toBe(201);
    return res.json().role.id as string;
  }

  async function createChannel(
    serverId: string,
    token: string,
    payload: { name: string; kind: "text" | "voice"; roleIds?: string[] },
  ) {
    return app.inject({
      method: "POST",
      url: `/groups/${serverId}/channels`,
      headers: auth(token),
      payload,
    });
  }

  /** Channel ids visible to `token` via GET /groups/:id (already visibility-filtered). */
  async function visibleChannels(
    serverId: string,
    token: string,
  ): Promise<Array<{ id: string; restricted: boolean }>> {
    const res = await app.inject({
      method: "GET",
      url: `/groups/${serverId}`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    return res.json().channels as Array<{ id: string; restricted: boolean }>;
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
      logger: false,
    });

    const owner = await register(`cv_own_${suffix}`, "CV Owner");
    const member = await register(`cv_mem_${suffix}`, "CV Member");
    ownerToken = owner.token;
    memberToken = member.token;
    memberId = member.user.id;
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("locks a channel to roles at creation: owner sees it, a role-less member does not, a granted member does", async () => {
    const serverId = await makeServer("CV Restricted");
    await join(serverId, memberToken);
    const vipId = await createRole(serverId, "VIP");

    published.length = 0;
    const res = await createChannel(serverId, ownerToken, {
      name: "vip-lounge",
      kind: "text",
      roleIds: [vipId],
    });
    expect(res.statusCode).toBe(201);
    const channelId = res.json().channel.id as string;

    // Access rows landed atomically with the channel.
    expect(await repos.channelAccess.roleIdsForChannel(channelId)).toEqual([vipId]);

    // Still published group-scoped (channel-lifecycle event, no channelId envelope).
    const event = published.find(
      (m) => m.groupId === serverId && m.event.type === SERVER_EVENT.channelCreated,
    );
    expect(event).toBeDefined();
    expect(event?.channelId).toBeUndefined();

    // Owner sees it, flagged restricted.
    const forOwner = (await visibleChannels(serverId, ownerToken)).find((c) => c.id === channelId);
    expect(forOwner?.restricted).toBe(true);

    // Member without the role cannot see it, and its messages 404 (no existence leak).
    expect((await visibleChannels(serverId, memberToken)).some((c) => c.id === channelId)).toBe(
      false,
    );
    const denied = await app.inject({
      method: "GET",
      url: `/channels/${channelId}/messages`,
      headers: auth(memberToken),
    });
    expect(denied.statusCode).toBe(404);

    // Grant VIP → the channel appears for the member.
    const grant = await app.inject({
      method: "PUT",
      url: `/groups/${serverId}/members/${memberId}/roles`,
      headers: auth(ownerToken),
      payload: { roleIds: [vipId] },
    });
    expect(grant.statusCode).toBe(200);
    expect((await visibleChannels(serverId, memberToken)).some((c) => c.id === channelId)).toBe(
      true,
    );
  });

  it("rejects a role from another group with 400 and creates no channel", async () => {
    const serverId = await makeServer("CV OwnGroup");
    const otherServerId = await makeServer("CV OtherGroup");
    const foreignRoleId = await createRole(otherServerId, "Outsider");

    const before = (await visibleChannels(serverId, ownerToken)).length;
    const res = await createChannel(serverId, ownerToken, {
      name: "should-not-exist",
      kind: "text",
      roleIds: [foreignRoleId],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");

    // The rejected create left nothing behind (one transaction, rolled back).
    const after = await visibleChannels(serverId, ownerToken);
    expect(after.length).toBe(before);
    expect(
      (await repos.channels.listForGroup(serverId)).some((c) => c.name === "should-not-exist"),
    ).toBe(false);
  });

  it("forbids a member without MANAGE_CHANNELS from creating (even with roleIds) → 403", async () => {
    const serverId = await makeServer("CV NoPerm");
    await join(serverId, memberToken);
    const roleId = await createRole(serverId, "SomeRole");

    const res = await createChannel(serverId, memberToken, {
      name: "member-attempt",
      kind: "text",
      roleIds: [roleId],
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  it("treats an empty / omitted roleIds as public — every member sees the channel", async () => {
    const serverId = await makeServer("CV Public");
    await join(serverId, memberToken);

    // Explicit empty list.
    const emptyRes = await createChannel(serverId, ownerToken, {
      name: "town-square",
      kind: "text",
      roleIds: [],
    });
    expect(emptyRes.statusCode).toBe(201);
    const emptyId = emptyRes.json().channel.id as string;
    expect(await repos.channelAccess.roleIdsForChannel(emptyId)).toEqual([]);

    // Omitted entirely.
    const omittedRes = await createChannel(serverId, ownerToken, { name: "lobby", kind: "voice" });
    expect(omittedRes.statusCode).toBe(201);
    const omittedId = omittedRes.json().channel.id as string;

    const memberView = await visibleChannels(serverId, memberToken);
    const ids = memberView.map((c) => c.id);
    expect(ids).toContain(emptyId);
    expect(ids).toContain(omittedId);
    // Public channels are not flagged restricted.
    expect(memberView.find((c) => c.id === emptyId)?.restricted).toBe(false);
  });
});
