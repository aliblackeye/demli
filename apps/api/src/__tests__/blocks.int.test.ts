/**
 * M18 — user blocking, EVERY surface (integration, ADR 0017).
 *
 * Real Postgres from docker-compose; auto-skipped (with a notice) when the
 * database is unreachable. Run `pnpm db:migrate` ONCE before `pnpm test` — a
 * brand-new migration racing across parallel suites collides on `pg_type`.
 *
 * The point of this suite is COVERAGE, not depth: a block that holds on five of
 * six surfaces is a broken block, so there is one test per surface the ADR
 * claims to cut, and they are named after the surface:
 *
 *   1. DM send — BOTH directions (blocker→blocked and blocked→blocker)
 *   2. Friend request (403) and add-by-username (404, same as an unknown handle)
 *   3. Mention + plain-channel push (neither reaches across a block)
 *   4. Message search (a blocked author's hits are excluded)
 *   5. Shared-server message history (server-side hide, not client-side)
 *   6. Group-DM add-by-username and group-DM invite-link redemption
 *   7. DM call start
 *
 * Plus the semantics the surfaces depend on: blocking severs the friendship,
 * the profile flag is one-directional, and unblocking restores everything.
 *
 * Presence + the Expo send are stubbed so the push assertions exercise the real
 * dispatcher without a live gateway or network.
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
  InMemoryPresenceReader,
  sessionExpiresAt,
  type DbClient,
  type RealtimeMutation,
  type Repositories,
} from "@demli/db";
import { createOfflineNotifier } from "@demli/notifications";
import type { PushNotification, PushService } from "@demli/notifications";
import { encodeMention } from "@demli/protocol";
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
  console.warn("[blocks.int.test] DATABASE unreachable — skipping integration tests");
}

interface PushCall {
  ids: string[];
  n: PushNotification;
}

describe.skipIf(!dbUp)("M18 blocking — every surface (ADR 0017)", () => {
  let client: DbClient;
  let repos: Repositories;
  let app: FastifyInstance;
  let bus: InMemoryMutationBus;

  const published: RealtimeMutation[] = [];
  const presence = new InMemoryPresenceReader();
  const pushCalls: PushCall[] = [];
  const push: PushService = {
    async sendToUsers(userIds, n) {
      pushCalls.push({ ids: [...userIds], n });
    },
  };

  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let seq = 0;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  interface TestUser {
    token: string;
    id: string;
    username: string;
  }

  /**
   * Create a user + session through the repo layer: `/auth/register` is
   * IP-rate-limited and this suite mints dozens of users. Per-route limits are
   * keyed by the Bearer token, so each user still gets its own bucket.
   */
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

  async function befriend(a: TestUser, b: TestUser): Promise<void> {
    const sent = await app.inject({
      method: "POST",
      url: "/friends/requests",
      headers: auth(a.token),
      payload: { userId: b.id },
    });
    expect(sent.statusCode).toBe(201);
    const accepted = await app.inject({
      method: "POST",
      url: `/friends/requests/${a.id}/accept`,
      headers: auth(b.token),
    });
    expect(accepted.statusCode).toBe(200);
  }

  async function openDm(a: TestUser, b: TestUser): Promise<{ id: string; streamId: string }> {
    const res = await app.inject({
      method: "POST",
      url: "/dms",
      headers: auth(a.token),
      payload: { userId: b.id },
    });
    expect([200, 201]).toContain(res.statusCode);
    return res.json().dm as { id: string; streamId: string };
  }

  function block(blocker: TestUser, target: TestUser) {
    return app.inject({
      method: "PUT",
      url: `/users/me/blocks/${target.id}`,
      headers: auth(blocker.token),
    });
  }

  function unblock(blocker: TestUser, target: TestUser) {
    return app.inject({
      method: "DELETE",
      url: `/users/me/blocks/${target.id}`,
      headers: auth(blocker.token),
    });
  }

  function send(channelId: string, sender: TestUser, content: string) {
    return app.inject({
      method: "POST",
      url: `/channels/${channelId}/messages`,
      headers: auth(sender.token),
      payload: { content },
    });
  }

  async function history(channelId: string, reader: TestUser): Promise<string[]> {
    const res = await app.inject({
      method: "GET",
      url: `/channels/${channelId}/messages`,
      headers: auth(reader.token),
    });
    expect(res.statusCode).toBe(200);
    return (res.json().messages as Array<{ content: string }>).map((m) => m.content);
  }

  async function search(channelId: string, reader: TestUser, q: string): Promise<string[]> {
    const res = await app.inject({
      method: "GET",
      url: `/channels/${channelId}/messages/search?q=${encodeURIComponent(q)}`,
      headers: auth(reader.token),
    });
    expect(res.statusCode).toBe(200);
    return (res.json().messages as Array<{ content: string }>).map((m) => m.content);
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

  async function createChannel(serverId: string, owner: TestUser, name = "general"): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/channels`,
      headers: auth(owner.token),
      payload: { name, kind: "text" },
    });
    expect(res.statusCode).toBe(201);
    return res.json().channel.id as string;
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
      notifier: createOfflineNotifier({ presence, push }),
      logger: false,
    });
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  beforeEach(() => {
    pushCalls.length = 0;
    published.length = 0;
  });

  // =========================================================================
  // Surface 1 — DM sending, BOTH directions
  // =========================================================================
  it("surface: DM send is refused in BOTH directions", async () => {
    const a = await newUser("dm_a");
    const b = await newUser("dm_b");
    await befriend(a, b);
    const dm = await openDm(a, b);

    // Baseline: both can talk before the block.
    expect((await send(dm.streamId, a, "before a")).statusCode).toBe(201);
    expect((await send(dm.streamId, b, "before b")).statusCode).toBe(201);

    expect((await block(a, b)).statusCode).toBe(201);

    // The BLOCKER cannot send…
    const fromBlocker = await send(dm.streamId, a, "after a");
    expect(fromBlocker.statusCode).toBe(403);
    expect(fromBlocker.json().error.code).toBe("BLOCKED");

    // …and neither can the BLOCKED user (the guard is symmetric).
    const fromBlocked = await send(dm.streamId, b, "after b");
    expect(fromBlocked.statusCode).toBe(403);
    expect(fromBlocked.json().error.code).toBe("BLOCKED");

    // Both refusals carry the SAME code + copy: which side blocked is never
    // disclosed (§28).
    expect(fromBlocked.json().error.message).toBe(fromBlocker.json().error.message);

    // Unblocking restores both directions.
    expect((await unblock(a, b)).statusCode).toBe(204);
    expect((await send(dm.streamId, a, "restored a")).statusCode).toBe(201);
    expect((await send(dm.streamId, b, "restored b")).statusCode).toBe(201);
  });

  it("surface: opening a DM is refused across a block", async () => {
    const a = await newUser("dmo_a");
    const b = await newUser("dmo_b");
    await befriend(a, b);
    await block(a, b);

    for (const [caller, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const res = await app.inject({
        method: "POST",
        url: "/dms",
        headers: auth(caller.token),
        payload: { userId: other.id },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("BLOCKED");
    }
  });

  // =========================================================================
  // Surface 2 — friend requests (explicit) + add-by-username (silent)
  // =========================================================================
  it("surface: friend request by id is refused both ways; blocking severs an existing friendship", async () => {
    const a = await newUser("fr_a");
    const b = await newUser("fr_b");
    await befriend(a, b);

    published.length = 0;
    expect((await block(a, b)).statusCode).toBe(201);

    // Blocking removed the friendship and told the other side, using the SAME
    // `friend.removed` payload an ordinary unfriend uses — so B's client cannot
    // distinguish a block from an unfriend (§28).
    const removed = published.filter(
      (m) => m.userId === b.id && m.event.type === "friend.removed",
    );
    expect(removed).toHaveLength(1);
    const friendsOfA = await app.inject({
      method: "GET",
      url: "/friends",
      headers: auth(a.token),
    });
    expect(
      (friendsOfA.json().friends as Array<{ user: { id: string } }>).some(
        (f) => f.user.id === b.id,
      ),
    ).toBe(false);

    // A fresh request is refused in both directions.
    for (const [from, to] of [
      [a, b],
      [b, a],
    ] as const) {
      const res = await app.inject({
        method: "POST",
        url: "/friends/requests",
        headers: auth(from.token),
        payload: { userId: to.id },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("BLOCKED");
    }
  });

  it("surface: add-by-username across a block answers BLOCKED, exactly like add-by-userId", async () => {
    const a = await newUser("bu_a");
    const b = await newUser("bu_b");
    await block(a, b);
    presence.setOffline(a.id);
    presence.setOffline(b.id);
    published.length = 0;
    pushCalls.length = 0;

    // The BLOCKED user tries to add the blocker by username.
    const res = await app.inject({
      method: "POST",
      url: "/friends/requests/by-username",
      headers: auth(b.token),
      payload: { username: a.username },
    });
    // BLOCKED — the same neutral code the by-userId path above returns, so one
    // action does not answer two different ways depending on which field the
    // client happened to send.
    //
    // This route briefly folded the block into USER_NOT_FOUND, on the theory that
    // looking like an unknown handle hides the block better. It is backwards:
    // that only holds for someone who does not already know the account exists,
    // and you generally block people you have interacted with — so a 404 for a
    // handle they have seen reads as "they blocked me". ADR 0017's rule is that a
    // block never reveals WHO blocked WHOM, which BLOCKED satisfies (identical
    // both ways) while saying nothing a DM attempt would not say a moment later.
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("BLOCKED");

    // …and nothing was created, fanned out, or pushed.
    expect(published.filter((m) => m.event.type === "friend.request_received")).toHaveLength(0);
    expect(pushCalls).toHaveLength(0);
    const incoming = await app.inject({
      method: "GET",
      url: "/friends/requests?direction=incoming",
      headers: auth(a.token),
    });
    expect(incoming.json().requests).toHaveLength(0);
  });

  // =========================================================================
  // Surface 3 — mention + channel push
  // =========================================================================
  it("surface: neither the mention push nor the plain channel push crosses a block", async () => {
    const owner = await newUser("pu_o");
    const blocker = await newUser("pu_b");
    const nosy = await newUser("pu_n");
    const serverId = await makeServer(owner);
    await join(serverId, owner, blocker);
    await join(serverId, owner, nosy);
    const channelId = await createChannel(serverId, owner);

    // `blocker` blocks `nosy`; everyone is offline so every push is eligible.
    expect((await block(blocker, nosy)).statusCode).toBe(201);
    presence.setOffline(owner.id);
    presence.setOffline(blocker.id);
    presence.setOffline(nosy.id);

    // 1. `nosy` @mentions `blocker` — the mention must not ring the phone of the
    //    person who blocked them.
    pushCalls.length = 0;
    expect(
      (await send(channelId, nosy, `hey ${encodeMention(blocker.id)} answer me`)).statusCode,
    ).toBe(201);
    const pushedIds = pushCalls.flatMap((c) => c.ids);
    expect(pushedIds).not.toContain(blocker.id);
    // The uninvolved owner still gets their normal channel push — the block is
    // targeted, not a broadcast mute.
    expect(pushedIds).toContain(owner.id);

    // 2. The reverse direction: the blocker's own plain message must not push
    //    the user they blocked either.
    pushCalls.length = 0;
    expect((await send(channelId, blocker, "morning all")).statusCode).toBe(201);
    const reverseIds = pushCalls.flatMap((c) => c.ids);
    expect(reverseIds).not.toContain(nosy.id);
    expect(reverseIds).toContain(owner.id);
  });

  // =========================================================================
  // Surfaces 4 + 5 — search and shared-server history (SERVER-SIDE hide)
  // =========================================================================
  it("surface: shared-server history and search both hide a blocked author, server-side", async () => {
    const owner = await newUser("hs_o");
    const reader = await newUser("hs_r");
    const noisy = await newUser("hs_n");
    const serverId = await makeServer(owner);
    await join(serverId, owner, reader);
    await join(serverId, owner, noisy);
    const channelId = await createChannel(serverId, owner);

    expect((await send(channelId, noisy, "zebrafish migration notes")).statusCode).toBe(201);
    expect((await send(channelId, owner, "zebrafish are fine")).statusCode).toBe(201);

    // Before the block the reader sees both.
    expect(await history(channelId, reader)).toEqual(
      expect.arrayContaining(["zebrafish migration notes", "zebrafish are fine"]),
    );
    expect(await search(channelId, reader, "zebrafish")).toHaveLength(2);

    expect((await block(reader, noisy)).statusCode).toBe(201);

    // The blocked author's message is GONE from the payload — not flagged for
    // the client to hide. That is the ADR 0017 decision: server-side, no leak.
    const after = await history(channelId, reader);
    expect(after).toContain("zebrafish are fine");
    expect(after).not.toContain("zebrafish migration notes");

    const hits = await search(channelId, reader, "zebrafish");
    expect(hits).toEqual(["zebrafish are fine"]);

    // Everyone else is unaffected — a block is per-viewer, never global.
    expect(await history(channelId, owner)).toEqual(
      expect.arrayContaining(["zebrafish migration notes", "zebrafish are fine"]),
    );

    // Unblocking brings the history back (nothing was destroyed, only filtered).
    expect((await unblock(reader, noisy)).statusCode).toBe(204);
    expect(await history(channelId, reader)).toContain("zebrafish migration notes");
  });

  it("surface: a reply QUOTING a blocked author is redacted, not leaked through the preview", async () => {
    const owner = await newUser("rq_o");
    const reader = await newUser("rq_r");
    const noisy = await newUser("rq_n");
    const serverId = await makeServer(owner);
    await join(serverId, owner, reader);
    await join(serverId, owner, noisy);
    const channelId = await createChannel(serverId, owner);

    const original = await send(channelId, noisy, "secret sauce recipe");
    expect(original.statusCode).toBe(201);
    const originalId = original.json().message.id as string;

    const reply = await app.inject({
      method: "POST",
      url: `/channels/${channelId}/messages`,
      headers: auth(owner.token),
      payload: { content: "good point", replyToMessageId: originalId },
    });
    expect(reply.statusCode).toBe(201);

    expect((await block(reader, noisy)).statusCode).toBe(201);

    const res = await app.inject({
      method: "GET",
      url: `/channels/${channelId}/messages`,
      headers: auth(reader.token),
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().messages as Array<{
      content: string;
      replyTo?: { content: string; deleted: boolean } | null;
    }>;
    const visibleReply = rows.find((m) => m.content === "good point");
    expect(visibleReply).toBeDefined();
    // The quote box renders the existing "deleted" stub instead of the blocked
    // user's words — otherwise the block would leak through someone else's reply.
    expect(visibleReply!.replyTo?.content).toBe("");
    expect(visibleReply!.replyTo?.deleted).toBe(true);
  });

  // =========================================================================
  // Surface 6 — group DM: add-by-username AND invite link
  // =========================================================================
  it("surface: a group DM cannot be joined across a block, by username or by invite link", async () => {
    const owner = await newUser("gc_o");
    const outsider = await newUser("gc_x");
    expect((await block(owner, outsider)).statusCode).toBe(201);

    const created = await app.inject({
      method: "POST",
      url: "/group-chats",
      headers: auth(owner.token),
      payload: { name: `grp_${suffix}` },
    });
    expect(created.statusCode).toBe(201);
    const groupId = created.json().group.id as string;

    // a) add-by-username is refused.
    const added = await app.inject({
      method: "POST",
      url: `/group-chats/${groupId}/members`,
      headers: auth(owner.token),
      payload: { username: outsider.username },
    });
    expect(added.statusCode).toBe(403);
    expect(added.json().error.code).toBe("BLOCKED");

    // b) …and so is the invite LINK, which is the new M18 way in.
    const invite = await app.inject({
      method: "POST",
      url: `/group-chats/${groupId}/invites`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(invite.statusCode).toBe(201);
    const code = invite.json().invite.code as string;

    const redeem = await app.inject({
      method: "POST",
      url: `/invites/${code}/redeem`,
      headers: auth(outsider.token),
    });
    expect(redeem.statusCode).toBe(403);
    expect(redeem.json().error.code).toBe("BLOCKED");
    expect(await repos.groups.getMembership(groupId, outsider.id)).toBeNull();

    // Lifting the block lets the SAME link through — the invite itself was never
    // consumed or invalidated by the refusal.
    expect((await unblock(owner, outsider)).statusCode).toBe(204);
    const retry = await app.inject({
      method: "POST",
      url: `/invites/${code}/redeem`,
      headers: auth(outsider.token),
    });
    expect(retry.statusCode).toBe(200);
    expect(await repos.groups.getMembership(groupId, outsider.id)).not.toBeNull();
  });

  // =========================================================================
  // Surface 7 — DM calls
  // =========================================================================
  it("surface: starting a DM call is refused across a block", async () => {
    const a = await newUser("cl_a");
    const b = await newUser("cl_b");
    await befriend(a, b);
    const dm = await openDm(a, b);

    expect((await block(b, a)).statusCode).toBe(201);

    for (const caller of [a, b]) {
      const res = await app.inject({
        method: "POST",
        url: "/dm-calls",
        headers: auth(caller.token),
        payload: { dmId: dm.id, media: "audio" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("BLOCKED");
    }
  });

  // =========================================================================
  // Block bookkeeping: list, profile flag, self-block, idempotency, resync event
  // =========================================================================
  it("lists my blocks, is idempotent, refuses self-block, and publishes the resync signal", async () => {
    const a = await newUser("bk_a");
    const b = await newUser("bk_b");

    const self = await app.inject({
      method: "PUT",
      url: `/users/me/blocks/${a.id}`,
      headers: auth(a.token),
    });
    expect(self.statusCode).toBe(400);

    published.length = 0;
    expect((await block(a, b)).statusCode).toBe(201);
    // Idempotent: blocking twice is not an error and does not duplicate.
    expect((await block(a, b)).statusCode).toBe(201);

    const list = await app.inject({
      method: "GET",
      url: "/users/me/blocks",
      headers: auth(a.token),
    });
    expect(list.statusCode).toBe(200);
    const blocks = list.json().blocks as Array<{ user: { id: string } }>;
    expect(blocks.filter((x) => x.user.id === b.id)).toHaveLength(1);

    // The RESYNC signal goes to the blocker's OWN devices only — never to the
    // person who was blocked (§28).
    const resync = published.filter((m) => m.event.type === "user.blocks_updated");
    expect(resync.length).toBeGreaterThan(0);
    expect(resync.every((m) => m.userId === a.id)).toBe(true);

    // The blocked user's list is untouched — blocking is directional to write.
    const theirList = await app.inject({
      method: "GET",
      url: "/users/me/blocks",
      headers: auth(b.token),
    });
    expect(theirList.json().blocks).toHaveLength(0);

    // Unblocking something not blocked is a 404, not a silent success.
    expect((await unblock(b, a)).statusCode).toBe(404);
  });

  it("profile exposes `blocked` one-directionally — never 'they blocked you'", async () => {
    const a = await newUser("pf_a");
    const b = await newUser("pf_b");
    expect((await block(a, b)).statusCode).toBe(201);

    const mine = await app.inject({
      method: "GET",
      url: `/users/${b.id}/profile`,
      headers: auth(a.token),
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().profile.blocked).toBe(true);

    // B looks at A's card: A blocked THEM, but the card must not say so — B has
    // blocked nobody, so their view reads false.
    const theirs = await app.inject({
      method: "GET",
      url: `/users/${a.id}/profile`,
      headers: auth(b.token),
    });
    expect(theirs.statusCode).toBe(200);
    expect(theirs.json().profile.blocked).toBe(false);
  });
});
