/**
 * Gateway integration tests — real Postgres + real WebSockets.
 * Skipped automatically (with a console notice) when the database is down.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createDb,
  createRepositories,
  generateSessionToken,
  hashSessionToken,
  InMemoryMutationBus,
  sessionExpiresAt,
  type DbClient,
  type Repositories,
} from "@demli/db";
import {
  clientEvent,
  serverEvent,
  SERVER_EVENT,
  type ServerEventOf,
} from "@demli/protocol";
import { createGateway, CLOSE_UNAUTHORIZED, type Gateway } from "../gateway.js";
import { InMemoryPresenceStore } from "../presence.js";
import { DATABASE_URL, isDbUp, TestClient } from "./harness.js";
import { refuseToSkipIfRequired } from "@demli/db/testing";

const dbUp = await isDbUp();
if (!dbUp) {
  refuseToSkipIfRequired("postgres");
  console.warn("[gateway.int.test] DATABASE unreachable — skipping integration tests");
}

describe.skipIf(!dbUp)("gateway integration", () => {
  let client: DbClient;
  let repos: Repositories;
  let gateway: Gateway;
  let mutationBus: InMemoryMutationBus;
  let port: number;

  let userAId: string;
  let userBId: string;
  let tokenA: string;
  let tokenB: string;
  let textChannelId: string;
  let voiceChannelId: string;

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);

    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const userA = await repos.users.create({
      username: `gwa_${suffix}`,
      displayName: "Gateway A",
      passwordHash: "not-used-in-this-test",
    });
    const userB = await repos.users.create({
      username: `gwb_${suffix}`,
      displayName: "Gateway B",
      passwordHash: "not-used-in-this-test",
    });
    userAId = userA.id;
    userBId = userB.id;

    tokenA = generateSessionToken();
    tokenB = generateSessionToken();
    const expiresAt = sessionExpiresAt(new Date(), 1);
    await repos.sessions.create({
      userId: userAId,
      tokenHash: hashSessionToken(tokenA),
      expiresAt,
    });
    await repos.sessions.create({
      userId: userBId,
      tokenHash: hashSessionToken(tokenB),
      expiresAt,
    });

    const group = await repos.groups.create({ name: "Gateway Crew", ownerId: userAId });
    await repos.groups.addMember(group.id, userBId, "member");
    const text = await repos.channels.create({
      groupId: group.id,
      kind: "text",
      name: "gw-general",
    });
    const voice = await repos.channels.create({
      groupId: group.id,
      kind: "voice",
      name: "gw-lobby",
    });
    textChannelId = text.id;
    voiceChannelId = voice.id;

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

  it("closes 4401 for a missing or invalid token", async () => {
    const noToken = await TestClient.connect(port, null);
    expect(await noToken.closed).toBe(CLOSE_UNAUTHORIZED);

    const badToken = await TestClient.connect(port, "forged-token");
    expect(await badToken.closed).toBe(CLOSE_UNAUTHORIZED);
  });

  it("delivers send → persist → broadcast with nonce echo and monotonic seq", async () => {
    const a = await TestClient.connect(port, tokenA);
    const b = await TestClient.connect(port, tokenB);

    const authA = await a.waitFor(SERVER_EVENT.authSucceeded);
    const authB = await b.waitFor(SERVER_EVENT.authSucceeded);
    expect(authA.payload.userId).toBe(userAId);
    expect(authB.payload.userId).toBe(userBId);
    // Presence snapshot covers co-members, including the peer.
    expect(authB.payload.presence.map((p) => p.userId)).toContain(userAId);

    const nonce = `nonce-${Date.now()}`;
    const content = `hello from A ${nonce}`;
    a.send(clientEvent.messageSend({ channelId: textChannelId, content, nonce }));

    const received = await b.waitFor(
      SERVER_EVENT.messageCreated,
      (e) => e.payload.content === content,
    );
    expect(received.payload.authorId).toBe(userAId);
    expect(received.payload.channelId).toBe(textChannelId);
    expect(received.payload.nonce).toBe(nonce);

    const echo = await a.waitFor(
      SERVER_EVENT.messageCreated,
      (e) => e.payload.content === content,
    );
    expect(echo.payload.nonce).toBe(nonce);

    // Persisted: visible via the query layer.
    const page = await repos.messages.listPage({ channelId: textChannelId, limit: 10 });
    expect(page.items.some((m) => m.content === content)).toBe(true);

    // Envelope seq is strictly monotonic per connection.
    const seqs = b.envelopes.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(seqs.length);

    a.close();
    b.close();
  });

  it("dedupes a retried message.send (same nonce) to one row and one canonical id", async () => {
    const a = await TestClient.connect(port, tokenA);
    await a.waitFor(SERVER_EVENT.authSucceeded);

    const nonce = `dedupe-${Date.now()}`;
    const content = `dedupe content ${nonce}`;
    const send = () =>
      a.send(clientEvent.messageSend({ channelId: textChannelId, content, nonce }));

    send();
    const first = await a.waitFor(
      SERVER_EVENT.messageCreated,
      (e) => e.payload.nonce === nonce,
    );
    // Retry the SAME send (simulating a lost first echo).
    send();
    // Give the gateway time to persist + re-broadcast the retry.
    await new Promise((r) => setTimeout(r, 400));

    const echoes = a.envelopes
      .map((env) => env.event)
      .filter(
        (ev): ev is ServerEventOf<"message.created"> =>
          ev.type === SERVER_EVENT.messageCreated,
      )
      .filter((ev) => ev.payload.nonce === nonce);
    // Both sends echoed, but they carry the SAME canonical message id.
    expect(echoes.length).toBeGreaterThanOrEqual(2);
    expect(new Set(echoes.map((ev) => ev.payload.id)).size).toBe(1);
    expect(echoes[0]?.payload.id).toBe(first.payload.id);

    // Exactly one persisted row for that content.
    const page = await repos.messages.listPage({ channelId: textChannelId, limit: 100 });
    const persisted = page.items.filter((m) => m.content === content);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.id).toBe(first.payload.id);

    a.close();
  });

  it("fans API-originated message.updated/deleted from the bus to subscribers", async () => {
    const a = await TestClient.connect(port, tokenA);
    const b = await TestClient.connect(port, tokenB);
    await a.waitFor(SERVER_EVENT.authSucceeded);
    await b.waitFor(SERVER_EVENT.authSucceeded);

    const created = await repos.messages.create({
      channelId: textChannelId,
      authorId: userAId,
      content: "to be edited over http",
    });

    // Simulate the API publishing an edit (its own process) onto the bus.
    const edited = {
      ...created,
      content: "edited via http",
      updatedAt: new Date().toISOString(),
    };
    await mutationBus.publish({
      channelId: textChannelId,
      event: serverEvent.messageUpdated(edited),
    });
    const gotUpdate = await b.waitFor(
      SERVER_EVENT.messageUpdated,
      (e) => e.payload.id === created.id,
    );
    expect(gotUpdate.payload.content).toBe("edited via http");

    // ...and a delete.
    await mutationBus.publish({
      channelId: textChannelId,
      event: serverEvent.messageDeleted({
        channelId: textChannelId,
        messageId: created.id,
      }),
    });
    const gotDelete = await b.waitFor(
      SERVER_EVENT.messageDeleted,
      (e) => e.payload.messageId === created.id,
    );
    expect(gotDelete.payload.channelId).toBe(textChannelId);

    // Bus-originated broadcasts use the normal enveloped, monotonic-seq path.
    const seqs = b.envelopes.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));

    a.close();
    b.close();
  });

  it("broadcasts typing to peers but not back to the sender", async () => {
    const a = await TestClient.connect(port, tokenA);
    const b = await TestClient.connect(port, tokenB);
    await a.waitFor(SERVER_EVENT.authSucceeded);
    await b.waitFor(SERVER_EVENT.authSucceeded);

    a.send(clientEvent.typingStart({ channelId: textChannelId, userId: userAId }));
    const typing = await b.waitFor(SERVER_EVENT.typingStarted);
    expect(typing.payload.userId).toBe(userAId);
    expect(
      a.envelopes.some((e) => e.event.type === SERVER_EVENT.typingStarted),
    ).toBe(false);

    // Spoofed userId is rejected with a typed error.
    a.send(clientEvent.typingStart({ channelId: textChannelId, userId: userBId }));
    const err = await a.waitFor(SERVER_EVENT.errorRaised);
    expect(err.payload.code).toBe("INVALID_PAYLOAD");

    a.close();
    b.close();
  });

  it("relays voice signaling metadata (join/leave, no media)", async () => {
    const a = await TestClient.connect(port, tokenA);
    const b = await TestClient.connect(port, tokenB);
    await a.waitFor(SERVER_EVENT.authSucceeded);
    await b.waitFor(SERVER_EVENT.authSucceeded);

    a.send(clientEvent.voiceJoin({ channelId: voiceChannelId }));
    const joined = await b.waitFor(SERVER_EVENT.voiceParticipantJoined);
    expect(joined.payload).toEqual({
      channelId: voiceChannelId,
      userId: userAId,
      muted: false,
    });

    a.send(clientEvent.voiceLeave({ channelId: voiceChannelId }));
    const left = await b.waitFor(SERVER_EVENT.voiceParticipantLeft);
    expect(left.payload.userId).toBe(userAId);

    a.close();
    b.close();
  });

  /**
   * M20 — a voice channel's own text chat over the socket. This replaces the
   * assertion that used to close the test above (a `message.send` into a voice
   * channel answered `INVALID_CHANNEL`); the send is now accepted on exactly the
   * same terms as a text channel's, and the peer's copy is what a client's unread
   * counter is built on, so the fan-out is asserted rather than just the echo.
   */
  it("delivers a message sent into a VOICE channel to the channel's subscribers", async () => {
    const a = await TestClient.connect(port, tokenA);
    const b = await TestClient.connect(port, tokenB);
    await a.waitFor(SERVER_EVENT.authSucceeded);
    await b.waitFor(SERVER_EVENT.authSucceeded);

    const nonce = `voice-nonce-${Date.now()}`;
    const content = `talking in the lobby ${nonce}`;
    // Neither socket has joined the voice room: reaching a voice channel's chat
    // requires SEEING the channel, not sitting in it.
    a.send(clientEvent.messageSend({ channelId: voiceChannelId, content, nonce }));

    // Author echo, nonce-matched (optimistic reconciliation, §22).
    const echo = await a.waitFor(SERVER_EVENT.messageCreated);
    expect(echo.payload.channelId).toBe(voiceChannelId);
    expect(echo.payload.content).toBe(content);
    expect(echo.payload.nonce).toBe(nonce);

    // Peer copy — the unread-counter substrate. B is subscribed to the voice
    // channel because `channelKinds` has always covered voice channels.
    const peer = await b.waitFor(SERVER_EVENT.messageCreated);
    expect(peer.payload.id).toBe(echo.payload.id);
    expect(peer.payload.channelId).toBe(voiceChannelId);

    // Persisted, and readable through the same repo the HTTP history uses.
    const page = await repos.messages.listPage({ channelId: voiceChannelId });
    expect(page.items.map((m) => m.id)).toContain(echo.payload.id);

    a.close();
    b.close();
  });

  it("seeds voice-channel occupancy in the auth.succeeded snapshot, live-updated after", async () => {
    const a = await TestClient.connect(port, tokenA);
    await a.waitFor(SERVER_EVENT.authSucceeded);

    // A joins voice; wait for A's own echo so the reverse index is populated.
    a.send(clientEvent.voiceJoin({ channelId: voiceChannelId }));
    await a.waitFor(SERVER_EVENT.voiceParticipantJoined);

    // A freshly connecting member sees who is ALREADY in the voice channel —
    // without waiting for a delta (the snapshot rides on auth.succeeded).
    const b = await TestClient.connect(port, tokenB);
    const authB = await b.waitFor(SERVER_EVENT.authSucceeded);
    expect(authB.payload.voiceOccupancy).toEqual([
      { channelId: voiceChannelId, occupants: [{ userId: userAId, muted: false }] },
    ]);

    // Deltas still flow to B after the snapshot: A leaving empties the channel.
    a.send(clientEvent.voiceLeave({ channelId: voiceChannelId }));
    const left = await b.waitFor(SERVER_EVENT.voiceParticipantLeft);
    expect(left.payload.userId).toBe(userAId);

    // A brand-new connection now sees an empty occupancy (channel drained).
    const c = await TestClient.connect(port, tokenB);
    const authC = await c.waitFor(SERVER_EVENT.authSucceeded);
    expect(authC.payload.voiceOccupancy).toEqual([]);

    a.close();
    b.close();
    c.close();
  });

  it("pushes an authoritative voice.resync (media-plane occupancy incl. screen-share) after auth", async () => {
    // STATE RESYNC: a dedicated gateway wired with a FAKE media-plane reader, so
    // the authoritative snapshot carries data the in-memory map never has —
    // occupancy for a peer this connection never saw join, WITH screen-share.
    const readCalls: string[][] = [];
    const resyncGateway = createGateway(
      {
        repos,
        presence: new InMemoryPresenceStore(),
        mutationBus: new InMemoryMutationBus(),
        voiceOccupancy: {
          read: async (voiceChannelIds: string[]) => {
            readCalls.push(voiceChannelIds);
            return new Map(
              voiceChannelIds.includes(voiceChannelId)
                ? [[voiceChannelId, [{ userId: userBId, muted: false, screenSharing: true, camera: false }]]]
                : [],
            );
          },
        },
      },
      { port: 0 },
    );
    const resyncPort = await resyncGateway.ready;

    try {
      const a = await TestClient.connect(resyncPort, tokenA);
      await a.waitFor(SERVER_EVENT.authSucceeded);

      const resync = await a.waitFor(SERVER_EVENT.voiceResync);
      expect(resync.payload.channels).toEqual([
        {
          channelId: voiceChannelId,
          occupants: [{ userId: userBId, muted: false, screenSharing: true, camera: false }],
        },
      ]);
      // Visibility: the reader is asked ONLY about the caller's visible voice
      // channel (§28) — the same boundary auth.succeeded occupancy obeys.
      expect(readCalls).toEqual([[voiceChannelId]]);

      a.close();
    } finally {
      await resyncGateway.close();
    }
  });

  it("enforces slowmode on non-owner sends with retryAfterSeconds; owner exempt", async () => {
    // Enable slowmode at runtime (as PATCH /channels/:id would) — the gateway
    // must pick it up per send without a reconnect.
    await repos.channels.update(textChannelId, { slowmodeSeconds: 30 });
    try {
      const owner = await TestClient.connect(port, tokenA);
      const member = await TestClient.connect(port, tokenB);
      await owner.waitFor(SERVER_EVENT.authSucceeded);
      await member.waitFor(SERVER_EVENT.authSucceeded);

      // Member's first message lands (and carries kind "user").
      const firstNonce = `slow-first-${Date.now()}`;
      member.send(
        clientEvent.messageSend({
          channelId: textChannelId,
          content: "first under slowmode",
          nonce: firstNonce,
        }),
      );
      const created = await member.waitFor(
        SERVER_EVENT.messageCreated,
        (e) => e.payload.nonce === firstNonce,
      );
      expect(created.payload.kind).toBe("user");

      // The second one within the window is refused with the remaining wait.
      const secondNonce = `slow-second-${Date.now()}`;
      member.send(
        clientEvent.messageSend({
          channelId: textChannelId,
          content: "second under slowmode",
          nonce: secondNonce,
        }),
      );
      const err = await member.waitFor(
        SERVER_EVENT.errorRaised,
        (e) => e.payload.nonce === secondNonce,
      );
      expect(err.payload.code).toBe("SLOWMODE");
      expect(err.payload.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(err.payload.retryAfterSeconds).toBeLessThanOrEqual(30);

      // The owner is exempt: two immediate sends both land.
      for (const i of [1, 2]) {
        const nonce = `slow-owner-${i}-${Date.now()}`;
        owner.send(
          clientEvent.messageSend({
            channelId: textChannelId,
            content: `owner send ${i}`,
            nonce,
          }),
        );
        await owner.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.nonce === nonce);
      }

      owner.close();
      member.close();
    } finally {
      // Never leak slowmode into the remaining tests.
      await repos.channels.update(textChannelId, { slowmodeSeconds: 0 });
    }
  });

  it("broadcasts presence going offline when the peer disconnects", async () => {
    const a = await TestClient.connect(port, tokenA);
    const b = await TestClient.connect(port, tokenB);
    await a.waitFor(SERVER_EVENT.authSucceeded);
    await b.waitFor(SERVER_EVENT.authSucceeded);

    b.close();
    const offline = await a.waitFor(
      SERVER_EVENT.presenceUpdated,
      (e) => e.payload.userId === userBId && e.payload.status === "offline",
    );
    expect(offline.payload.status).toBe("offline");
    a.close();
  });

  it("rejects malformed frames per protocol rules", async () => {
    // Unknown event type → close 1008.
    const a = await TestClient.connect(port, tokenA);
    await a.waitFor(SERVER_EVENT.authSucceeded);
    a.sendRaw(JSON.stringify({ type: "media.stream_audio", payload: {} }));
    expect(await a.closed).toBe(1008);

    // Known type with a bad payload → typed error, connection stays open.
    const b = await TestClient.connect(port, tokenB);
    await b.waitFor(SERVER_EVENT.authSucceeded);
    b.sendRaw(
      JSON.stringify(clientEvent.messageSend({ channelId: textChannelId, content: "", nonce: "n2" })),
    );
    const err = await b.waitFor(SERVER_EVENT.errorRaised);
    expect(err.payload.code).toBe("INVALID_PAYLOAD");
    expect(err.payload.nonce).toBe("n2");

    // Non-JSON → close 1003.
    b.sendRaw("this is not json");
    expect(await b.closed).toBe(1003);
  });
});

/**
 * Channel visibility + role/access resync (M9-4, ADR 0007). Proves:
 * a restricted channel is never subscribed at handshake; a group-scoped
 * role/access mutation forwards the thin event to the whole server and re-syncs
 * the affected connection's subscriptions (frames start/stop); losing access to
 * an active voice channel forces a leave.
 */
describe.skipIf(!dbUp)("gateway visibility & role resync", () => {
  let client: DbClient;
  let repos: Repositories;
  let gateway: Gateway;
  let mutationBus: InMemoryMutationBus;
  let port: number;

  let ownerId: string;
  let tokenOwner: string;
  let groupId: string;
  let roleId: string;
  let publicTextId: string;
  let restrictedTextId: string;
  let restrictedVoiceId: string;
  let expiresAt: Date;

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);

    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const owner = await repos.users.create({
      username: `rv_o_${suffix}`,
      displayName: "Owner",
      passwordHash: "not-used",
    });
    ownerId = owner.id;
    tokenOwner = generateSessionToken();
    expiresAt = sessionExpiresAt(new Date(), 1);
    await repos.sessions.create({
      userId: ownerId,
      tokenHash: hashSessionToken(tokenOwner),
      expiresAt,
    });

    const group = await repos.groups.create({ name: "Visibility Crew", ownerId });
    groupId = group.id;
    const publicText = await repos.channels.create({ groupId, kind: "text", name: "public" });
    const restrictedText = await repos.channels.create({
      groupId,
      kind: "text",
      name: "vip-text",
    });
    const restrictedVoice = await repos.channels.create({
      groupId,
      kind: "voice",
      name: "vip-voice",
    });
    publicTextId = publicText.id;
    restrictedTextId = restrictedText.id;
    restrictedVoiceId = restrictedVoice.id;

    const role = await repos.roles.create({ groupId, name: "VIP" });
    roleId = role.id;
    // Lock both VIP channels to the VIP role (owner still sees them via bypass).
    await repos.channelAccess.setChannelRoles(groupId, restrictedTextId, [roleId]);
    await repos.channelAccess.setChannelRoles(groupId, restrictedVoiceId, [roleId]);

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

  /** A brand-new member of the group (isolates each test's role state). */
  async function freshMember(
    roleIds: string[] = [],
  ): Promise<{ id: string; token: string }> {
    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const user = await repos.users.create({
      username: `rv_m_${suffix}`,
      displayName: "Member",
      passwordHash: "not-used",
    });
    const token = generateSessionToken();
    await repos.sessions.create({
      userId: user.id,
      tokenHash: hashSessionToken(token),
      expiresAt,
    });
    await repos.groups.addMember(groupId, user.id, "member");
    if (roleIds.length > 0) await repos.roles.setMemberRoles(groupId, user.id, roleIds);
    return { id: user.id, token };
  }

  /** Persist + fan a message.created on `channelId` (channel-scoped, as the API does). */
  async function fanMessage(channelId: string, content: string): Promise<void> {
    const message = await repos.messages.create({ channelId, authorId: ownerId, content });
    await mutationBus.publish({ channelId, event: serverEvent.messageCreated(message) });
  }

  /**
   * Fan `content` on `channelId` until `target` receives it. A group resync
   * updates a connection's subscription set asynchronously (after the thin event
   * is forwarded), so re-fanning until delivery is the deterministic barrier for
   * "the subscribe has landed" — a frame sent before it lands is simply dropped.
   */
  async function fanUntilReceived(
    channelId: string,
    content: string,
    target: TestClient,
  ): Promise<ServerEventOf<"message.created">> {
    const deadline = Date.now() + 4000;
    for (;;) {
      await fanMessage(channelId, content);
      try {
        return await target.waitFor(
          SERVER_EVENT.messageCreated,
          (e) => e.payload.content === content,
          250,
        );
      } catch (err) {
        if (Date.now() > deadline) throw err;
      }
    }
  }

  /**
   * Assert `target` never received `absentContent`, using a message on the always
   * -visible public channel as a delivery barrier: if the absent frame were going
   * to arrive it would land (same ordered socket) before the marker does.
   */
  async function assertNotDelivered(
    target: TestClient,
    absentContent: string,
  ): Promise<void> {
    const marker = `barrier-${Date.now()}-${Math.random()}`;
    await fanMessage(publicTextId, marker);
    await target.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.content === marker);
    const leaked = target.envelopes.some(
      (env) =>
        env.event.type === SERVER_EVENT.messageCreated &&
        env.event.payload.content === absentContent,
    );
    expect(leaked).toBe(false);
  }

  it("never subscribes a member to a channel they cannot see at handshake", async () => {
    const member = await freshMember();
    const m = await TestClient.connect(port, member.token);
    const owner = await TestClient.connect(port, tokenOwner);
    await m.waitFor(SERVER_EVENT.authSucceeded);
    await owner.waitFor(SERVER_EVENT.authSucceeded);

    // A restricted-channel frame reaches the owner (bypass) but never the member.
    const secret = `secret-${Date.now()}`;
    await fanMessage(restrictedTextId, secret);
    await owner.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.content === secret);
    await assertNotDelivered(m, secret);

    // The member also cannot act on it (not in the subscription set).
    m.send(clientEvent.typingStart({ channelId: restrictedTextId, userId: member.id }));
    const err = await m.waitFor(SERVER_EVENT.errorRaised);
    expect(err.payload.code).toBe("NOT_A_MEMBER");

    m.close();
    owner.close();
  });

  it("delivers channel.created for a restricted channel only to members who can see it", async () => {
    const member = await freshMember(); // no VIP role — cannot see the new channel
    const m = await TestClient.connect(port, member.token);
    const owner = await TestClient.connect(port, tokenOwner);
    await m.waitFor(SERVER_EVENT.authSucceeded);
    await owner.waitFor(SERVER_EVENT.authSucceeded);

    // Create a NEW channel ALREADY restricted to VIP at creation (task #51 —
    // atomic create + access rows), then publish the lifecycle event as the API does.
    const secret = await repos.channels.create({
      groupId,
      kind: "text",
      name: `vip-new-${Date.now()}`,
      roleIds: [roleId],
    });
    await mutationBus.publish({ groupId, event: serverEvent.channelCreated(secret) });

    // The owner (visibility bypass) is told about it.
    const gotOwner = await owner.waitFor(
      SERVER_EVENT.channelCreated,
      (e) => e.payload.id === secret.id,
    );
    expect(gotOwner.payload.id).toBe(secret.id);

    // The role-less member never receives it. Barrier: a public-channel message the
    // member DOES receive proves its socket had the chance — the restricted
    // channel.created would have landed first (same ordered socket) had it been sent.
    const marker = `cc-barrier-${Date.now()}`;
    await fanMessage(publicTextId, marker);
    await m.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.content === marker);
    const leaked = m.envelopes.some(
      (env) =>
        env.event.type === SERVER_EVENT.channelCreated && env.event.payload.id === secret.id,
    );
    expect(leaked).toBe(false);

    // And the member cannot act on the channel it never learned about.
    m.send(clientEvent.typingStart({ channelId: secret.id, userId: member.id }));
    const err = await m.waitFor(SERVER_EVENT.errorRaised);
    expect(err.payload.code).toBe("NOT_A_MEMBER");

    m.close();
    owner.close();
  });

  it("forwards member.roles_updated to the whole group and starts frames flowing", async () => {
    const member = await freshMember();
    const m = await TestClient.connect(port, member.token);
    const owner = await TestClient.connect(port, tokenOwner);
    await m.waitFor(SERVER_EVENT.authSucceeded);
    await owner.waitFor(SERVER_EVENT.authSucceeded);

    // Grant the VIP role over HTTP (DB), then publish the group-scoped event.
    await repos.roles.setMemberRoles(groupId, member.id, [roleId]);
    await mutationBus.publish({
      groupId,
      event: serverEvent.memberRolesUpdated({ groupId, userId: member.id, roleIds: [roleId] }),
    });

    // Thin event forwarded to BOTH the affected member and other group members.
    const forwardedToMember = await m.waitFor(
      SERVER_EVENT.memberRolesUpdated,
      (e) => e.payload.userId === member.id,
    );
    expect(forwardedToMember.payload.roleIds).toEqual([roleId]);
    await owner.waitFor(SERVER_EVENT.memberRolesUpdated, (e) => e.payload.userId === member.id);

    // The member is now subscribed: restricted-channel frames reach them.
    const nowVisible = `now-visible-${Date.now()}`;
    const got = await fanUntilReceived(restrictedTextId, nowVisible, m);
    expect(got.payload.channelId).toBe(restrictedTextId);

    m.close();
    owner.close();
  });

  it("stops frames and forces voice.leave when the member loses access", async () => {
    const member = await freshMember([roleId]); // starts WITH the VIP role
    const m = await TestClient.connect(port, member.token);
    const owner = await TestClient.connect(port, tokenOwner);
    await m.waitFor(SERVER_EVENT.authSucceeded);
    await owner.waitFor(SERVER_EVENT.authSucceeded);

    // The member joins the restricted VOICE channel (visible while they hold VIP).
    m.send(clientEvent.voiceJoin({ channelId: restrictedVoiceId }));
    await owner.waitFor(
      SERVER_EVENT.voiceParticipantJoined,
      (e) => e.payload.userId === member.id && e.payload.channelId === restrictedVoiceId,
    );

    // Revoke the role over HTTP, then publish the group-scoped event.
    await repos.roles.setMemberRoles(groupId, member.id, []);
    await mutationBus.publish({
      groupId,
      event: serverEvent.memberRolesUpdated({ groupId, userId: member.id, roleIds: [] }),
    });

    // The member is forced out of the now-invisible voice channel (own userId).
    const forcedLeave = await m.waitFor(
      SERVER_EVENT.voiceParticipantLeft,
      (e) => e.payload.userId === member.id && e.payload.channelId === restrictedVoiceId,
    );
    expect(forcedLeave.payload.channelId).toBe(restrictedVoiceId);
    // The forced-leave frame is emitted in the same synchronous step as the
    // unsubscribe, so receiving it guarantees the member is now off the channel.

    // And restricted-channel frames no longer reach them.
    const post = `post-revoke-secret-${Date.now()}`;
    await fanMessage(restrictedTextId, post);
    await assertNotDelivered(m, post);

    m.close();
    owner.close();
  });

  it("forwards channel.access_changed group-wide and re-subscribes on re-open", async () => {
    const member = await freshMember(); // no role → cannot see the VIP text channel
    const m = await TestClient.connect(port, member.token);
    const owner = await TestClient.connect(port, tokenOwner);
    await m.waitFor(SERVER_EVENT.authSucceeded);
    await owner.waitFor(SERVER_EVENT.authSucceeded);

    // Re-open the channel to everyone (public) over HTTP, then publish the event.
    await repos.channelAccess.setChannelRoles(groupId, restrictedTextId, []);
    try {
      await mutationBus.publish({
        groupId,
        event: serverEvent.channelAccessChanged({ groupId, channelId: restrictedTextId }),
      });

      // Thin event forwarded to the whole group (owner + member).
      await m.waitFor(
        SERVER_EVENT.channelAccessChanged,
        (e) => e.payload.channelId === restrictedTextId,
      );
      await owner.waitFor(
        SERVER_EVENT.channelAccessChanged,
        (e) => e.payload.channelId === restrictedTextId,
      );

      // The member is now subscribed to the re-opened channel.
      const opened = `opened-${Date.now()}`;
      const got = await fanUntilReceived(restrictedTextId, opened, m);
      expect(got.payload.channelId).toBe(restrictedTextId);
    } finally {
      // Restore the restriction so channel state stays consistent.
      await repos.channelAccess.setChannelRoles(groupId, restrictedTextId, [roleId]);
    }

    m.close();
    owner.close();
  });
});

/**
 * Channel & member lifecycle (task #43). Proves the class of bug where a channel
 * created AFTER a member's handshake stayed invisible until they navigated away
 * and back: the gateway now subscribes connected members to a newly created
 * channel (frames start flowing at once), drops every subscription to a deleted
 * channel (frames stop), and forces a leaving/kicked member out of a voice room.
 */
describe.skipIf(!dbUp)("gateway channel & member lifecycle", () => {
  let client: DbClient;
  let repos: Repositories;
  let gateway: Gateway;
  let mutationBus: InMemoryMutationBus;
  let port: number;

  let ownerId: string;
  let tokenOwner: string;
  let memberId: string;
  let tokenMember: string;
  let groupId: string;
  let publicTextId: string;
  let expiresAt: Date;

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);

    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const owner = await repos.users.create({
      username: `lc_o_${suffix}`,
      displayName: "LC Owner",
      passwordHash: "not-used",
    });
    const member = await repos.users.create({
      username: `lc_m_${suffix}`,
      displayName: "LC Member",
      passwordHash: "not-used",
    });
    ownerId = owner.id;
    memberId = member.id;
    tokenOwner = generateSessionToken();
    tokenMember = generateSessionToken();
    expiresAt = sessionExpiresAt(new Date(), 1);
    await repos.sessions.create({
      userId: ownerId,
      tokenHash: hashSessionToken(tokenOwner),
      expiresAt,
    });
    await repos.sessions.create({
      userId: memberId,
      tokenHash: hashSessionToken(tokenMember),
      expiresAt,
    });

    const group = await repos.groups.create({ name: "Lifecycle Crew", ownerId });
    groupId = group.id;
    await repos.groups.addMember(groupId, memberId, "member");
    const publicText = await repos.channels.create({ groupId, kind: "text", name: "general" });
    publicTextId = publicText.id;

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

  /** Persist + fan a channel-scoped message.created (exactly as the API does). */
  async function fanMessage(channelId: string, content: string): Promise<void> {
    const message = await repos.messages.create({ channelId, authorId: ownerId, content });
    await mutationBus.publish({ channelId, event: serverEvent.messageCreated(message) });
  }

  /**
   * Fan an EPHEMERAL channel-scoped message.created without touching the DB — used
   * to probe a DELETED channel whose row (and FK target) no longer exists.
   */
  async function fanEphemeral(channelId: string, content: string): Promise<void> {
    await mutationBus.publish({
      channelId,
      event: serverEvent.messageCreated({
        id: randomUUID(),
        channelId,
        authorId: ownerId,
        content,
        kind: "user",
        createdAt: new Date().toISOString(),
        updatedAt: null,
        deletedAt: null,
      }),
    });
  }

  /** Re-fan until `target` receives it — the deterministic barrier for "subscribe landed". */
  async function fanUntilReceived(
    channelId: string,
    content: string,
    target: TestClient,
  ): Promise<ServerEventOf<"message.created">> {
    const deadline = Date.now() + 4000;
    for (;;) {
      await fanMessage(channelId, content);
      try {
        return await target.waitFor(
          SERVER_EVENT.messageCreated,
          (e) => e.payload.content === content,
          250,
        );
      } catch (err) {
        if (Date.now() > deadline) throw err;
      }
    }
  }

  /**
   * Assert `target` never received `absentContent`, using a message on the always
   * -visible public channel as an ordered delivery barrier: the absent frame, if
   * coming, lands before the marker does (same socket, in order).
   */
  async function assertNotDelivered(
    target: TestClient,
    absentContent: string,
  ): Promise<void> {
    const marker = `barrier-${Date.now()}-${Math.random()}`;
    await fanMessage(publicTextId, marker);
    await target.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.content === marker);
    const leaked = target.envelopes.some(
      (env) =>
        env.event.type === SERVER_EVENT.messageCreated &&
        env.event.payload.content === absentContent,
    );
    expect(leaked).toBe(false);
  }

  it("subscribes existing members to a channel created after their handshake", async () => {
    const owner = await TestClient.connect(port, tokenOwner);
    const m = await TestClient.connect(port, tokenMember);
    await owner.waitFor(SERVER_EVENT.authSucceeded);
    await m.waitFor(SERVER_EVENT.authSucceeded);

    // A brand-new channel, created (DB) then fanned (bus) exactly as the API does.
    const created = await repos.channels.create({ groupId, kind: "text", name: "fresh" });
    await mutationBus.publish({
      groupId,
      event: serverEvent.channelCreated(created),
    });

    // The thin event reaches BOTH the member and the owner (roster/list refresh).
    const forwarded = await m.waitFor(
      SERVER_EVENT.channelCreated,
      (e) => e.payload.id === created.id,
    );
    expect(forwarded.payload.groupId).toBe(groupId);
    await owner.waitFor(SERVER_EVENT.channelCreated, (e) => e.payload.id === created.id);

    // And — the actual fix — the member is now subscribed: messages in the new
    // channel flow to them WITHOUT a reconnect or navigation.
    const hello = `hello-fresh-${Date.now()}`;
    const got = await fanUntilReceived(created.id, hello, m);
    expect(got.payload.channelId).toBe(created.id);

    owner.close();
    m.close();
  });

  it("stops frames to every member when a channel is deleted", async () => {
    const owner = await TestClient.connect(port, tokenOwner);
    const m = await TestClient.connect(port, tokenMember);
    await owner.waitFor(SERVER_EVENT.authSucceeded);
    await m.waitFor(SERVER_EVENT.authSucceeded);

    const doomed = await repos.channels.create({ groupId, kind: "text", name: "doomed" });
    await mutationBus.publish({ groupId, event: serverEvent.channelCreated(doomed) });
    // Confirm the member is subscribed before we delete it.
    await fanUntilReceived(doomed.id, `pre-delete-${Date.now()}`, m);

    // Delete (DB) then fan channel.deleted (bus), exactly as the API does.
    await repos.channels.delete(doomed.id);
    await mutationBus.publish({
      groupId,
      event: serverEvent.channelDeleted({ channelId: doomed.id, groupId }),
    });

    // Thin event forwarded to the member (their client prunes the channel).
    const gone = await m.waitFor(
      SERVER_EVENT.channelDeleted,
      (e) => e.payload.channelId === doomed.id,
    );
    expect(gone.payload.groupId).toBe(groupId);

    // Frames for the dead channel no longer reach the member (unsubscribed).
    const absent = `post-delete-${Date.now()}`;
    await fanEphemeral(doomed.id, absent);
    await assertNotDelivered(m, absent);

    owner.close();
    m.close();
  });

  it("forces a member out of a voice room when they leave / are kicked", async () => {
    // Create the voice channel BEFORE connecting so both sockets subscribe to it
    // at handshake — no channel.created resync race for the join itself.
    const voice = await repos.channels.create({ groupId, kind: "voice", name: "lc-lobby" });
    const owner = await TestClient.connect(port, tokenOwner);
    const m = await TestClient.connect(port, tokenMember);
    await owner.waitFor(SERVER_EVENT.authSucceeded);
    await m.waitFor(SERVER_EVENT.authSucceeded);

    m.send(clientEvent.voiceJoin({ channelId: voice.id }));
    await owner.waitFor(
      SERVER_EVENT.voiceParticipantJoined,
      (e) => e.payload.userId === memberId && e.payload.channelId === voice.id,
    );

    // Kick the member (DB), then fan member.left (bus), exactly as the API does.
    await repos.groups.removeMember(groupId, memberId);
    await mutationBus.publish({
      groupId,
      event: serverEvent.memberLeft({ groupId, userId: memberId }),
    });

    // The kicked member is forced out of the voice room (their own userId).
    const forcedLeave = await m.waitFor(
      SERVER_EVENT.voiceParticipantLeft,
      (e) => e.payload.userId === memberId && e.payload.channelId === voice.id,
    );
    expect(forcedLeave.payload.channelId).toBe(voice.id);
    // The owner (still subscribed to the voice channel) also sees them leave.
    await owner.waitFor(
      SERVER_EVENT.voiceParticipantLeft,
      (e) => e.payload.userId === memberId && e.payload.channelId === voice.id,
    );
    // And the member.left thin event reached the owner (roster refresh).
    await owner.waitFor(SERVER_EVENT.memberLeft, (e) => e.payload.userId === memberId);

    // The kicked member no longer receives this server's channel frames. Barrier:
    // fan on the public channel and wait for the still-subscribed OWNER to get it;
    // owner and (would-be) member are served in the same synchronous broadcast, so
    // by the time the owner has it the member was definitively not sent it.
    const absent = `post-kick-${Date.now()}`;
    await fanMessage(publicTextId, absent);
    await owner.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.content === absent);
    const leaked = m.envelopes.some(
      (env) =>
        env.event.type === SERVER_EVENT.messageCreated &&
        env.event.payload.content === absent,
    );
    expect(leaked).toBe(false);

    owner.close();
    m.close();
  });

  it("drops the whole server from every member and tears down voice on group.deleted", async () => {
    // A SURVIVOR server (kept) provides the delivery barrier for the member, plus
    // a DOOMED server both users belong to with a voice channel. Everything is
    // created BEFORE connecting so both sockets subscribe at handshake — an
    // earlier test in this block kicked the member from the shared group, so we
    // cannot rely on it here.
    const survivor = await repos.groups.create({ name: "Survivor Server", ownerId });
    await repos.groups.addMember(survivor.id, memberId, "member");
    const survivorText = await repos.channels.create({
      groupId: survivor.id,
      kind: "text",
      name: "s-gen",
    });

    const doomed = await repos.groups.create({ name: "Doomed Server", ownerId });
    await repos.groups.addMember(doomed.id, memberId, "member");
    const gText = await repos.channels.create({ groupId: doomed.id, kind: "text", name: "g-gen" });
    const gVoice = await repos.channels.create({ groupId: doomed.id, kind: "voice", name: "g-lob" });

    const owner = await TestClient.connect(port, tokenOwner);
    const m = await TestClient.connect(port, tokenMember);
    await owner.waitFor(SERVER_EVENT.authSucceeded);
    await m.waitFor(SERVER_EVENT.authSucceeded);

    // The member is sitting in the doomed server's voice room.
    m.send(clientEvent.voiceJoin({ channelId: gVoice.id }));
    await owner.waitFor(
      SERVER_EVENT.voiceParticipantJoined,
      (e) => e.payload.userId === memberId && e.payload.channelId === gVoice.id,
    );

    // Delete the whole server (DB cascade) then fan group.deleted (bus) — the API
    // path for both an owner delete and the auto-delete-when-empty case.
    await repos.groups.delete(doomed.id);
    await mutationBus.publish({
      groupId: doomed.id,
      event: serverEvent.groupDeleted({ groupId: doomed.id }),
    });

    // Thin event reaches BOTH members (clients drop the server + route away).
    const gone = await m.waitFor(
      SERVER_EVENT.groupDeleted,
      (e) => e.payload.groupId === doomed.id,
    );
    expect(gone.payload.groupId).toBe(doomed.id);
    await owner.waitFor(SERVER_EVENT.groupDeleted, (e) => e.payload.groupId === doomed.id);

    // The member in the deleted server's voice room is forced out (own userId),
    // emitted while still subscribed so the owner (also subscribed) sees it too.
    const forced = await m.waitFor(
      SERVER_EVENT.voiceParticipantLeft,
      (e) => e.payload.userId === memberId && e.payload.channelId === gVoice.id,
    );
    expect(forced.payload.channelId).toBe(gVoice.id);

    // Frames for the dead server's channels no longer reach the member: they were
    // unsubscribed. An ephemeral fan on the (now-deleted) doomed text channel must
    // NOT arrive; a fan on the SURVIVOR channel — which the member still sees —
    // is the ordered barrier proving the doomed frame was never sent.
    const absent = `post-group-delete-${Date.now()}`;
    await fanEphemeral(gText.id, absent);
    const marker = `survivor-marker-${Date.now()}`;
    await fanUntilReceived(survivorText.id, marker, m);
    const leaked = m.envelopes.some(
      (env) =>
        env.event.type === SERVER_EVENT.messageCreated &&
        env.event.payload.content === absent,
    );
    expect(leaked).toBe(false);

    owner.close();
    m.close();
  });
});
