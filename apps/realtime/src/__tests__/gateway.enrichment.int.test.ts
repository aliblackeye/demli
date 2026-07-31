/**
 * M14 W4 — message enrichment over the gateway (ADR 0011) — real Postgres + real
 * WebSockets. Two concerns:
 *
 * 1. Reply over WS (`handleMessageSend`): a `message.send` carrying a valid
 *    `replyToMessageId` persists the FK and broadcasts `message.created` enriched
 *    with the quote preview (`replyTo`) to every subscriber AND the sender's
 *    nonce'd echo; a soft-deleted target renders the "deleted" stub; a
 *    cross-channel or nonexistent target is refused with a nonce'd INVALID_PAYLOAD
 *    and NOTHING is broadcast; the optimistic-reconciliation nonce is preserved;
 *    a normal (non-reply) send carries no `replyTo`.
 *
 * 2. Reaction fan-out: the API publishes channel-scoped
 *    `message.reaction_added`/`removed` on the mutation bus; the gateway forwards
 *    each through the EXISTING channel branch, which is the visibility-filtered
 *    subscriber set — so a reaction on a restricted channel reaches a member who
 *    can see it but NEVER a member who cannot (barrier-proven), and the delta
 *    payload (actor `userId`, `emoji`) rides intact for the client to fold.
 *
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
import { REACTION_EMOJI } from "@demli/config";
import { clientEvent, SERVER_EVENT, serverEvent } from "@demli/protocol";
import { createGateway, type Gateway } from "../gateway.js";
import { InMemoryPresenceStore } from "../presence.js";
import { DATABASE_URL, isDbUp, TestClient } from "./harness.js";
import { refuseToSkipIfRequired } from "@demli/db/testing";

const dbUp = await isDbUp();
if (!dbUp) {
  refuseToSkipIfRequired("postgres");
  console.warn("[gateway.enrichment.int.test] DATABASE unreachable — skipping integration tests");
}

// ---------------------------------------------------------------------------
// 1. Reply over WS
// ---------------------------------------------------------------------------
describe.skipIf(!dbUp)("gateway message replies (WS)", () => {
  let client: DbClient;
  let repos: Repositories;
  let gateway: Gateway;
  let port: number;

  let senderId: string;
  let receiverId: string;
  let tokenSender: string;
  let tokenReceiver: string;
  let channelId: string;
  let otherChannelId: string;

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);

    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const sender = await repos.users.create({
      username: `rep_s_${suffix}`,
      displayName: "Reply Sender",
      passwordHash: "not-used",
    });
    const receiver = await repos.users.create({
      username: `rep_r_${suffix}`,
      displayName: "Reply Receiver",
      passwordHash: "not-used",
    });
    senderId = sender.id;
    receiverId = receiver.id;

    tokenSender = generateSessionToken();
    tokenReceiver = generateSessionToken();
    const expiresAt = sessionExpiresAt(new Date(), 1);
    await repos.sessions.create({
      userId: senderId,
      tokenHash: hashSessionToken(tokenSender),
      expiresAt,
    });
    await repos.sessions.create({
      userId: receiverId,
      tokenHash: hashSessionToken(tokenReceiver),
      expiresAt,
    });

    const group = await repos.groups.create({ name: "Reply Crew", ownerId: senderId });
    await repos.groups.addMember(group.id, receiverId, "member");
    const general = await repos.channels.create({ groupId: group.id, kind: "text", name: "general" });
    const other = await repos.channels.create({ groupId: group.id, kind: "text", name: "other" });
    channelId = general.id;
    otherChannelId = other.id;

    gateway = createGateway(
      { repos, presence: new InMemoryPresenceStore(), mutationBus: new InMemoryMutationBus() },
      { port: 0 },
    );
    port = await gateway.ready;
  });

  afterAll(async () => {
    await gateway?.close();
    await client?.close();
  });

  async function connectPair(): Promise<{ a: TestClient; b: TestClient }> {
    const a = await TestClient.connect(port, tokenSender);
    const b = await TestClient.connect(port, tokenReceiver);
    await a.waitFor(SERVER_EVENT.authSucceeded);
    await b.waitFor(SERVER_EVENT.authSucceeded);
    return { a, b };
  }

  it("broadcasts message.created carrying the reply preview to peer and echo", async () => {
    const { a, b } = await connectPair();

    // Seed a target message to quote (persisted directly, as any prior message).
    const target = await repos.messages.create({
      channelId,
      authorId: receiverId,
      content: "the original question",
    });

    const nonce = `rep-send-${Date.now()}`;
    a.send(
      clientEvent.messageSend({
        channelId,
        content: "here is my answer",
        nonce,
        replyToMessageId: target.id,
      }),
    );

    // Peer receives the enriched broadcast.
    const received = await b.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.nonce === nonce);
    expect(received.payload.content).toBe("here is my answer");
    expect(received.payload.replyTo).toBeTruthy();
    expect(received.payload.replyTo?.id).toBe(target.id);
    expect(received.payload.replyTo?.authorId).toBe(receiverId);
    expect(received.payload.replyTo?.content).toBe("the original question");
    expect(received.payload.replyTo?.kind).toBe("user");
    expect(received.payload.replyTo?.deleted).toBe(false);

    // Sender's own echo carries the SAME preview + the reconciliation nonce.
    const echo = await a.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.nonce === nonce);
    expect(echo.payload.nonce).toBe(nonce);
    expect(echo.payload.replyTo?.id).toBe(target.id);

    // Persisted: the reply FK is set on the new row.
    const stored = await repos.messages.findById(received.payload.id);
    expect(stored?.replyToMessageId).toBe(target.id);

    a.close();
    b.close();
  });

  it("renders a deleted stub when replying to a soft-deleted target", async () => {
    const { a, b } = await connectPair();

    const target = await repos.messages.create({
      channelId,
      authorId: receiverId,
      content: "this will be deleted",
    });
    await repos.messages.softDelete(target.id);

    const nonce = `rep-del-${Date.now()}`;
    a.send(
      clientEvent.messageSend({
        channelId,
        content: "replying to a ghost",
        nonce,
        replyToMessageId: target.id,
      }),
    );

    const received = await b.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.nonce === nonce);
    expect(received.payload.replyTo?.id).toBe(target.id);
    expect(received.payload.replyTo?.deleted).toBe(true);
    expect(received.payload.replyTo?.content).toBe("");

    a.close();
    b.close();
  });

  it("refuses a reply to a message in another channel and broadcasts nothing", async () => {
    const { a, b } = await connectPair();

    // Target lives in `otherChannelId`; the reply is sent to `channelId`.
    const foreignTarget = await repos.messages.create({
      channelId: otherChannelId,
      authorId: senderId,
      content: "different channel",
    });

    const nonce = `rep-xchan-${Date.now()}`;
    a.send(
      clientEvent.messageSend({
        channelId,
        content: "cross-channel quote",
        nonce,
        replyToMessageId: foreignTarget.id,
      }),
    );
    const err = await a.waitFor(SERVER_EVENT.errorRaised, (e) => e.payload.nonce === nonce);
    expect(err.payload.code).toBe("INVALID_PAYLOAD");

    // Ordered-socket barrier: a later good message lands on the peer; the refused
    // reply never broadcast to it.
    const barrierNonce = `rep-xchan-barrier-${Date.now()}`;
    a.send(clientEvent.messageSend({ channelId, content: "barrier", nonce: barrierNonce }));
    await b.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.nonce === barrierNonce);
    const leaked = b.envelopes.some(
      (env) => env.event.type === SERVER_EVENT.messageCreated && env.event.payload.nonce === nonce,
    );
    expect(leaked).toBe(false);

    a.close();
    b.close();
  });

  it("refuses a reply to a nonexistent message with a nonce'd INVALID_PAYLOAD", async () => {
    const { a } = await connectPair();

    const nonce = `rep-ghost-${Date.now()}`;
    a.send(
      clientEvent.messageSend({
        channelId,
        content: "quoting nothing",
        nonce,
        replyToMessageId: randomUUID(),
      }),
    );
    const err = await a.waitFor(SERVER_EVENT.errorRaised, (e) => e.payload.nonce === nonce);
    expect(err.payload.code).toBe("INVALID_PAYLOAD");

    // The connection survives; a subsequent normal send still works.
    const okNonce = `rep-after-ghost-${Date.now()}`;
    a.send(clientEvent.messageSend({ channelId, content: "still alive", nonce: okNonce }));
    await a.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.nonce === okNonce);

    a.close();
  });

  it("carries no replyTo on a normal (non-reply) send and preserves its nonce", async () => {
    const { a, b } = await connectPair();

    const nonce = `rep-plain-${Date.now()}`;
    a.send(clientEvent.messageSend({ channelId, content: "just a message", nonce }));

    const received = await b.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.nonce === nonce);
    expect(received.payload.replyTo).toBeUndefined();
    expect(received.payload.nonce).toBe(nonce);

    a.close();
    b.close();
  });

  it("dedupes a retried reply send (same nonce): one row, same id, same preview", async () => {
    const { a } = await connectPair();

    const target = await repos.messages.create({
      channelId,
      authorId: receiverId,
      content: "quote me once",
    });

    const nonce = `rep-retry-${Date.now()}`;
    const content = `idempotent reply ${nonce}`;
    const send = () =>
      a.send(
        clientEvent.messageSend({ channelId, content, nonce, replyToMessageId: target.id }),
      );

    send();
    const first = await a.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.nonce === nonce);
    send(); // retry (lost echo)

    const echoes = () =>
      a.envelopes
        .filter((env) => env.event.type === SERVER_EVENT.messageCreated)
        .map((env) => env.event)
        .filter((ev) => "payload" in ev && (ev.payload as { nonce?: string }).nonce === nonce);
    const deadline = Date.now() + 4000;
    while (echoes().length < 2) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the retry re-broadcast");
      await new Promise((r) => setTimeout(r, 50));
    }

    // Both broadcasts share the canonical id AND the same reply preview.
    for (const ev of echoes()) {
      const payload = ev.payload as { id: string; replyTo?: { id: string } };
      expect(payload.id).toBe(first.payload.id);
      expect(payload.replyTo?.id).toBe(target.id);
    }

    // Exactly one persisted row for this content.
    const page = await repos.messages.listPage({ channelId, limit: 100 });
    expect(page.items.filter((m) => m.content === content)).toHaveLength(1);

    a.close();
  });
});

// ---------------------------------------------------------------------------
// 2. Reaction fan-out through the channel-visibility filter
// ---------------------------------------------------------------------------
describe.skipIf(!dbUp)("gateway reaction fan-out (visibility)", () => {
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
  let expiresAt: Date;

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);

    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const owner = await repos.users.create({
      username: `rx_o_${suffix}`,
      displayName: "React Owner",
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

    const group = await repos.groups.create({ name: "React Crew", ownerId });
    groupId = group.id;
    const publicText = await repos.channels.create({ groupId, kind: "text", name: "public" });
    const restrictedText = await repos.channels.create({ groupId, kind: "text", name: "vip" });
    publicTextId = publicText.id;
    restrictedTextId = restrictedText.id;

    const role = await repos.roles.create({ groupId, name: "VIP" });
    roleId = role.id;
    // Lock the VIP channel to the VIP role (owner still sees it via bypass).
    await repos.channelAccess.setChannelRoles(groupId, restrictedTextId, [roleId]);

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

  /** A brand-new member of the group, optionally holding the VIP role. */
  async function freshMember(roleIds: string[] = []): Promise<{ id: string; token: string }> {
    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const user = await repos.users.create({
      username: `rx_m_${suffix}`,
      displayName: "React Member",
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

  /** Publish a channel-scoped reaction delta, exactly as the API (W3) does. */
  async function fanReactionAdded(
    channelId: string,
    messageId: string,
    emoji: string,
    userId: string,
  ): Promise<void> {
    await mutationBus.publish({
      channelId,
      event: serverEvent.messageReactionAdded({ channelId, messageId, emoji, userId }),
    });
  }

  /** Persist + fan a message.created barrier on the public channel. */
  async function fanPublicMarker(content: string): Promise<void> {
    const message = await repos.messages.create({ channelId: publicTextId, authorId: ownerId, content });
    await mutationBus.publish({ channelId: publicTextId, event: serverEvent.messageCreated(message) });
  }

  it("delivers a reaction on a visible channel to every subscriber", async () => {
    const member = await freshMember(); // public channel is visible to all members
    const m = await TestClient.connect(port, member.token);
    const owner = await TestClient.connect(port, tokenOwner);
    await m.waitFor(SERVER_EVENT.authSucceeded);
    await owner.waitFor(SERVER_EVENT.authSucceeded);

    const target = await repos.messages.create({
      channelId: publicTextId,
      authorId: ownerId,
      content: `react-visible-${Date.now()}`,
    });
    const emoji = REACTION_EMOJI[0];
    await fanReactionAdded(publicTextId, target.id, emoji, ownerId);

    for (const c of [m, owner]) {
      const got = await c.waitFor(
        SERVER_EVENT.messageReactionAdded,
        (e) => e.payload.messageId === target.id,
      );
      expect(got.payload.channelId).toBe(publicTextId);
      expect(got.payload.emoji).toBe(emoji);
      // The delta carries the ACTOR's userId; each recipient derives reactedByMe
      // locally (userId === me) — it is receiver-relative and never on the wire
      // (ADR 0011 §3). Asserted on the raw frames, the authoritative wire form.
      expect(got.payload.userId).toBe(ownerId);
    }
    for (const frame of [...m.rawFrames, ...owner.rawFrames]) {
      expect(frame).not.toContain("reactedByMe");
    }

    m.close();
    owner.close();
  });

  it("never delivers a reaction on a restricted channel to a member who cannot see it", async () => {
    const member = await freshMember(); // no VIP role — cannot see the restricted channel
    const m = await TestClient.connect(port, member.token);
    const owner = await TestClient.connect(port, tokenOwner);
    await m.waitFor(SERVER_EVENT.authSucceeded);
    await owner.waitFor(SERVER_EVENT.authSucceeded);

    // A message + reaction on the VIP channel. The owner sees it (bypass); the
    // role-less member is not even subscribed to the channel.
    const target = await repos.messages.create({
      channelId: restrictedTextId,
      authorId: ownerId,
      content: `react-secret-${Date.now()}`,
    });
    const emoji = REACTION_EMOJI[1];
    await fanReactionAdded(restrictedTextId, target.id, emoji, ownerId);

    // Owner receives the reaction on the restricted channel.
    const gotOwner = await owner.waitFor(
      SERVER_EVENT.messageReactionAdded,
      (e) => e.payload.messageId === target.id,
    );
    expect(gotOwner.payload.emoji).toBe(emoji);

    // Barrier: a PUBLIC-channel marker the member DOES receive proves its socket
    // had the chance — the restricted reaction (same ordered socket) would have
    // landed first had the filter let it through. It never did.
    const marker = `rx-barrier-${Date.now()}`;
    await fanPublicMarker(marker);
    await m.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.content === marker);
    const leaked = m.envelopes.some(
      (env) =>
        env.event.type === SERVER_EVENT.messageReactionAdded &&
        env.event.payload.messageId === target.id,
    );
    expect(leaked).toBe(false);

    m.close();
    owner.close();
  });

  it("delivers reaction_removed to a member once they gain the role (grant → subscribed)", async () => {
    const member = await freshMember([roleId]); // starts WITH the VIP role
    const m = await TestClient.connect(port, member.token);
    const owner = await TestClient.connect(port, tokenOwner);
    await m.waitFor(SERVER_EVENT.authSucceeded);
    await owner.waitFor(SERVER_EVENT.authSucceeded);

    const target = await repos.messages.create({
      channelId: restrictedTextId,
      authorId: ownerId,
      content: `react-remove-${Date.now()}`,
    });
    const emoji = REACTION_EMOJI[2];
    await mutationBus.publish({
      channelId: restrictedTextId,
      event: serverEvent.messageReactionRemoved({
        channelId: restrictedTextId,
        messageId: target.id,
        emoji,
        userId: ownerId,
      }),
    });

    // The VIP member (subscribed to the restricted channel) receives the removal.
    const got = await m.waitFor(
      SERVER_EVENT.messageReactionRemoved,
      (e) => e.payload.messageId === target.id,
    );
    expect(got.payload.emoji).toBe(emoji);
    expect(got.payload.userId).toBe(ownerId);

    m.close();
    owner.close();
  });
});
