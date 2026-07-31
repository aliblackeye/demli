/**
 * #94 — "all messages" offline push for group/server channels (integration).
 *
 * Founder request: when the app is closed, EVERY message in a channel you can
 * see notifies you — not just DMs and @mentions — with the notification-mute
 * gate on top. Real Postgres from docker-compose (auto-skips when unreachable);
 * presence + the Expo send are stubbed so this asserts the full REST wiring
 * without a live gateway or Expo network. The WS gateway shares the exact same
 * dispatcher (`dispatchChannelMessagePush`), covered in the realtime suite.
 *
 * Covers: fan-out to every visible offline member (never the sender), the
 * restricted-channel visibility gate (a member who cannot see the channel is
 * never pushed — §28), the online-gate (a connected member is never pushed),
 * mute=all / mute=mentions behavior, the "Server #channel" / "Author: text"
 * body format, the per-channel collapse key, and the mention/plain split within
 * a single send.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  applyMigrations,
  createDb,
  createRepositories,
  generateSessionToken,
  hashSessionToken,
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
  console.warn("[channel-message-push.int.test] DATABASE unreachable — skipping");
}

interface PushCall {
  ids: string[];
  n: PushNotification;
}

describe.skipIf(!dbUp)("channel message push — all-messages default (#94)", () => {
  let client: DbClient;
  let repos: Repositories;
  let app: FastifyInstance;

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
    displayName: string;
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
    return { token, id: user.id, displayName: username };
  }

  async function makeServer(owner: TestUser): Promise<{ serverId: string; name: string }> {
    const name = `srv_${suffix}_${seq}`;
    const created = await app.inject({
      method: "POST",
      url: "/groups",
      headers: auth(owner.token),
      payload: { name },
    });
    expect(created.statusCode).toBe(201);
    return { serverId: created.json().group.id as string, name };
  }

  async function createChannel(
    serverId: string,
    owner: TestUser,
    name: string,
    roleIds?: string[],
  ): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/channels`,
      headers: auth(owner.token),
      payload: { name, kind: "text", ...(roleIds ? { roleIds } : {}) },
    });
    expect(res.statusCode).toBe(201);
    return res.json().channel.id as string;
  }

  async function createRole(serverId: string, owner: TestUser, name: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/roles`,
      headers: auth(owner.token),
      payload: { name },
    });
    expect(res.statusCode).toBe(201);
    return res.json().role.id as string;
  }

  async function assignRole(
    serverId: string,
    owner: TestUser,
    member: TestUser,
    roleIds: string[],
  ): Promise<void> {
    const res = await app.inject({
      method: "PUT",
      url: `/groups/${serverId}/members/${member.id}/roles`,
      headers: auth(owner.token),
      payload: { roleIds },
    });
    expect(res.statusCode).toBe(200);
  }

  async function join(serverId: string, owner: TestUser, member: TestUser): Promise<void> {
    const invite = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/invites`,
      headers: auth(owner.token),
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

  function sendMessage(channelId: string, sender: TestUser, content: string) {
    return app.inject({
      method: "POST",
      url: `/channels/${channelId}/messages`,
      headers: auth(sender.token),
      payload: { content },
    });
  }

  /** Mark everyone offline by default; a test opts one member online explicitly. */
  function allOffline(...users: TestUser[]): void {
    for (const u of users) presence.setOffline(u.id);
  }

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);
    app = await buildApp({
      repos,
      env: loadEnv({ DATABASE_URL }),
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
  });

  it("pushes a plain message to EVERY offline member who can see the channel — not the sender", async () => {
    const owner = await newUser("all_o");
    const m1 = await newUser("all_a");
    const m2 = await newUser("all_b");
    const { serverId, name: serverName } = await makeServer(owner);
    await join(serverId, owner, m1);
    await join(serverId, owner, m2);
    const channelId = await createChannel(serverId, owner, "general");
    allOffline(owner, m1, m2);
    pushCalls.length = 0;

    expect((await sendMessage(channelId, owner, "  hello   crew  ")).statusCode).toBe(201);

    // One channel push, to both members (never the sender/owner).
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0]!.ids.slice().sort()).toEqual([m1.id, m2.id].sort());
    expect(pushCalls[0]!.ids).not.toContain(owner.id);
    // Format: "Server #channel" over "Author: normalized text", per-channel collapse.
    expect(pushCalls[0]!.n.title).toBe(`${serverName} #general`);
    expect(pushCalls[0]!.n.body).toBe(`${owner.displayName}: hello crew`);
    expect(pushCalls[0]!.n.data).toMatchObject({
      type: "message",
      channelId,
      groupId: serverId,
      name: "general",
    });
    expect(pushCalls[0]!.n.collapseKey).toBe(`channel:${channelId}`);
  });

  it("does NOT push a member who cannot SEE a restricted channel (visibility gate, §28)", async () => {
    const owner = await newUser("vis_o");
    const granted = await newUser("vis_g");
    const denied = await newUser("vis_d");
    const { serverId } = await makeServer(owner);
    await join(serverId, owner, granted);
    await join(serverId, owner, denied);
    const vipId = await createRole(serverId, owner, "VIP");
    await assignRole(serverId, owner, granted, [vipId]);
    const channelId = await createChannel(serverId, owner, "vip-lounge", [vipId]);
    allOffline(owner, granted, denied);
    pushCalls.length = 0;

    expect((await sendMessage(channelId, owner, "secret plans")).statusCode).toBe(201);

    // Only the role-holder is pushed; the member without the role never sees the
    // channel and so is never a push candidate.
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0]!.ids).toEqual([granted.id]);
  });

  it("mute mode=all silences the channel push for that member only", async () => {
    const owner = await newUser("ma_o");
    const muted = await newUser("ma_m");
    const heard = await newUser("ma_h");
    const { serverId } = await makeServer(owner);
    await join(serverId, owner, muted);
    await join(serverId, owner, heard);
    const channelId = await createChannel(serverId, owner, "general");
    await app.inject({
      method: "PUT",
      url: "/notification-mutes",
      headers: auth(muted.token),
      payload: { scope: "channel", targetId: channelId, mode: "all" },
    });
    allOffline(owner, muted, heard);
    pushCalls.length = 0;

    expect((await sendMessage(channelId, owner, "anyone home?")).statusCode).toBe(201);

    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0]!.ids).toEqual([heard.id]);
  });

  it("mute mode=mentions drops a plain message but lets a direct @mention through", async () => {
    const owner = await newUser("mm_o");
    const member = await newUser("mm_m");
    const { serverId } = await makeServer(owner);
    await join(serverId, owner, member);
    const channelId = await createChannel(serverId, owner, "general");
    await app.inject({
      method: "PUT",
      url: "/notification-mutes",
      headers: auth(member.token),
      payload: { scope: "channel", targetId: channelId, mode: "mentions" },
    });
    allOffline(owner, member);

    // Plain message → silenced by the mentions-only mute.
    pushCalls.length = 0;
    expect((await sendMessage(channelId, owner, "plain, nobody tagged")).statusCode).toBe(201);
    expect(pushCalls).toEqual([]);

    // Direct @mention → passes the mentions-only mute, as the mention push.
    pushCalls.length = 0;
    expect(
      (await sendMessage(channelId, owner, `hey ${encodeMention(member.id)}`)).statusCode,
    ).toBe(201);
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0]!.ids).toEqual([member.id]);
    expect(pushCalls[0]!.n.data).toMatchObject({ type: "mention", channelId, groupId: serverId });
  });

  it("does NOT push a member who is ONLINE (offline-gate preserved)", async () => {
    const owner = await newUser("on_o");
    const online = await newUser("on_x");
    const offline = await newUser("on_y");
    const { serverId } = await makeServer(owner);
    await join(serverId, owner, online);
    await join(serverId, owner, offline);
    const channelId = await createChannel(serverId, owner, "general");
    presence.setOffline(owner.id);
    presence.setOnline(online.id); // has a live WS connection → no native push
    presence.setOffline(offline.id);
    pushCalls.length = 0;

    expect((await sendMessage(channelId, owner, "who's around")).statusCode).toBe(201);

    // Only the offline member is pushed; the online one is filtered by the notifier.
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0]!.ids).toEqual([offline.id]);
  });

  it("splits one send: @mentioned member gets the mention push, everyone else the channel push", async () => {
    const owner = await newUser("sp_o");
    const tagged = await newUser("sp_t");
    const other = await newUser("sp_x");
    const { serverId } = await makeServer(owner);
    await join(serverId, owner, tagged);
    await join(serverId, owner, other);
    const channelId = await createChannel(serverId, owner, "general");
    allOffline(owner, tagged, other);
    pushCalls.length = 0;

    expect(
      (await sendMessage(channelId, owner, `look ${encodeMention(tagged.id)}`)).statusCode,
    ).toBe(201);

    // Two distinct pushes: a mention push to the tagged member, a channel push to
    // the rest. Order between the two notify calls is deterministic (mention first).
    expect(pushCalls).toHaveLength(2);
    const mention = pushCalls.find((c) => (c.n.data as { type?: string }).type === "mention");
    const channel = pushCalls.find((c) => (c.n.data as { type?: string }).type === "message");
    expect(mention?.ids).toEqual([tagged.id]);
    expect(channel?.ids).toEqual([other.id]);
    expect(channel?.n.collapseKey).toBe(`channel:${channelId}`);
  });
});
