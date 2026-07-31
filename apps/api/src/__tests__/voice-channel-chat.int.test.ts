/**
 * Voice-channel text chat (M20) — integration, real Postgres from
 * docker-compose; auto-skipped with a notice when the database is unreachable.
 *
 * Until M20 a voice channel refused every write: the REST send, the WS send, the
 * attachment upload and the slowmode setting each carried their own inline
 * `kind !== "text"`. Opening those four gates is a one-line change per file; the
 * risk is entirely in what sat BEHIND them, because every other rule in the chat
 * stack has spent its whole life only ever seeing text channels. This suite is
 * about those rules, one claim per test:
 *
 *   1. ROUND TRIP — send, read back, and see it survive a fresh page read. The
 *      chat quality gate (CLAUDE.md §22) applied to the kind that used to 400.
 *   2. ACCESS — widening the KIND gate must not have widened the ACCESS gate. A
 *      restricted voice channel answers 404 to a member without the role, on the
 *      read AND the write, exactly like a restricted text channel (ADR 0007).
 *      And the converse, which is the actual product decision: sitting in the
 *      voice ROOM is NOT required — seeing the channel is the whole rule.
 *   3. BLOCK (ADR 0017) — a blocked author's messages are excluded in SQL from
 *      the reader's history and search, not hidden client-side.
 *   4. TIMEOUT (ADR 0019) — a timed-out member cannot write here either. This is
 *      the gap that would have been easiest to ship: a mute that holds in
 *      #general and lapses in the voice channel next to it is not a mute.
 *   5. MENTION + UNREAD — the notification fan-out is kind-agnostic, so a voice
 *      channel's chat pings @mentioned members and plain-pushes everyone else.
 *      (The unread COUNT is a client-side tally of `message.created`; its
 *      server-side substrate — the peer fan-out — is pinned in the realtime
 *      suite, `gateway.int.test.ts`.)
 *   6. SLOWMODE — configurable and enforced on a voice channel.
 *   7. NSFW — the age-restricted flag is per-channel and was never kind-scoped,
 *      so a voice channel can carry it. Asserted so the decision is a test, not
 *      a comment.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  console.warn("[voice-channel-chat.int.test] DATABASE unreachable — skipping");
}

interface PushCall {
  ids: string[];
  n: PushNotification;
}

describe.skipIf(!dbUp)("voice-channel text chat (M20)", () => {
  let client: DbClient;
  let repos: Repositories;
  let app: FastifyInstance;

  /** Nobody is online, so every eligible recipient is push-eligible. */
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
   * Create a user + session through the repo layer rather than `/auth/register`,
   * which is IP-rate-limited and would throttle a suite that mints this many
   * users. Per-route limits are keyed by the Bearer token, so each user still
   * gets its own bucket.
   */
  async function newUser(label: string): Promise<TestUser> {
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
      payload: { name: `vcs_${suffix}_${seq}` },
    });
    expect(res.statusCode).toBe(201);
    return res.json().group.id as string;
  }

  async function createChannel(
    serverId: string,
    owner: TestUser,
    kind: "text" | "voice",
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    seq += 1;
    const res = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/channels`,
      headers: auth(owner.token),
      payload: { name: `vc${seq}`, kind, ...extra },
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

  function send(channelId: string, sender: TestUser, content: string) {
    return app.inject({
      method: "POST",
      url: `/channels/${channelId}/messages`,
      headers: auth(sender.token),
      payload: { content },
    });
  }

  function history(channelId: string, reader: TestUser) {
    return app.inject({
      method: "GET",
      url: `/channels/${channelId}/messages`,
      headers: auth(reader.token),
    });
  }

  function contentsOf(res: { json(): unknown }): string[] {
    const body = res.json() as { messages: Array<{ content: string }> };
    return body.messages.map((m) => m.content);
  }

  /** Create a role carrying `bits`, optionally assigning it to `target`. */
  async function makeRole(
    serverId: string,
    owner: TestUser,
    bits: number,
    target?: TestUser,
  ): Promise<string> {
    seq += 1;
    const role = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/roles`,
      headers: auth(owner.token),
      payload: { name: `vcrole${seq}`, permissions: bits },
    });
    expect(role.statusCode).toBe(201);
    const roleId = role.json().role.id as string;
    if (target) {
      const assign = await app.inject({
        method: "PUT",
        url: `/groups/${serverId}/members/${target.id}/roles`,
        headers: auth(owner.token),
        payload: { roleIds: [roleId] },
      });
      expect(assign.statusCode).toBe(200);
    }
    return roleId;
  }

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);
    app = await buildApp({
      repos,
      env: loadEnv({ DATABASE_URL }),
      mutationBus: new InMemoryMutationBus(),
      notifier: createOfflineNotifier({ presence, push }),
      logger: false,
    });
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  // =========================================================================
  // 1 — ROUND TRIP
  // =========================================================================

  it("sends, receives and PERSISTS a message in a voice channel", async () => {
    const owner = await newUser("vc_rt_o");
    const member = await newUser("vc_rt_m");
    const serverId = await makeServer(owner);
    await join(serverId, owner, member);
    const voiceId = await createChannel(serverId, owner, "voice");

    const sent = await send(voiceId, owner, "who is joining tonight");
    expect(sent.statusCode).toBe(201);
    const messageId = sent.json().message.id as string;
    expect(sent.json().message.channelId).toBe(voiceId);

    // The OTHER member reads it back — the read path never had a kind gate, and
    // this is the assertion that the two halves now agree.
    const read = await history(voiceId, member);
    expect(read.statusCode).toBe(200);
    expect(contentsOf(read)).toContain("who is joining tonight");

    // Still there on a fresh page read (persistence, not a response echo).
    const again = await history(voiceId, owner);
    expect((again.json().messages as Array<{ id: string }>).map((m) => m.id)).toContain(
      messageId,
    );

    // And findable — search is the surface most likely to have kept a kind gate.
    const found = await app.inject({
      method: "GET",
      url: `/channels/${voiceId}/messages/search?q=joining`,
      headers: auth(member.token),
    });
    expect(found.statusCode).toBe(200);
    expect(contentsOf(found)).toContain("who is joining tonight");
  });

  // =========================================================================
  // 2 — ACCESS CONTROL
  // =========================================================================

  it("gates on SEEING the channel, not on being in the voice room", async () => {
    const owner = await newUser("vc_ac_o");
    const insider = await newUser("vc_ac_i");
    const outsider = await newUser("vc_ac_x");
    const serverId = await makeServer(owner);
    await join(serverId, owner, insider);
    await join(serverId, owner, outsider);

    // Restrict the voice channel to one role, held only by `insider`
    // (ADR 0007 — the same visibility model text channels use).
    const voiceId = await createChannel(serverId, owner, "voice");
    const roleId = await makeRole(serverId, owner, 0, insider);
    const restrict = await app.inject({
      method: "PUT",
      url: `/channels/${voiceId}/access`,
      headers: auth(owner.token),
      payload: { roleIds: [roleId] },
    });
    expect(restrict.statusCode).toBe(200);

    // The role-holder writes and reads WITHOUT ever joining the voice room —
    // this is the product decision, stated as a test.
    const allowed = await send(voiceId, insider, "visible to the role");
    expect(allowed.statusCode).toBe(201);
    expect(contentsOf(await history(voiceId, insider))).toContain("visible to the role");

    // The member without the role gets the SAME "not found" on both verbs — the
    // channel's existence is not leaked, and no separate 403 distinguishes
    // "exists but forbidden" from "does not exist" (§28).
    const refusedWrite = await send(voiceId, outsider, "should not land");
    expect(refusedWrite.statusCode).toBe(404);
    expect(refusedWrite.json().error.code).toBe("NOT_FOUND");

    const refusedRead = await history(voiceId, outsider);
    expect(refusedRead.statusCode).toBe(404);
    expect(refusedRead.json().error.code).toBe("NOT_FOUND");

    // A total stranger to the server is refused identically.
    const stranger = await newUser("vc_ac_s");
    expect((await send(voiceId, stranger, "nope")).statusCode).toBe(404);

    // The refused writes persisted nothing.
    expect(contentsOf(await history(voiceId, insider))).not.toContain("should not land");
  });

  // =========================================================================
  // 3 — BLOCK (ADR 0017)
  // =========================================================================

  it("hides a BLOCKED author's voice-channel messages from the blocker", async () => {
    const owner = await newUser("vc_bl_o");
    const noisy = await newUser("vc_bl_n");
    const serverId = await makeServer(owner);
    await join(serverId, owner, noisy);
    const voiceId = await createChannel(serverId, owner, "voice");

    expect((await send(voiceId, noisy, "before the block")).statusCode).toBe(201);

    const blocked = await app.inject({
      method: "PUT",
      url: `/users/me/blocks/${noisy.id}`,
      headers: auth(owner.token),
    });
    expect([200, 201]).toContain(blocked.statusCode);

    // A block does not refuse the send in a shared server — it hides the result
    // from the blocker. The message still exists for everyone else.
    expect((await send(voiceId, noisy, "after the block")).statusCode).toBe(201);

    const ownerView = contentsOf(await history(voiceId, owner));
    expect(ownerView).not.toContain("before the block");
    expect(ownerView).not.toContain("after the block");

    // Excluded from SEARCH too — the surface most likely to resurface hidden
    // history — and the exclusion is in SQL, so the text never leaves the server.
    const searched = await app.inject({
      method: "GET",
      url: `/channels/${voiceId}/messages/search?q=block`,
      headers: auth(owner.token),
    });
    expect(searched.statusCode).toBe(200);
    expect(contentsOf(searched)).toHaveLength(0);

    // The author still sees their own messages: a block is one-sided hiding, not
    // a deletion.
    expect(contentsOf(await history(voiceId, noisy))).toContain("after the block");
  });

  // =========================================================================
  // 4 — TIMEOUT (ADR 0019)
  // =========================================================================

  it("REFUSES a timed-out member's voice-channel message and persists nothing", async () => {
    const owner = await newUser("vc_to_o");
    const muted = await newUser("vc_to_m");
    const serverId = await makeServer(owner);
    await join(serverId, owner, muted);
    const voiceId = await createChannel(serverId, owner, "voice");

    // Baseline: they can speak here.
    expect((await send(voiceId, muted, "before the mute")).statusCode).toBe(201);

    const applied = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/members/${muted.id}/timeout`,
      headers: auth(owner.token),
      payload: { minutes: 60 },
    });
    expect(applied.statusCode).toBe(200);

    const refused = await send(voiceId, muted, "after the mute");
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe("TIMED_OUT");

    // The gate runs BEFORE the write, so nothing is left behind.
    const after = contentsOf(await history(voiceId, owner));
    expect(after).toContain("before the mute");
    expect(after).not.toContain("after the mute");

    // A reaction inside the voice channel's chat is refused on the same terms —
    // adding one is a visible contribution to a channel they are muted in.
    const target = await send(voiceId, owner, "react to me");
    const messageId = target.json().message.id as string;
    const reaction = await app.inject({
      method: "PUT",
      url: `/messages/${messageId}/reactions/${encodeURIComponent("👍")}`,
      headers: auth(muted.token),
    });
    expect(reaction.statusCode).toBe(403);
    expect(reaction.json().error.code).toBe("TIMED_OUT");

    // NOT asserted here, deliberately: `POST /channels/:id/attachments/upload-url`
    // carries no timeout gate, in a voice channel or a text one. ADR 0019 §3
    // enumerates exactly three paths a timeout cuts (message, reaction, voice
    // token), and an upload is none of them because an uploaded object is
    // invisible until a SEND links it — and that send is refused above. A muted
    // member can therefore still burn a signed URL, bounded by the endpoint's own
    // 30/min limit and reaped by the orphan sweep. Widening the timeout to a
    // fourth path is an ADR-level change, not a side effect of this one.

    // Everyone else in the same voice channel is unaffected.
    expect((await send(voiceId, owner, "owner still talks")).statusCode).toBe(201);
  });

  // =========================================================================
  // 5 — MENTION + UNREAD FAN-OUT
  // =========================================================================

  it("pings @mentioned members and plain-pushes the rest of a voice channel", async () => {
    const owner = await newUser("vc_mn_o");
    const pinged = await newUser("vc_mn_p");
    const bystander = await newUser("vc_mn_b");
    const serverId = await makeServer(owner);
    await join(serverId, owner, pinged);
    await join(serverId, owner, bystander);
    const voiceId = await createChannel(serverId, owner, "voice");

    pushCalls.length = 0;
    const sent = await send(voiceId, owner, `${encodeMention(pinged.id)} we are starting`);
    expect(sent.statusCode).toBe(201);

    // The mention push: author-titled, `type: "mention"`, to exactly the
    // mentioned member. This is what drives the client's mention badge, and it
    // is the half that has to be server-side (a device is pushed by the server).
    const mention = pushCalls.find((c) => c.n.data?.["type"] === "mention");
    expect(mention).toBeDefined();
    expect(mention?.ids).toEqual([pinged.id]);
    expect(mention?.n.data?.["channelId"]).toBe(voiceId);

    // The plain channel push: everyone else who can SEE the channel, collapse-keyed
    // per channel. This is what makes a voice channel's chat raise an unread badge
    // on a phone at all — the counter itself is the client's tally of
    // `message.created` (see gateway.int.test.ts for the socket half).
    const plain = pushCalls.find((c) => c.n.data?.["type"] === "message");
    expect(plain).toBeDefined();
    expect(plain?.ids).toEqual([bystander.id]);
    expect(plain?.n.data?.["channelId"]).toBe(voiceId);
    // The push title carries the VOICE channel's name, so the notification reads
    // like any other channel's rather than like an unnamed room.
    expect(plain?.n.title).toContain("#");

    // The author is never pushed for their own message.
    for (const call of pushCalls) expect(call.ids).not.toContain(owner.id);
  });

  it("does NOT push a member who cannot see the restricted voice channel", async () => {
    const owner = await newUser("vc_mv_o");
    const insider = await newUser("vc_mv_i");
    const outsider = await newUser("vc_mv_x");
    const serverId = await makeServer(owner);
    await join(serverId, owner, insider);
    await join(serverId, owner, outsider);
    const voiceId = await createChannel(serverId, owner, "voice");
    const roleId = await makeRole(serverId, owner, 0, insider);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/channels/${voiceId}/access`,
          headers: auth(owner.token),
          payload: { roleIds: [roleId] },
        })
      ).statusCode,
    ).toBe(200);

    pushCalls.length = 0;
    // Even a DIRECT @mention of the excluded member must not reach them: the
    // fan-out audience is derived server-side from visibility, never from the
    // sender's claim about who should be notified (§28).
    expect(
      (await send(voiceId, owner, `${encodeMention(outsider.id)} hidden room`)).statusCode,
    ).toBe(201);

    for (const call of pushCalls) expect(call.ids).not.toContain(outsider.id);
    expect(pushCalls.flatMap((c) => c.ids)).toContain(insider.id);
  });

  // =========================================================================
  // 6 — SLOWMODE
  // =========================================================================

  it("configures and ENFORCES slowmode on a voice channel", async () => {
    const owner = await newUser("vc_sm_o");
    const member = await newUser("vc_sm_m");
    const serverId = await makeServer(owner);
    await join(serverId, owner, member);
    const voiceId = await createChannel(serverId, owner, "voice");

    const configured = await app.inject({
      method: "PATCH",
      url: `/channels/${voiceId}`,
      headers: auth(owner.token),
      payload: { slowmodeSeconds: 30 },
    });
    expect(configured.statusCode).toBe(200);
    expect(configured.json().channel.slowmodeSeconds).toBe(30);

    expect((await send(voiceId, member, "first")).statusCode).toBe(201);
    const throttled = await send(voiceId, member, "second");
    expect(throttled.statusCode).toBe(429);
    expect(throttled.json().error.code).toBe("SLOWMODE");

    // The owner is exempt, exactly as in a text channel.
    expect((await send(voiceId, owner, "owner bypasses")).statusCode).toBe(201);

    // Voice-only settings stay voice-only — widening slowmode must not have
    // turned the kind checks into a free-for-all.
    const onText = await app.inject({
      method: "PATCH",
      url: `/channels/${await createChannel(serverId, owner, "text")}`,
      headers: auth(owner.token),
      payload: { maxParticipants: 5 },
    });
    expect(onText.statusCode).toBe(400);
    expect(onText.json().error.code).toBe("INVALID_CHANNEL");
  });

  // =========================================================================
  // 7 — NSFW
  // =========================================================================

  it("carries the age-restricted (NSFW) flag on a voice channel", async () => {
    const owner = await newUser("vc_ns_o");
    const serverId = await makeServer(owner);

    // The flag describes the CHANNEL's content, not its transport, so it applies
    // to a voice channel's chat exactly as to a text one — and the attachment
    // moderation seam reads it per-channel with no kind branch of its own.
    const voiceId = await createChannel(serverId, owner, "voice", { nsfw: true });
    const list = await app.inject({
      method: "GET",
      url: `/groups/${serverId}/channels`,
      headers: auth(owner.token),
    });
    const found = (list.json().channels as Array<{ id: string; nsfw: boolean; kind: string }>).find(
      (c) => c.id === voiceId,
    );
    expect(found?.kind).toBe("voice");
    expect(found?.nsfw).toBe(true);

    const cleared = await app.inject({
      method: "PATCH",
      url: `/channels/${voiceId}`,
      headers: auth(owner.token),
      payload: { nsfw: false },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().channel.nsfw).toBe(false);
  });
});
