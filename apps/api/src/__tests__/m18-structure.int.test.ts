/**
 * M18 — channel categories, sidebar reordering, custom status, the moderation
 * audit log, and group-DM invite links (integration, migration 0019).
 *
 * Real Postgres from docker-compose; auto-skipped when unreachable. The
 * blocking half of M18 lives in `blocks.int.test.ts`.
 *
 * Covers:
 *  - category CRUD + the owner ∨ MANAGE_CHANNELS gate (no new permission system)
 *  - deleting a category frees its channels instead of deleting them
 *  - the two-axis reorder (category order + channel placement) in one call, and
 *    its cross-group id rejection
 *  - custom status set / expiry / clear, and its presence-audience fan-out event
 *  - every moderation action appending an audit row, and the log's read gate
 *  - group-DM invite links: create, redeem (joins + `group_chat.added`), revoke
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  applyMigrations,
  createDb,
  createRepositories,
  generateSessionToken,
  hashSessionToken,
  InMemoryMutationBus,
  sessionExpiresAt,
  type DbClient,
  type RealtimeMutation,
  type Repositories,
} from "@demli/db";
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
  console.warn("[m18-structure.int.test] DATABASE unreachable — skipping integration tests");
}

describe.skipIf(!dbUp)("M18 structure — categories, status, audit log, group-DM invites", () => {
  let client: DbClient;
  let repos: Repositories;
  let app: FastifyInstance;
  let bus: InMemoryMutationBus;

  const published: RealtimeMutation[] = [];
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let seq = 0;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  interface TestUser {
    token: string;
    id: string;
    username: string;
  }

  async function newUser(label = "u"): Promise<TestUser> {
    seq += 1;
    const username = `${label}${seq}_${suffix}`;
    const user = await repos.users.create({
      username,
      displayName: username,
      passwordHash: "not-used",
    });
    const token = generateSessionToken();
    await repos.sessions.create({
      userId: user.id,
      tokenHash: hashSessionToken(token),
      expiresAt: sessionExpiresAt(new Date(), 24),
    });
    return { token, id: user.id, username };
  }

  async function makeServer(owner: TestUser): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/groups",
      headers: auth(owner.token),
      payload: { name: `srv_${suffix}_${seq}` },
    });
    expect(res.statusCode).toBe(201);
    return res.json().group.id as string;
  }

  async function join(groupId: string, inviter: TestUser, member: TestUser): Promise<void> {
    const invite = await app.inject({
      method: "POST",
      url: `/groups/${groupId}/invites`,
      headers: auth(inviter.token),
      payload: {},
    });
    expect(invite.statusCode).toBe(201);
    const redeem = await app.inject({
      method: "POST",
      url: `/invites/${invite.json().invite.code}/redeem`,
      headers: auth(member.token),
    });
    expect(redeem.statusCode).toBe(200);
  }

  async function createCategory(serverId: string, actor: TestUser, name: string) {
    return app.inject({
      method: "POST",
      url: `/groups/${serverId}/categories`,
      headers: auth(actor.token),
      payload: { name },
    });
  }

  async function createChannel(
    serverId: string,
    owner: TestUser,
    name: string,
    categoryId?: string | null,
  ): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/channels`,
      headers: auth(owner.token),
      payload: { name, kind: "text", ...(categoryId === undefined ? {} : { categoryId }) },
    });
    expect(res.statusCode).toBe(201);
    return res.json().channel.id as string;
  }

  async function listChannels(serverId: string, actor: TestUser) {
    const res = await app.inject({
      method: "GET",
      url: `/groups/${serverId}/channels`,
      headers: auth(actor.token),
    });
    expect(res.statusCode).toBe(200);
    return res.json().channels as Array<{
      id: string;
      name: string;
      position: number;
      categoryId: string | null;
    }>;
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
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  beforeEach(() => {
    published.length = 0;
  });

  // =========================================================================
  // Categories
  // =========================================================================
  it("creates, renames, lists and deletes a category; deleting FREES its channels", async () => {
    const owner = await newUser("cat_o");
    const serverId = await makeServer(owner);

    const created = await createCategory(serverId, owner, "Text Channels");
    expect(created.statusCode).toBe(201);
    const categoryId = created.json().category.id as string;
    expect(created.json().category.position).toBe(0);
    expect(
      published.some((m) => m.groupId === serverId && m.event.type === "category.created"),
    ).toBe(true);

    const filed = await createChannel(serverId, owner, "general", categoryId);
    expect((await listChannels(serverId, owner)).find((c) => c.id === filed)?.categoryId).toBe(
      categoryId,
    );

    const renamed = await app.inject({
      method: "PATCH",
      url: `/categories/${categoryId}`,
      headers: auth(owner.token),
      payload: { name: "Chat" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().category.name).toBe("Chat");

    const listed = await app.inject({
      method: "GET",
      url: `/groups/${serverId}/categories`,
      headers: auth(owner.token),
    });
    expect(listed.statusCode).toBe(200);
    expect((listed.json().categories as Array<{ id: string }>).map((c) => c.id)).toContain(
      categoryId,
    );

    published.length = 0;
    const deleted = await app.inject({
      method: "DELETE",
      url: `/categories/${categoryId}`,
      headers: auth(owner.token),
    });
    expect(deleted.statusCode).toBe(204);

    // The channel SURVIVES and becomes uncategorized (ON DELETE SET NULL), and
    // the event names it so a client can move it without a full refetch.
    const after = await listChannels(serverId, owner);
    expect(after.find((c) => c.id === filed)).toBeDefined();
    expect(after.find((c) => c.id === filed)?.categoryId).toBeNull();
    const evt = published.find((m) => m.event.type === "category.deleted");
    expect(evt).toBeDefined();
    expect((evt!.event.payload as { channelIds: string[] }).channelIds).toContain(filed);
  });

  it("gates category management behind owner ∨ MANAGE_CHANNELS — reusing the existing bit", async () => {
    const owner = await newUser("cg_o");
    const plain = await newUser("cg_m");
    const mod = await newUser("cg_x");
    const serverId = await makeServer(owner);
    await join(serverId, owner, plain);
    await join(serverId, owner, mod);

    // A plain member cannot create one, but CAN read the list (they already see
    // the channels these group).
    const refused = await createCategory(serverId, plain, "Nope");
    expect(refused.statusCode).toBe(403);
    const readable = await app.inject({
      method: "GET",
      url: `/groups/${serverId}/categories`,
      headers: auth(plain.token),
    });
    expect(readable.statusCode).toBe(200);

    // Granting MANAGE_CHANNELS — the SAME bit that already governs channel
    // create/edit/delete/reorder — is enough; no new permission was invented.
    const role = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/roles`,
      headers: auth(owner.token),
      payload: { name: "curator", permissions: PERMISSIONS.MANAGE_CHANNELS },
    });
    expect(role.statusCode).toBe(201);
    const assigned = await app.inject({
      method: "PUT",
      url: `/groups/${serverId}/members/${mod.id}/roles`,
      headers: auth(owner.token),
      payload: { roleIds: [role.json().role.id] },
    });
    expect(assigned.statusCode).toBe(200);
    expect((await createCategory(serverId, mod, "Curated")).statusCode).toBe(201);

    // A non-member gets 404, never 403 — server existence is not leaked (§28).
    const stranger = await newUser("cg_s");
    expect((await createCategory(serverId, stranger, "Nope")).statusCode).toBe(404);
  });

  it("reorders categories AND channel placement in ONE call, and rejects foreign ids", async () => {
    const owner = await newUser("ro_o");
    const serverId = await makeServer(owner);

    const catA = (await createCategory(serverId, owner, "A")).json().category.id as string;
    const catB = (await createCategory(serverId, owner, "B")).json().category.id as string;
    const one = await createChannel(serverId, owner, "one", catA);
    const two = await createChannel(serverId, owner, "two", catA);

    published.length = 0;
    const res = await app.inject({
      method: "PATCH",
      url: `/groups/${serverId}/channel-order`,
      headers: auth(owner.token),
      payload: {
        // B first now…
        categoryIds: [catB, catA],
        // …and "two" moves ahead of "one", into category B.
        channels: [
          { channelId: two, categoryId: catB },
          { channelId: one, categoryId: null },
        ],
      },
    });
    expect(res.statusCode).toBe(204);

    const cats = await app.inject({
      method: "GET",
      url: `/groups/${serverId}/categories`,
      headers: auth(owner.token),
    });
    expect((cats.json().categories as Array<{ id: string }>).map((c) => c.id)).toEqual([
      catB,
      catA,
    ]);

    const channels = await listChannels(serverId, owner);
    expect(channels.find((c) => c.id === two)?.categoryId).toBe(catB);
    expect(channels.find((c) => c.id === one)?.categoryId).toBeNull();

    // ONE event states the whole new placement, so a client applies a single
    // consistent snapshot rather than reconciling two racing deltas.
    const evt = published.find((m) => m.event.type === "category.reordered");
    expect(evt).toBeDefined();
    const payload = evt!.event.payload as {
      categoryIds: string[];
      channels: Array<{ channelId: string; categoryId: string | null }>;
    };
    expect(payload.categoryIds).toEqual([catB, catA]);
    expect(payload.channels.map((c) => c.channelId).sort()).toEqual([one, two].sort());

    // A category from ANOTHER server can never be used to reposition this one's
    // channels — validated at the boundary, not silently ignored.
    const otherServer = await makeServer(owner);
    const foreign = (await createCategory(otherServer, owner, "Foreign")).json().category
      .id as string;
    const rejected = await app.inject({
      method: "PATCH",
      url: `/groups/${serverId}/channel-order`,
      headers: auth(owner.token),
      payload: { channels: [{ channelId: one, categoryId: foreign }] },
    });
    expect(rejected.statusCode).toBe(400);
  });

  // =========================================================================
  // Custom status
  // =========================================================================
  it("sets, expires and clears a custom status, and fans the change out user-scoped", async () => {
    const user = await newUser("cs_u");

    published.length = 0;
    const set = await app.inject({
      method: "PUT",
      url: "/users/me/custom-status",
      headers: auth(user.token),
      payload: { text: "  building demli  " },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().user.customStatus).toBe("building demli");
    expect(set.json().user.customStatusExpiresAt).toBeNull();

    const evt = published.find((m) => m.event.type === "user.custom_status_updated");
    expect(evt).toBeDefined();
    expect(evt!.userId).toBe(user.id);
    expect((evt!.event.payload as { text: string | null }).text).toBe("building demli");

    // PUBLIC: another user's read of the profile carries it.
    const viewer = await newUser("cs_v");
    const profile = await app.inject({
      method: "GET",
      url: `/users/${user.id}/profile`,
      headers: auth(viewer.token),
    });
    expect(profile.json().profile.user.customStatus).toBe("building demli");

    // An EXPIRED status reads as absent everywhere, with no sweep job: the
    // mapper applies the deadline on every projection.
    await repos.users.setCustomStatus(user.id, {
      text: "stale",
      expiresAt: new Date(Date.now() - 60_000),
    });
    const expired = await app.inject({
      method: "GET",
      url: "/users/me",
      headers: auth(user.token),
    });
    expect(expired.json().user.customStatus).toBeNull();
    expect(expired.json().user.customStatusExpiresAt).toBeNull();

    // A live expiry is emitted alongside the text.
    const timed = await app.inject({
      method: "PUT",
      url: "/users/me/custom-status",
      headers: auth(user.token),
      payload: { text: "afk", expiresInMinutes: 30 },
    });
    expect(timed.json().user.customStatus).toBe("afk");
    expect(timed.json().user.customStatusExpiresAt).toBeTruthy();

    // Blank text CLEARS (founder rule: empty means clear) — and drops the expiry.
    const blanked = await app.inject({
      method: "PUT",
      url: "/users/me/custom-status",
      headers: auth(user.token),
      payload: { text: "   " },
    });
    expect(blanked.json().user.customStatus).toBeNull();
    expect(blanked.json().user.customStatusExpiresAt).toBeNull();

    // …as does the explicit DELETE.
    await app.inject({
      method: "PUT",
      url: "/users/me/custom-status",
      headers: auth(user.token),
      payload: { text: "back" },
    });
    const cleared = await app.inject({
      method: "DELETE",
      url: "/users/me/custom-status",
      headers: auth(user.token),
    });
    expect(cleared.json().user.customStatus).toBeNull();

    // Over-long input is rejected at the boundary, never truncated silently.
    const tooLong = await app.inject({
      method: "PUT",
      url: "/users/me/custom-status",
      headers: auth(user.token),
      payload: { text: "x".repeat(129) },
    });
    expect(tooLong.statusCode).toBe(400);
  });

  // =========================================================================
  // Moderation audit log
  // =========================================================================
  it("appends an audit row for kick / ban / unban and gates the log behind KICK_MEMBERS", async () => {
    const owner = await newUser("ml_o");
    const victim = await newUser("ml_v");
    const nosy = await newUser("ml_n");
    const serverId = await makeServer(owner);
    await join(serverId, owner, victim);
    await join(serverId, owner, nosy);

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/groups/${serverId}/members/${victim.id}/kick`,
          headers: auth(owner.token),
        })
      ).statusCode,
    ).toBe(204);

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/groups/${serverId}/bans`,
          headers: auth(owner.token),
          payload: { userId: victim.id, reason: "spam" },
        })
      ).statusCode,
    ).toBe(201);

    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/groups/${serverId}/bans/${victim.id}`,
          headers: auth(owner.token),
        })
      ).statusCode,
    ).toBe(204);

    const log = await app.inject({
      method: "GET",
      url: `/groups/${serverId}/moderation-log`,
      headers: auth(owner.token),
    });
    expect(log.statusCode).toBe(200);
    const entries = log.json().entries as Array<{
      action: { action: string; targetId: string; reason: string | null };
      actor: { id: string } | null;
      target: { id: string } | null;
    }>;
    // Newest first — unban, ban, kick. The log records what HAPPENED, including
    // the actions (kick, unban) that leave no lasting state in `group_bans`.
    expect(entries.slice(0, 3).map((e) => e.action.action)).toEqual(["unban", "ban", "kick"]);
    expect(entries[1]!.action.reason).toBe("spam");
    expect(entries.every((e) => e.action.targetId === victim.id)).toBe(true);
    // Hydrated for display, in one batched lookup.
    expect(entries[0]!.actor?.id).toBe(owner.id);
    expect(entries[0]!.target?.id).toBe(victim.id);

    // A plain member may not read it — same authority as the ban list.
    const refused = await app.inject({
      method: "GET",
      url: `/groups/${serverId}/moderation-log`,
      headers: auth(nosy.token),
    });
    expect(refused.statusCode).toBe(403);

    // A non-member gets 404, never 403.
    const stranger = await newUser("ml_s");
    const hidden = await app.inject({
      method: "GET",
      url: `/groups/${serverId}/moderation-log`,
      headers: auth(stranger.token),
    });
    expect(hidden.statusCode).toBe(404);
  });

  // =========================================================================
  // Group-DM invite links
  // =========================================================================
  it("group-DM invite link: any member creates, a stranger joins, the owner revokes", async () => {
    const owner = await newUser("gi_o");
    const member = await newUser("gi_m");
    const joiner = await newUser("gi_j");

    const created = await app.inject({
      method: "POST",
      url: "/group-chats",
      headers: auth(owner.token),
      payload: { name: `grp_${suffix}` },
    });
    expect(created.statusCode).toBe(201);
    const groupId = created.json().group.id as string;

    await app.inject({
      method: "POST",
      url: `/group-chats/${groupId}/members`,
      headers: auth(owner.token),
      payload: { username: member.username },
    });

    // ANY member may mint a link — a flat chat has no roles and no invite policy.
    const invite = await app.inject({
      method: "POST",
      url: `/group-chats/${groupId}/invites`,
      headers: auth(member.token),
      payload: { maxUses: 5 },
    });
    expect(invite.statusCode).toBe(201);
    const { code, id: inviteId } = invite.json().invite as { code: string; id: string };

    published.length = 0;
    const redeem = await app.inject({
      method: "POST",
      url: `/invites/${code}/redeem`,
      headers: auth(joiner.token),
    });
    expect(redeem.statusCode).toBe(200);
    expect(await repos.groups.getMembership(groupId, joiner.id)).not.toBeNull();

    // The joiner is reached USER-scoped with `group_chat.added` (a flat chat is
    // not in the gateway's group index, so a group-scoped event would reach
    // nobody) — and it carries the streamId the gateway subscribes them to.
    const added = published.filter(
      (m) => m.userId === joiner.id && m.event.type === "group_chat.added",
    );
    expect(added).toHaveLength(1);
    expect((added[0]!.event.payload as { group: { streamId: string } }).group.streamId)
      .toBeTruthy();
    // No "joined the server" system message — a flat chat has no membership feed.
    expect(published.some((m) => m.event.type === "message.created")).toBe(false);

    // The link is visible to members and revocable by the OWNER only.
    const listed = await app.inject({
      method: "GET",
      url: `/group-chats/${groupId}/invites`,
      headers: auth(member.token),
    });
    expect((listed.json().invites as Array<{ id: string }>).map((i) => i.id)).toContain(inviteId);

    const refusedRevoke = await app.inject({
      method: "DELETE",
      url: `/group-chats/${groupId}/invites/${inviteId}`,
      headers: auth(member.token),
    });
    expect(refusedRevoke.statusCode).toBe(403);

    const revoked = await app.inject({
      method: "DELETE",
      url: `/group-chats/${groupId}/invites/${inviteId}`,
      headers: auth(owner.token),
    });
    expect(revoked.statusCode).toBe(204);

    // A revoked code no longer resolves.
    const stranger = await newUser("gi_x");
    const dead = await app.inject({
      method: "POST",
      url: `/invites/${code}/redeem`,
      headers: auth(stranger.token),
    });
    expect(dead.statusCode).toBe(404);

    // A non-member can neither mint nor list links for the group.
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/group-chats/${groupId}/invites`,
          headers: auth(stranger.token),
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
  });
});
