/**
 * Social gateway integration tests (M13 W3, ADR 0010 §4) — real Postgres + real
 * WebSockets, plus an optional Redis cross-process smoke. Skipped automatically
 * (with a console notice) when the database / Redis is down.
 *
 * Proves the four W3 hand-off items:
 *  1. user-scoped fan-out reaches only the target's live connections;
 *  2. `dm.created` instantly subscribes both members so DM messages flow with no
 *     reconnect;
 *  3. an inbound WS DM message re-opens (unhides) the recipient's hidden DM;
 *  4. accepted friends see each other's presence with no shared group (audience
 *     union + accept-time refresh).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createDb,
  createRedisClient,
  createRepositories,
  generateSessionToken,
  hashSessionToken,
  InMemoryMutationBus,
  InMemoryPresenceReader,
  RedisMutationBus,
  sessionExpiresAt,
  type DbClient,
  type Repositories,
} from "@demli/db";
import { createOfflineNotifier } from "@demli/notifications";
import type { PushNotification, PushService } from "@demli/notifications";
import { clientEvent, encodeMention, serverEvent, SERVER_EVENT } from "@demli/protocol";
import type { User } from "@demli/types";
import { createGateway, type Gateway } from "../gateway.js";
import { InMemoryPresenceStore, RedisPresenceStore } from "../presence.js";
import { DATABASE_URL, isDbUp, TestClient } from "./harness.js";
import { refuseToSkipIfRequired } from "@demli/db/testing";

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";

interface Actor {
  id: string;
  token: string;
  user: User;
}

/** Create a user + a live session token, ready to open a gateway socket. */
async function makeActor(repos: Repositories, label: string): Promise<Actor> {
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const user = await repos.users.create({
    username: `${label}_${suffix}`,
    displayName: label,
    passwordHash: "not-used-in-this-test",
  });
  const token = generateSessionToken();
  await repos.sessions.create({
    userId: user.id,
    tokenHash: hashSessionToken(token),
    expiresAt: sessionExpiresAt(new Date(), 1),
  });
  return { id: user.id, token, user };
}

/** Poll `cond` until it holds — the barrier for a best-effort async DB write. */
async function waitUntil(cond: () => Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const dbUp = await isDbUp();
if (!dbUp) {
  refuseToSkipIfRequired("postgres");
  console.warn("[gateway.social.int.test] DATABASE unreachable — skipping integration tests");
}

describe.skipIf(!dbUp)("gateway social — user fan-out, DMs & friend presence", () => {
  let client: DbClient;
  let repos: Repositories;
  let gateway: Gateway;
  let mutationBus: InMemoryMutationBus;
  let port: number;

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);

    mutationBus = new InMemoryMutationBus();
    gateway = createGateway(
      { repos, presence: new InMemoryPresenceStore(), mutationBus },
      { port: 0 },
    );
    port = await gateway.ready;
  });

  afterAll(async () => {
    await gateway?.close();
    await client?.close();
  });

  it("routes a user-scoped event to every connection of the target and no one else", async () => {
    const a = await makeActor(repos, "fanA");
    const b = await makeActor(repos, "fanB");
    const aSock = await TestClient.connect(port, a.token);
    const b1 = await TestClient.connect(port, b.token);
    const b2 = await TestClient.connect(port, b.token); // two devices, same user
    await aSock.waitFor(SERVER_EVENT.authSucceeded);
    await b1.waitFor(SERVER_EVENT.authSucceeded);
    await b2.waitFor(SERVER_EVENT.authSucceeded);

    // A user-scoped event for B: payload marks the counterpart as A.
    await mutationBus.publish({
      userId: b.id,
      event: serverEvent.friendRemoved({ userId: a.id }),
    });
    // Reaches BOTH of B's connections.
    await b1.waitFor(SERVER_EVENT.friendRemoved, (e) => e.payload.userId === a.id);
    await b2.waitFor(SERVER_EVENT.friendRemoved, (e) => e.payload.userId === a.id);

    // Barrier: a distinct user-scoped event for A. A's socket is ordered, so if
    // the B-targeted event had leaked to A it would already have arrived.
    await mutationBus.publish({
      userId: a.id,
      event: serverEvent.friendRemoved({ userId: b.id }),
    });
    await aSock.waitFor(SERVER_EVENT.friendRemoved, (e) => e.payload.userId === b.id);

    const leakedToA = aSock.envelopes.some(
      (env) =>
        env.event.type === SERVER_EVENT.friendRemoved && env.event.payload.userId === a.id,
    );
    expect(leakedToA).toBe(false);

    aSock.close();
    b1.close();
    b2.close();
  });

  it("dm.created instantly subscribes both members so DM messages flow with no reconnect", async () => {
    const a = await makeActor(repos, "dmSubA");
    const b = await makeActor(repos, "dmSubB");
    const aSock = await TestClient.connect(port, a.token);
    const bSock = await TestClient.connect(port, b.token);
    await aSock.waitFor(SERVER_EVENT.authSucceeded);
    await bSock.waitFor(SERVER_EVENT.authSucceeded);

    // DM created AFTER both connected — without the subscribe step neither socket
    // would carry the new stream, so no message could reach the recipient live.
    const { dm, created } = await repos.dms.getOrCreate(a.id, b.id);
    expect(created).toBe(true);
    const dmForB = await repos.dms.findById(dm.id, b.id);
    if (!dmForB) throw new Error("expected the DM to resolve for B");

    // Each participant gets their own participant-relative copy (as the API does).
    await mutationBus.publish({ userId: a.id, event: serverEvent.dmCreated({ dm }) });
    await mutationBus.publish({ userId: b.id, event: serverEvent.dmCreated({ dm: dmForB }) });
    await aSock.waitFor(SERVER_EVENT.dmCreated, (e) => e.payload.dm.id === dm.id);
    await bSock.waitFor(SERVER_EVENT.dmCreated, (e) => e.payload.dm.id === dm.id);

    // A sends into the brand-new DM stream over WS — B receives it live.
    const nonce = `dm-${Date.now()}`;
    const content = `hey B ${nonce}`;
    aSock.send(clientEvent.messageSend({ channelId: dm.streamId, content, nonce }));
    const got = await bSock.waitFor(
      SERVER_EVENT.messageCreated,
      (e) => e.payload.content === content,
    );
    expect(got.payload.channelId).toBe(dm.streamId);
    // A's own echo (proves A was subscribed too, no reconnect).
    await aSock.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.nonce === nonce);

    aSock.close();
    bSock.close();
  });

  it("group_chat.added instantly subscribes the added member so group-chat messages flow with no reconnect", async () => {
    const owner = await makeActor(repos, "gcSubO");
    const addee = await makeActor(repos, "gcSubA");

    // Group chat created BEFORE the owner connects → the owner's handshake carries
    // its stream, so the owner can send into it below.
    const group = await repos.groupChats.create({ name: "weekly", ownerId: owner.id });

    const ownerSock = await TestClient.connect(port, owner.token);
    const addeeSock = await TestClient.connect(port, addee.token);
    await ownerSock.waitFor(SERVER_EVENT.authSucceeded);
    await addeeSock.waitFor(SERVER_EVENT.authSucceeded);

    // The addee is added AFTER connecting — without the subscribe step their
    // socket would not carry the new stream, so no message could reach them live
    // (the founder's exact bug: added to a group chat, saw nothing).
    await repos.groupChats.addMember(group.id, addee.id);
    await mutationBus.publish({
      userId: addee.id,
      event: serverEvent.groupChatAdded({ group }),
    });
    await addeeSock.waitFor(
      SERVER_EVENT.groupChatAdded,
      (e) => e.payload.group.id === group.id,
    );

    // Owner sends into the group stream over WS — the addee receives it live.
    const nonce = `gc-${Date.now()}`;
    const content = `hi team ${nonce}`;
    ownerSock.send(clientEvent.messageSend({ channelId: group.streamId, content, nonce }));
    const got = await addeeSock.waitFor(
      SERVER_EVENT.messageCreated,
      (e) => e.payload.content === content,
    );
    expect(got.payload.channelId).toBe(group.streamId);
    // Owner's own echo (proves the owner was subscribed from handshake).
    await ownerSock.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.nonce === nonce);

    ownerSock.close();
    addeeSock.close();
  });

  it("re-opens (unhides) a hidden DM for the recipient on an inbound WS message", async () => {
    const a = await makeActor(repos, "unhideA");
    const b = await makeActor(repos, "unhideB");

    // DM created BEFORE connecting → both subscribe at handshake (a DM stream is
    // always visible to its two members, even when hidden).
    const { dm } = await repos.dms.getOrCreate(a.id, b.id);
    await repos.dms.hide(dm.id, b.id);
    expect((await repos.dms.listForUser(b.id)).some((d) => d.id === dm.id)).toBe(false);

    const aSock = await TestClient.connect(port, a.token);
    const bSock = await TestClient.connect(port, b.token);
    await aSock.waitFor(SERVER_EVENT.authSucceeded);
    await bSock.waitFor(SERVER_EVENT.authSucceeded);

    const nonce = `re-${Date.now()}`;
    const content = `still here ${nonce}`;
    aSock.send(clientEvent.messageSend({ channelId: dm.streamId, content, nonce }));

    // B still receives it live: hiding a DM never unsubscribed the socket.
    await bSock.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.content === content);

    // And the DM re-surfaces for B (unhide is fire-and-forget best-effort → poll).
    await waitUntil(async () =>
      (await repos.dms.listForUser(b.id)).some((d) => d.id === dm.id),
    );

    aSock.close();
    bSock.close();
  });

  it("delivers presence between accepted friends who share no group", async () => {
    const x = await makeActor(repos, "presX");
    const y = await makeActor(repos, "presY");
    // Accepted friendship, NO shared group.
    await repos.friendships.send(x.id, y.id);
    const accept = await repos.friendships.accept(y.id, x.id);
    if (!accept.ok) throw new Error(`accept failed: ${accept.reason}`);

    const xSock = await TestClient.connect(port, x.token);
    await xSock.waitFor(SERVER_EVENT.authSucceeded);

    // Y connects after X: X sees Y come online purely via the friend audience.
    const ySock = await TestClient.connect(port, y.token);
    const yAuth = await ySock.waitFor(SERVER_EVENT.authSucceeded);

    const yOnline = await xSock.waitFor(
      SERVER_EVENT.presenceUpdated,
      (e) => e.payload.userId === y.id && e.payload.status === "online",
    );
    expect(yOnline.payload.status).toBe("online");

    // Y's handshake snapshot already carried X (online friend, no shared group).
    expect(
      yAuth.payload.presence.some((p) => p.userId === x.id && p.status === "online"),
    ).toBe(true);

    xSock.close();
    ySock.close();
  });

  it("refreshes both presences the moment a friend request is accepted", async () => {
    const x = await makeActor(repos, "acceptX");
    const y = await makeActor(repos, "acceptY");
    // Pending request X→Y, NO shared group; both online but not yet friends, so
    // neither is in the other's presence audience at connect time.
    await repos.friendships.send(x.id, y.id);

    const xSock = await TestClient.connect(port, x.token);
    const ySock = await TestClient.connect(port, y.token);
    await xSock.waitFor(SERVER_EVENT.authSucceeded);
    await ySock.waitFor(SERVER_EVENT.authSucceeded);

    // Accept in the DB (as the API does) then publish the user-scoped event to the
    // requester — exactly the ordering the api friends module uses.
    const accept = await repos.friendships.accept(y.id, x.id);
    if (!accept.ok) throw new Error(`accept failed: ${accept.reason}`);
    await mutationBus.publish({
      userId: x.id,
      event: serverEvent.friendRequestAccepted({
        friendship: accept.friendship,
        friend: y.user,
      }),
    });

    // The requester gets the accepted event...
    await xSock.waitFor(
      SERVER_EVENT.friendRequestAccepted,
      (e) => e.payload.friend.id === y.id,
    );
    // ...and the accept-time refresh makes each side see the other's dot at once.
    await xSock.waitFor(
      SERVER_EVENT.presenceUpdated,
      (e) => e.payload.userId === y.id && e.payload.status === "online",
    );
    await ySock.waitFor(
      SERVER_EVENT.presenceUpdated,
      (e) => e.payload.userId === x.id && e.payload.status === "online",
    );

    xSock.close();
    ySock.close();
  });
});

// ---------------------------------------------------------------------------
// GAP 2 — offline push on the WS send path. A message sent over the gateway (the
// PRIMARY path — mobile sends here, not REST) must fire an offline push: the DM
// recipient for a DM message, and for a server channel EVERY member who can see
// it (#94 — @mentioned members get the mention push, the rest the plain channel
// push), never the sender and never a DM+channel double for one message. The
// notifier's offline gate is a separate InMemoryPresenceReader (independent of
// the gateway's own connection tracking), so a recipient is "offline" purely by
// not being set online in the reader — they need not even hold a socket, matching
// a real closed-app push.
// ---------------------------------------------------------------------------

describe.skipIf(!dbUp)("gateway offline push — WS DM & mention (GAP 2)", () => {
  let client: DbClient;
  let repos: Repositories;
  let gateway: Gateway;
  let port: number;

  const presence = new InMemoryPresenceReader();
  const pushCalls: Array<{ ids: string[]; n: PushNotification }> = [];
  const push: PushService = {
    async sendToUsers(userIds, n) {
      pushCalls.push({ ids: [...userIds], n });
    },
  };

  /** The push path is fire-and-forget (post-broadcast) — poll until it lands. */
  async function waitForPush(min = 1): Promise<void> {
    await waitUntil(async () => pushCalls.length >= min);
  }

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);
    gateway = createGateway(
      {
        repos,
        presence: new InMemoryPresenceStore(),
        mutationBus: new InMemoryMutationBus(),
        notifier: createOfflineNotifier({ presence, push }),
      },
      { port: 0 },
    );
    port = await gateway.ready;
  });

  afterAll(async () => {
    await gateway?.close();
    await client?.close();
  });

  it("pushes the OFFLINE DM recipient (not the sender) on an inbound WS DM message", async () => {
    const a = await makeActor(repos, "wsdmA");
    const b = await makeActor(repos, "wsdmB");
    // DM created before A connects → A's handshake carries the stream, so A can send.
    const { dm } = await repos.dms.getOrCreate(a.id, b.id);
    presence.setOffline(b.id); // recipient offline → eligible for push
    pushCalls.length = 0;

    const aSock = await TestClient.connect(port, a.token);
    await aSock.waitFor(SERVER_EVENT.authSucceeded);

    const content = "hey b, you around?";
    aSock.send(clientEvent.messageSend({ channelId: dm.streamId, content, nonce: `wsdm-${Date.now()}` }));
    await aSock.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.content === content);

    await waitForPush();
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0]!.ids).toEqual([b.id]); // the recipient, never the sender A
    expect(pushCalls[0]!.n.body).toBe(content);
    expect(pushCalls[0]!.n.data).toMatchObject({
      type: "dm_message",
      dmId: dm.id,
      channelId: dm.streamId,
    });

    aSock.close();
  });

  it("pushes ONLY @mentioned members on a server-channel message (mention-only, no DM push)", async () => {
    const owner = await makeActor(repos, "grpMoO");
    const member = await makeActor(repos, "grpMoM");
    const group = await repos.groups.create({ name: "Push Crew", ownerId: owner.id });
    await repos.groups.addMember(group.id, member.id, "member");
    const channel = await repos.channels.create({ groupId: group.id, kind: "text", name: "general" });
    presence.setOffline(member.id);
    pushCalls.length = 0;

    const ownerSock = await TestClient.connect(port, owner.token);
    await ownerSock.waitFor(SERVER_EVENT.authSucceeded);

    const content = `hey ${encodeMention(member.id)} look here`;
    ownerSock.send(clientEvent.messageSend({ channelId: channel.id, content, nonce: `grp-${Date.now()}` }));
    await ownerSock.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.content === content);

    await waitForPush();
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0]!.ids).toEqual([member.id]);
    expect(pushCalls[0]!.n.data).toMatchObject({
      type: "mention",
      channelId: channel.id,
      groupId: group.id,
    });

    ownerSock.close();
  });

  // #94: the all-messages default. A plain server-channel message now pushes
  // every offline member who can see the channel (not just @mentioned ones),
  // never the sender, via the shared dispatcher the REST path also uses.
  it("pushes offline visible members on a plain (no-mention) server-channel message (#94)", async () => {
    const owner = await makeActor(repos, "grpNoO");
    const member = await makeActor(repos, "grpNoM");
    const group = await repos.groups.create({ name: "Quiet Crew", ownerId: owner.id });
    await repos.groups.addMember(group.id, member.id, "member");
    const channel = await repos.channels.create({ groupId: group.id, kind: "text", name: "general" });
    presence.setOffline(member.id);
    pushCalls.length = 0;

    const ownerSock = await TestClient.connect(port, owner.token);
    await ownerSock.waitFor(SERVER_EVENT.authSucceeded);

    const content = "just a plain message, nobody tagged";
    ownerSock.send(clientEvent.messageSend({ channelId: channel.id, content, nonce: `pln-${Date.now()}` }));
    await ownerSock.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.content === content);

    await waitForPush();
    // Settle window: a stray second push (e.g. to the sender) would land here.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0]!.ids).toEqual([member.id]); // the visible member, never the sender
    expect(pushCalls[0]!.n.data).toMatchObject({
      type: "message",
      channelId: channel.id,
      groupId: group.id,
    });
    expect(pushCalls[0]!.n.collapseKey).toBe(`channel:${channel.id}`);

    ownerSock.close();
  });

  it("fires EXACTLY ONE push for a DM message that also @mentions the recipient (no double)", async () => {
    const a = await makeActor(repos, "ddmA");
    const b = await makeActor(repos, "ddmB");
    const { dm } = await repos.dms.getOrCreate(a.id, b.id);
    presence.setOffline(b.id);
    pushCalls.length = 0;

    const aSock = await TestClient.connect(port, a.token);
    await aSock.waitFor(SERVER_EVENT.authSucceeded);

    // The DM branch must win and suppress the mention push (roster overlaps).
    const content = `${encodeMention(b.id)} ping ping`;
    aSock.send(clientEvent.messageSend({ channelId: dm.streamId, content, nonce: `ddm-${Date.now()}` }));
    await aSock.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.content === content);

    await waitForPush();
    // Settle window: if a second (mention) push were wrongly fired, it would land here.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0]!.ids).toEqual([b.id]);
    expect(pushCalls[0]!.n.data).toMatchObject({ type: "dm_message", dmId: dm.id });

    aSock.close();
  });

  // Notification mute (0013): the WS send path reuses the SAME filter as REST.
  it("does NOT push a DM the recipient muted (mode=all)", async () => {
    const a = await makeActor(repos, "wsMuteA");
    const b = await makeActor(repos, "wsMuteB");
    const { dm } = await repos.dms.getOrCreate(a.id, b.id);
    // B mutes the DM channel entirely.
    await repos.notificationMutes.setMute({
      userId: b.id,
      scope: "channel",
      targetId: dm.streamId,
      mode: "all",
      until: null,
    });
    presence.setOffline(b.id);
    pushCalls.length = 0;

    const aSock = await TestClient.connect(port, a.token);
    await aSock.waitFor(SERVER_EVENT.authSucceeded);

    const content = "you won't get pinged for this";
    aSock.send(clientEvent.messageSend({ channelId: dm.streamId, content, nonce: `wsm-${Date.now()}` }));
    await aSock.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.content === content);

    // Settle window for the fire-and-forget push, then assert it did nothing.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(pushCalls).toEqual([]);

    aSock.close();
  });

  it("suppresses a mention push when the member muted the channel (mode=all)", async () => {
    const owner = await makeActor(repos, "wsMnO");
    const member = await makeActor(repos, "wsMnM");
    const group = await repos.groups.create({ name: "Muted Crew", ownerId: owner.id });
    await repos.groups.addMember(group.id, member.id, "member");
    const channel = await repos.channels.create({ groupId: group.id, kind: "text", name: "general" });
    await repos.notificationMutes.setMute({
      userId: member.id,
      scope: "channel",
      targetId: channel.id,
      mode: "all",
      until: null,
    });
    presence.setOffline(member.id);
    pushCalls.length = 0;

    const ownerSock = await TestClient.connect(port, owner.token);
    await ownerSock.waitFor(SERVER_EVENT.authSucceeded);

    const content = `hey ${encodeMention(member.id)} muted though`;
    ownerSock.send(clientEvent.messageSend({ channelId: channel.id, content, nonce: `wsmn-${Date.now()}` }));
    await ownerSock.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.content === content);

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(pushCalls).toEqual([]);

    ownerSock.close();
  });
});

// ---------------------------------------------------------------------------
// Redis cross-process smoke: a user-scoped event published from a SEPARATE bus
// (standing in for the api process) reaches a client on a gateway that only
// subscribes — the real production path (RedisMutationBus + RedisPresenceStore).
// ---------------------------------------------------------------------------

async function isRedisUp(): Promise<boolean> {
  const redis = createRedisClient(REDIS_URL, { lazyConnect: true });
  redis.on("error", () => undefined);
  try {
    await redis.connect();
    await redis.ping();
    return true;
  } catch {
    return false;
  } finally {
    await redis.quit().catch(() => undefined);
  }
}

const redisUp = dbUp && (await isRedisUp());
if (dbUp && !redisUp) {
  console.warn("[gateway.social.int.test] REDIS unreachable — skipping cross-process smoke");
}

describe.skipIf(!redisUp)("gateway social over Redis (cross-process smoke)", () => {
  let client: DbClient;
  let repos: Repositories;
  let gateway: Gateway;
  let gatewayBus: RedisMutationBus;
  let publisher: RedisMutationBus;
  let presenceRedis: ReturnType<typeof createRedisClient>;
  let port: number;
  let target: Actor;
  let counterpart: Actor;

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);

    presenceRedis = createRedisClient(REDIS_URL);
    presenceRedis.on("error", () => undefined);
    const prefix = `test:social:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;

    // The realtime process: subscribes to the bus, presence in Redis.
    gatewayBus = new RedisMutationBus(REDIS_URL);
    gateway = createGateway(
      {
        repos,
        presence: new RedisPresenceStore(presenceRedis, prefix),
        mutationBus: gatewayBus,
      },
      { port: 0 },
    );
    port = await gateway.ready;

    // The api process: only ever publishes.
    publisher = new RedisMutationBus(REDIS_URL);

    target = await makeActor(repos, "redisTgt");
    counterpart = await makeActor(repos, "redisOther");
  });

  afterAll(async () => {
    await gateway?.close();
    await gatewayBus?.close();
    await publisher?.close();
    await presenceRedis?.quit().catch(() => undefined);
    await client?.close();
  });

  it("delivers a user-scoped event published from another process", async () => {
    const sock = await TestClient.connect(port, target.token);
    await sock.waitFor(SERVER_EVENT.authSucceeded);

    // Retry the publish until delivered: the gateway's Redis SUBSCRIBE completes
    // asynchronously after createGateway returns, so an early publish can miss.
    const deadline = Date.now() + 5000;
    for (;;) {
      await publisher.publish({
        userId: target.id,
        event: serverEvent.friendRemoved({ userId: counterpart.id }),
      });
      try {
        await sock.waitFor(
          SERVER_EVENT.friendRemoved,
          (e) => e.payload.userId === counterpart.id,
          300,
        );
        break;
      } catch (err) {
        if (Date.now() > deadline) throw err;
      }
    }

    sock.close();
  });
});
