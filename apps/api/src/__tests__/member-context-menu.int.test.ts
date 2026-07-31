/**
 * Member context menu — notes, the two nicknames, timeout, ignore (migration
 * 0020, ADR 0019). Integration, real Postgres from docker-compose; auto-skipped
 * with a notice when the database is unreachable. Run `pnpm db:migrate` ONCE
 * before `pnpm test` — a brand-new migration racing across suites collides on
 * `pg_type`.
 *
 * Like `blocks.int.test.ts`, this suite is about COVERAGE of the claims the ADR
 * makes, not depth on any one of them. Each claim that could silently rot has
 * its own test, named after the claim:
 *
 *   1. NOTE PRIVACY — the target can never see a note written about them, on any
 *      endpoint. Asserted by driving the TARGET's own token, not by inspecting
 *      the writer's response.
 *   2. NICKNAME DUALITY — a private nickname is invisible to everyone else; a
 *      server nickname is visible to the whole server; setting someone else's
 *      server nickname without MANAGE_NICKNAMES is refused.
 *   3. TIMEOUT ENFORCEMENT — one test per path the ADR claims to cut (message,
 *      reaction, voice token), because a mute that holds on two of three is not
 *      a mute. Plus: it self-expires with no sweeper, and it is audited.
 *   4. IGNORE — kills the notification but sends the ignored user NO signal at
 *      all, and (unlike a block) refuses nothing and hides no history.
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
import { encodeMention, SERVER_EVENT } from "@demli/protocol";
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
  console.warn("[member-context-menu.int.test] DATABASE unreachable — skipping");
}

interface PushCall {
  ids: string[];
  n: PushNotification;
}

describe.skipIf(!dbUp)("member context menu (migration 0020, ADR 0019)", () => {
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

  async function makeServer(owner: TestUser): Promise<string> {
    seq += 1;
    const res = await app.inject({
      method: "POST",
      url: "/groups",
      headers: auth(owner.token),
      payload: { name: `srv_${suffix}_${seq}` },
    });
    expect(res.statusCode).toBe(201);
    return res.json().group.id as string;
  }

  async function createChannel(
    serverId: string,
    owner: TestUser,
    kind: "text" | "voice" = "text",
  ): Promise<string> {
    seq += 1;
    const res = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/channels`,
      headers: auth(owner.token),
      payload: { name: `ch${seq}`, kind },
    });
    expect(res.statusCode).toBe(201);
    return res.json().channel.id as string;
  }

  /**
   * One member's row as `viewer` sees it on the server roster (`GET /groups/:id`
   * carries `members`). Returns the PARSED row so assertions can name a field
   * instead of substring-searching a body — a 404 or a renamed field then fails
   * the test rather than silently satisfying a `not.toContain`.
   */
  async function memberOnRoster(
    groupId: string,
    viewer: TestUser,
    userId: string,
  ): Promise<{ userId: string; nickname: string | null; timedOutUntil: string | null } | undefined> {
    const res = await app.inject({
      method: "GET",
      url: `/groups/${groupId}`,
      headers: auth(viewer.token),
    });
    expect(res.statusCode).toBe(200);
    const members = res.json().members as Array<{
      userId: string;
      nickname: string | null;
      timedOutUntil: string | null;
    }>;
    return members.find((m) => m.userId === userId);
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

  /** Grant `target` a role carrying exactly `bits` in `serverId`. */
  async function grant(
    serverId: string,
    owner: TestUser,
    target: TestUser,
    bits: number,
  ): Promise<void> {
    seq += 1;
    const role = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/roles`,
      headers: auth(owner.token),
      payload: { name: `role${seq}`, permissions: bits },
    });
    expect(role.statusCode).toBe(201);
    const assign = await app.inject({
      method: "PUT",
      url: `/groups/${serverId}/members/${target.id}/roles`,
      headers: auth(owner.token),
      payload: { roleIds: [role.json().role.id] },
    });
    expect(assign.statusCode).toBe(200);
  }

  function send(channelId: string, sender: TestUser, content: string) {
    return app.inject({
      method: "POST",
      url: `/channels/${channelId}/messages`,
      headers: auth(sender.token),
      payload: { content },
    });
  }

  function timeout(serverId: string, actor: TestUser, target: TestUser, minutes: number) {
    return app.inject({
      method: "POST",
      url: `/groups/${serverId}/members/${target.id}/timeout`,
      headers: auth(actor.token),
      payload: { minutes },
    });
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
  // 1 — NOTE PRIVACY
  // =========================================================================

  it("note: the TARGET can never see a note written about them, on any endpoint", async () => {
    const writer = await newUser("note_w");
    const target = await newUser("note_t");
    // Share a server, so the target has every projection a co-member can reach:
    // profile card, member roster, moderation log.
    const serverId = await makeServer(writer);
    await join(serverId, writer, target);

    const secret = "do not trust this person with the aux cable";
    const saved = await app.inject({
      method: "PUT",
      url: `/users/${target.id}/note`,
      headers: auth(writer.token),
      payload: { body: secret },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().note.body).toBe(secret);

    // The writer reads it back — the ONE path that is allowed to return it.
    const mine = await app.inject({
      method: "GET",
      url: `/users/${target.id}/note`,
      headers: auth(writer.token),
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().note.body).toBe(secret);

    // --- Everything below drives the TARGET's own token. ---

    // (a) The target asking for "the note on the writer" gets THEIR note on the
    //     writer — which is nothing. The endpoint cannot express the other
    //     question, which is the design (viewerId is the session, never input).
    const reversed = await app.inject({
      method: "GET",
      url: `/users/${writer.id}/note`,
      headers: auth(target.token),
    });
    expect(reversed.statusCode).toBe(200);
    expect(reversed.json().note).toBeNull();

    // (b) Asking for the note "on themselves" is likewise empty, not the secret.
    const onSelf = await app.inject({
      method: "GET",
      url: `/users/${target.id}/note`,
      headers: auth(target.token),
    });
    expect(onSelf.statusCode).toBe(200);
    expect(onSelf.json().note).toBeNull();

    // (c) The secret appears in NO body the target can fetch. Serializing each
    //     response and substring-searching is deliberately blunt: it catches a
    //     future field added to a projection, which a field-by-field assertion
    //     would sail straight past.
    const targetReadable = [
      await app.inject({ method: "GET", url: "/users/me", headers: auth(target.token) }),
      await app.inject({
        method: "GET",
        url: `/users/${target.id}/profile`,
        headers: auth(target.token),
      }),
      await app.inject({
        method: "GET",
        url: `/users/${writer.id}/profile`,
        headers: auth(target.token),
      }),
      // `GET /groups/:id` carries the whole roster — the widest member
      // projection a co-member can reach.
      await app.inject({
        method: "GET",
        url: `/groups/${serverId}`,
        headers: auth(target.token),
      }),
      await app.inject({
        method: "GET",
        url: `/groups/${serverId}/moderation-log`,
        headers: auth(target.token),
      }),
      await app.inject({
        method: "GET",
        url: "/users/me/nicknames",
        headers: auth(target.token),
      }),
    ];
    for (const res of targetReadable) {
      // Each must be a REAL response, not a 404 that trivially lacks the string.
      expect(res.statusCode).toBeLessThan(500);
      expect(res.body).not.toContain(secret);
    }

    // (d) And nothing about a note was ever published on the realtime bus —
    //     private text must not travel a fan-out path at all (ADR 0019 §1).
    expect(published.some((m) => JSON.stringify(m).includes(secret))).toBe(false);
  });

  it("note: empty or null body deletes the row rather than storing blank text", async () => {
    const writer = await newUser("note_c");
    const target = await newUser("note_d");

    await app.inject({
      method: "PUT",
      url: `/users/${target.id}/note`,
      headers: auth(writer.token),
      payload: { body: "temporary" },
    });

    const cleared = await app.inject({
      method: "PUT",
      url: `/users/${target.id}/note`,
      headers: auth(writer.token),
      payload: { body: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().note).toBeNull();
    expect(await repos.userNotes.getNote(writer.id, target.id)).toBeNull();

    // Whitespace-only is the same thing: the schema sanitizes it to "" and the
    // route treats that as a delete, so a blank row can never exist.
    await app.inject({
      method: "PUT",
      url: `/users/${target.id}/note`,
      headers: auth(writer.token),
      payload: { body: "again" },
    });
    const blank = await app.inject({
      method: "PUT",
      url: `/users/${target.id}/note`,
      headers: auth(writer.token),
      payload: { body: "   " },
    });
    expect(blank.statusCode).toBe(200);
    expect(await repos.userNotes.getNote(writer.id, target.id)).toBeNull();
  });

  it("note: over the length cap is a 400, and self-notes are refused", async () => {
    const writer = await newUser("note_x");
    const target = await newUser("note_y");

    const tooLong = await app.inject({
      method: "PUT",
      url: `/users/${target.id}/note`,
      headers: auth(writer.token),
      payload: { body: "x".repeat(257) },
    });
    expect(tooLong.statusCode).toBe(400);

    const onSelf = await app.inject({
      method: "PUT",
      url: `/users/${writer.id}/note`,
      headers: auth(writer.token),
      payload: { body: "note to self" },
    });
    expect(onSelf.statusCode).toBe(400);
  });

  // =========================================================================
  // 2 — NICKNAME DUALITY
  // =========================================================================

  it("nickname: the PRIVATE one is visible only to its author, never to anyone else", async () => {
    const viewer = await newUser("nick_v");
    const target = await newUser("nick_t");
    const bystander = await newUser("nick_b");
    const serverId = await makeServer(viewer);
    await join(serverId, viewer, target);
    await join(serverId, viewer, bystander);

    const label = "aux-cable-guy";
    const set = await app.inject({
      method: "PUT",
      url: `/users/${target.id}/nickname`,
      headers: auth(viewer.token),
      payload: { nickname: label },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().nickname).toBe(label);

    // The author sees it in their own bulk sync…
    const mine = await app.inject({
      method: "GET",
      url: "/users/me/nicknames",
      headers: auth(viewer.token),
    });
    expect(mine.statusCode).toBe(200);
    const entries = mine.json().nicknames as Array<{ user: { id: string }; nickname: string }>;
    expect(entries.find((e) => e.user.id === target.id)?.nickname).toBe(label);

    // …and NOBODY else does, including the person renamed.
    for (const other of [target, bystander]) {
      const theirs = await app.inject({
        method: "GET",
        url: "/users/me/nicknames",
        headers: auth(other.token),
      });
      expect(theirs.statusCode).toBe(200);
      expect(theirs.json().nicknames).toHaveLength(0);

      // The roster they CAN see (asserted 200 inside the helper, so this cannot
      // pass by accident on an error body) carries no trace of the private label.
      const row = await memberOnRoster(serverId, other, target.id);
      expect(row).toBeDefined();
      expect(row?.nickname ?? null).toBeNull();
    }

    // The resync event is USER-scoped to the AUTHOR alone — it must never be
    // addressed to the person who was renamed.
    const nickEvents = published.filter(
      (m) => m.event.type === SERVER_EVENT.userNicknameUpdated,
    );
    expect(nickEvents).toHaveLength(1);
    expect(nickEvents[0]?.userId).toBe(viewer.id);
    expect(nickEvents[0]?.groupId).toBeUndefined();
  });

  it("nickname: the SERVER one is visible to the whole server", async () => {
    const owner = await newUser("snick_o");
    const member = await newUser("snick_m");
    const serverId = await makeServer(owner);
    await join(serverId, owner, member);

    // A member may always set their OWN server nickname — no permission bit.
    const own = await app.inject({
      method: "PUT",
      url: `/groups/${serverId}/members/${member.id}/nickname`,
      headers: auth(member.token),
      payload: { nickname: "Speedy" },
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().member.nickname).toBe("Speedy");

    // …and everyone ELSE in the server sees it on the roster, which is the whole
    // difference from the private nickname above. Asserted on the parsed field
    // rather than a substring, so a nickname that merely happened to appear
    // somewhere in the payload could not pass this.
    const seen = await memberOnRoster(serverId, owner, member.id);
    expect(seen?.nickname).toBe("Speedy");

    // Group-scoped fan-out, not user-scoped.
    const evt = published.find((m) => m.event.type === SERVER_EVENT.memberNicknameUpdated);
    expect(evt?.groupId).toBe(serverId);
    expect(evt?.userId).toBeUndefined();

    // Clearing falls back to the display name.
    const cleared = await app.inject({
      method: "PUT",
      url: `/groups/${serverId}/members/${member.id}/nickname`,
      headers: auth(member.token),
      payload: { nickname: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().member.nickname).toBeNull();
  });

  it("nickname: changing ANOTHER member's server nickname needs MANAGE_NICKNAMES", async () => {
    const owner = await newUser("perm_o");
    const plain = await newUser("perm_p");
    const victim = await newUser("perm_v");
    const serverId = await makeServer(owner);
    await join(serverId, owner, plain);
    await join(serverId, owner, victim);

    // A member with no roles cannot rename someone else.
    const refused = await app.inject({
      method: "PUT",
      url: `/groups/${serverId}/members/${victim.id}/nickname`,
      headers: auth(plain.token),
      payload: { nickname: "Renamed" },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe("FORBIDDEN");
    expect((await repos.groups.getMembership(serverId, victim.id))?.nickname ?? null).toBeNull();

    // Neither can a member holding an UNRELATED bit — this is the assertion
    // that would fail if the route had been gated on KICK_MEMBERS instead.
    await grant(serverId, owner, plain, PERMISSIONS.KICK_MEMBERS);
    const stillRefused = await app.inject({
      method: "PUT",
      url: `/groups/${serverId}/members/${victim.id}/nickname`,
      headers: auth(plain.token),
      payload: { nickname: "Renamed" },
    });
    expect(stillRefused.statusCode).toBe(403);

    // With the right bit it works.
    const mod = await newUser("perm_m");
    await join(serverId, owner, mod);
    await grant(serverId, owner, mod, PERMISSIONS.MANAGE_NICKNAMES);
    const allowed = await app.inject({
      method: "PUT",
      url: `/groups/${serverId}/members/${victim.id}/nickname`,
      headers: auth(mod.token),
      payload: { nickname: "Renamed" },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().member.nickname).toBe("Renamed");

    // But never the owner's — the same immunity kick and ban have.
    const atOwner = await app.inject({
      method: "PUT",
      url: `/groups/${serverId}/members/${owner.id}/nickname`,
      headers: auth(mod.token),
      payload: { nickname: "Not The Owner" },
    });
    expect(atOwner.statusCode).toBe(403);
  });

  // =========================================================================
  // 3 — TIMEOUT ENFORCEMENT (one test per path, on purpose)
  // =========================================================================

  it("timeout: REALLY blocks sending a message", async () => {
    const owner = await newUser("to_msg_o");
    const muted = await newUser("to_msg_m");
    const serverId = await makeServer(owner);
    await join(serverId, owner, muted);
    const channelId = await createChannel(serverId, owner);

    // Baseline: they can speak.
    expect((await send(channelId, muted, "before")).statusCode).toBe(201);

    const applied = await timeout(serverId, owner, muted, 60);
    expect(applied.statusCode).toBe(200);
    expect(applied.json().member.timedOutUntil).toBeTruthy();

    const refused = await send(channelId, muted, "after");
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe("TIMED_OUT");

    // NOTHING was persisted — the gate runs before the write, so a refused send
    // must not leave a row behind.
    const page = await app.inject({
      method: "GET",
      url: `/channels/${channelId}/messages`,
      headers: auth(owner.token),
    });
    const contents = (page.json().messages as Array<{ content: string }>).map((m) => m.content);
    expect(contents).toContain("before");
    expect(contents).not.toContain("after");

    // Everyone else is unaffected — a timeout is scoped to one member.
    expect((await send(channelId, owner, "owner still talks")).statusCode).toBe(201);
  });

  it("timeout: REALLY blocks adding a reaction (but not removing your own)", async () => {
    const owner = await newUser("to_rx_o");
    const muted = await newUser("to_rx_m");
    const serverId = await makeServer(owner);
    await join(serverId, owner, muted);
    const channelId = await createChannel(serverId, owner);

    const posted = await send(channelId, owner, "react to me");
    const messageId = posted.json().message.id as string;

    // Baseline: they can react, and we leave one reaction in place so the
    // removal half of the rule has something to remove.
    const before = await app.inject({
      method: "PUT",
      url: `/messages/${messageId}/reactions/${encodeURIComponent("👍")}`,
      headers: auth(muted.token),
    });
    expect(before.statusCode).toBe(200);

    expect((await timeout(serverId, owner, muted, 60)).statusCode).toBe(200);

    const refused = await app.inject({
      method: "PUT",
      url: `/messages/${messageId}/reactions/${encodeURIComponent("🎉")}`,
      headers: auth(muted.token),
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe("TIMED_OUT");

    // Removing a reaction they already left stays allowed: a timeout silences
    // someone, it does not trap them with what they already said (ADR 0019 §3).
    const removal = await app.inject({
      method: "DELETE",
      url: `/messages/${messageId}/reactions/${encodeURIComponent("👍")}`,
      headers: auth(muted.token),
    });
    expect(removal.statusCode).toBe(200);
  });

  it("timeout: REALLY blocks joining voice (the token is never minted)", async () => {
    const owner = await newUser("to_vc_o");
    const muted = await newUser("to_vc_m");
    const serverId = await makeServer(owner);
    await join(serverId, owner, muted);
    const voiceId = await createChannel(serverId, owner, "voice");

    // Baseline: a token is issued.
    const before = await app.inject({
      method: "POST",
      url: "/media/token",
      headers: auth(muted.token),
      payload: { channelId: voiceId },
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().token).toBeTruthy();

    expect((await timeout(serverId, owner, muted, 60)).statusCode).toBe(200);

    // Now there is no token at all — which IS the block, since the SFU admits
    // nobody without one.
    const refused = await app.inject({
      method: "POST",
      url: "/media/token",
      headers: auth(muted.token),
      payload: { channelId: voiceId },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe("TIMED_OUT");
    expect(refused.body).not.toContain("token");
  });

  it("timeout: lapses on its own with no sweeper, and lifts early on request", async () => {
    const owner = await newUser("to_exp_o");
    const muted = await newUser("to_exp_m");
    const serverId = await makeServer(owner);
    await join(serverId, owner, muted);
    const channelId = await createChannel(serverId, owner);

    // Write an ALREADY-EXPIRED timeout straight through the repo. The API caps
    // `minutes` at 1 minimum, and this suite must not sleep — the point being
    // proved is that expiry is a query-time comparison, so a past instant is
    // indistinguishable from no timeout with nothing having run in between.
    await repos.groups.setMemberTimeout(serverId, muted.id, new Date(Date.now() - 1000));
    expect((await send(channelId, muted, "lapsed")).statusCode).toBe(201);

    // A FUTURE timeout still bites…
    expect((await timeout(serverId, owner, muted, 60)).statusCode).toBe(200);
    expect((await send(channelId, muted, "muted")).statusCode).toBe(403);

    // …and lifting it early restores speech immediately.
    published.length = 0;
    const lifted = await app.inject({
      method: "DELETE",
      url: `/groups/${serverId}/members/${muted.id}/timeout`,
      headers: auth(owner.token),
    });
    expect(lifted.statusCode).toBe(204);
    expect((await send(channelId, muted, "free")).statusCode).toBe(201);

    const evt = published.find((m) => m.event.type === SERVER_EVENT.memberTimeoutUpdated);
    expect(evt?.groupId).toBe(serverId);
    if (evt?.event.type === SERVER_EVENT.memberTimeoutUpdated) {
      expect(evt.event.payload.timedOutUntil).toBeNull();
    }
  });

  it("timeout: is permission-gated, owner-immune, and audited", async () => {
    const owner = await newUser("to_perm_o");
    const plain = await newUser("to_perm_p");
    const victim = await newUser("to_perm_v");
    const serverId = await makeServer(owner);
    await join(serverId, owner, plain);
    await join(serverId, owner, victim);

    // No permission → 403, and no state change.
    const refused = await timeout(serverId, plain, victim, 30);
    expect(refused.statusCode).toBe(403);
    expect(
      (await repos.groups.getMembership(serverId, victim.id))?.timedOutUntil ?? null,
    ).toBeNull();

    // KICK_MEMBERS is the gate — a timeout is weaker than the kick that bit
    // already allows, so it grants no new authority (ADR 0019 §3).
    await grant(serverId, owner, plain, PERMISSIONS.KICK_MEMBERS);
    expect((await timeout(serverId, plain, victim, 30)).statusCode).toBe(200);

    // The owner is immune, and nobody can time themselves out.
    expect((await timeout(serverId, plain, owner, 30)).statusCode).toBe(403);
    expect((await timeout(serverId, plain, plain, 30)).statusCode).toBe(400);

    // Out-of-range durations are refused by the shared schema.
    expect((await timeout(serverId, owner, victim, 0)).statusCode).toBe(400);
    expect((await timeout(serverId, owner, victim, 28 * 24 * 60 + 1)).statusCode).toBe(400);

    // The audit log records it, with the expiry so the line can state a duration.
    const log = await app.inject({
      method: "GET",
      url: `/groups/${serverId}/moderation-log`,
      headers: auth(owner.token),
    });
    expect(log.statusCode).toBe(200);
    const entries = log.json().entries as Array<{
      action: { action: string; targetId: string; expiresAt: string | null };
    }>;
    const row = entries.find((e) => e.action.action === "timeout");
    expect(row).toBeDefined();
    expect(row?.action.targetId).toBe(victim.id);
    expect(row?.action.expiresAt).toBeTruthy();
  });

  // =========================================================================
  // 4 — IGNORE (and every way it differs from a block)
  // =========================================================================

  it("ignore: kills the push and the mention ping, silently", async () => {
    const author = await newUser("ig_a");
    const ignorer = await newUser("ig_i");
    const serverId = await makeServer(author);
    await join(serverId, author, ignorer);
    const channelId = await createChannel(serverId, author);
    // Offline, so the notifier actually dispatches (an online member is never
    // pushed) — the same staging `blocks.int.test.ts` uses.
    presence.setOffline(ignorer.id);

    // Baseline: a plain message and an @mention both reach them.
    pushCalls.length = 0;
    await send(channelId, author, "plain one");
    await send(channelId, author, `hey ${encodeMention(ignorer.id)}`);
    expect(pushCalls.flatMap((c) => c.ids)).toContain(ignorer.id);

    const ignored = await app.inject({
      method: "PUT",
      url: `/users/me/ignores/${author.id}`,
      headers: auth(ignorer.token),
    });
    expect(ignored.statusCode).toBe(201);

    // Now neither reaches them. The mention case is the one that matters most:
    // without the intersect, an ignored user could still buzz a phone by typing
    // an `<@id>`.
    pushCalls.length = 0;
    await send(channelId, author, "plain two");
    await send(channelId, author, `oi ${encodeMention(ignorer.id)}`);
    expect(pushCalls.flatMap((c) => c.ids)).not.toContain(ignorer.id);

    // Un-ignoring restores it with no refetch — nothing was hidden server-side.
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/users/me/ignores/${author.id}`,
          headers: auth(ignorer.token),
        })
      ).statusCode,
    ).toBe(204);
    pushCalls.length = 0;
    await send(channelId, author, "plain three");
    expect(pushCalls.flatMap((c) => c.ids)).toContain(ignorer.id);
  });

  it("ignore: the ignored user gets NO signal — no event, no error, no flag", async () => {
    const author = await newUser("ig_sig_a");
    const ignorer = await newUser("ig_sig_i");
    await befriend(author, ignorer);
    const serverId = await makeServer(author);
    await join(serverId, author, ignorer);
    const channelId = await createChannel(serverId, author);

    published.length = 0;
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/users/me/ignores/${author.id}`,
          headers: auth(ignorer.token),
        })
      ).statusCode,
    ).toBe(201);

    // (a) The ONLY event published is addressed to the ignorer's own devices.
    //     Nothing at all is addressed to the author — contrast a block, which
    //     fans `friend.removed` to the other side.
    expect(published.every((m) => m.userId === ignorer.id)).toBe(true);
    expect(published.some((m) => m.userId === author.id)).toBe(false);
    expect(
      published.some((m) => m.event.type === SERVER_EVENT.friendRemoved),
    ).toBe(false);

    // (b) The friendship is untouched — you can ignore a friend and stay friends.
    const friends = await app.inject({
      method: "GET",
      url: "/friends",
      headers: auth(author.token),
    });
    expect(friends.body).toContain(ignorer.id);

    // (c) Their sends still SUCCEED. A block would 403 here; an ignore refuses
    //     nothing, which is the difference the founder asked for.
    const stillSends = await send(channelId, author, "you still get this");
    expect(stillSends.statusCode).toBe(201);

    // (d) …and the message is still DELIVERED to the ignorer's history. Content
    //     is collapsed client-side, never withheld server-side (ADR 0019 §4) —
    //     this assertion is the deliberate inverse of the block suite's.
    const page = await app.inject({
      method: "GET",
      url: `/channels/${channelId}/messages`,
      headers: auth(ignorer.token),
    });
    const contents = (page.json().messages as Array<{ content: string }>).map((m) => m.content);
    expect(contents).toContain("you still get this");

    // (e) No endpoint tells the author they are ignored. `/users/me/ignores` is
    //     scoped to the caller, so the author's own list stays empty.
    const authorsList = await app.inject({
      method: "GET",
      url: "/users/me/ignores",
      headers: auth(author.token),
    });
    expect(authorsList.statusCode).toBe(200);
    expect(authorsList.json().ignores).toHaveLength(0);

    // …and their view of the ignorer's profile carries no ignore flag.
    const profile = await app.inject({
      method: "GET",
      url: `/users/${ignorer.id}/profile`,
      headers: auth(author.token),
    });
    expect(profile.statusCode).toBe(200);
    expect(profile.body.toLowerCase()).not.toContain("ignore");
  });

  it("ignore: is one-directional and self-ignore is refused", async () => {
    const a = await newUser("ig_dir_a");
    const b = await newUser("ig_dir_b");

    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/users/me/ignores/${b.id}`,
          headers: auth(a.token),
        })
      ).statusCode,
    ).toBe(201);

    // A ignores B. B's own list is empty — the rows are never symmetric, and
    // there is no repo method that could make them look symmetric.
    const bList = await app.inject({
      method: "GET",
      url: "/users/me/ignores",
      headers: auth(b.token),
    });
    expect(bList.json().ignores).toHaveLength(0);
    expect(await repos.userIgnores.isIgnoring(a.id, b.id)).toBe(true);
    expect(await repos.userIgnores.isIgnoring(b.id, a.id)).toBe(false);

    // Idempotent re-ignore, and self-ignore refused.
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/users/me/ignores/${b.id}`,
          headers: auth(a.token),
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/users/me/ignores/${a.id}`,
          headers: auth(a.token),
        })
      ).statusCode,
    ).toBe(400);
  });
});
