/**
 * WS `message.send` × attachments (M10-6, ADR 0008 wave #4) — real Postgres +
 * real WebSockets. Proves the gateway:
 * - links `attachmentIds` to the new message and broadcasts `message.created`
 *   enriched with attachment METADATA to every subscriber (never `storagePath`,
 *   never signed URLs — asserted on the RAW frames, since zod parsing would
 *   strip a leaked key silently);
 * - accepts a caption-less send (empty content + attachments);
 * - rejects neither-text-nor-attachments with a typed, nonce'd error;
 * - refuses foreign-uploader, unknown (nonexistent), and not-ready ids with the
 *   REST-consistent messages — foreign and unknown share one message so probing
 *   ids leaks no existence (and never broadcasts the orphaned message);
 * - stays idempotent for a retried send (same nonce): one row, one canonical
 *   id, the same full attachment set on every re-broadcast.
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
  type AttachmentRecord,
  type DbClient,
  type Repositories,
} from "@demli/db";
import { clientEvent, SERVER_EVENT, type ServerEventOf } from "@demli/protocol";
import { createGateway, type Gateway } from "../gateway.js";
import { InMemoryPresenceStore } from "../presence.js";
import { DATABASE_URL, isDbUp, TestClient } from "./harness.js";
import { refuseToSkipIfRequired } from "@demli/db/testing";

const dbUp = await isDbUp();
if (!dbUp) {
  refuseToSkipIfRequired("postgres");
  console.warn(
    "[gateway.attachments.int.test] DATABASE unreachable — skipping integration tests",
  );
}

describe.skipIf(!dbUp)("gateway message attachments", () => {
  let client: DbClient;
  let repos: Repositories;
  let gateway: Gateway;
  let port: number;

  let senderId: string;
  let receiverId: string;
  let tokenSender: string;
  let tokenReceiver: string;
  let textChannelId: string;

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);

    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const sender = await repos.users.create({
      username: `att_s_${suffix}`,
      displayName: "Attach Sender",
      passwordHash: "not-used",
    });
    const receiver = await repos.users.create({
      username: `att_r_${suffix}`,
      displayName: "Attach Receiver",
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

    const group = await repos.groups.create({ name: "Attachment Crew", ownerId: senderId });
    await repos.groups.addMember(group.id, receiverId, "member");
    const text = await repos.channels.create({
      groupId: group.id,
      kind: "text",
      name: "att-general",
    });
    textChannelId = text.id;

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

  /** A READY, unlinked attachment owned by `uploaderId` (pending → ready). */
  async function readyAttachment(uploaderId: string): Promise<AttachmentRecord> {
    const pending = await repos.attachments.createPending({
      channelId: textChannelId,
      uploaderId,
      kind: "image",
      mime: "image/png",
      sizeBytes: 1234,
      storagePath: `${textChannelId}/${randomUUID()}.png`,
    });
    const ready = await repos.attachments.markReady(pending.id, {
      uploaderId,
      width: 640,
      height: 480,
    });
    if (!ready) throw new Error("markReady returned null in fixture");
    return ready;
  }

  /** Both clients connected + authenticated. */
  async function connectPair(): Promise<{ a: TestClient; b: TestClient }> {
    const a = await TestClient.connect(port, tokenSender);
    const b = await TestClient.connect(port, tokenReceiver);
    await a.waitFor(SERVER_EVENT.authSucceeded);
    await b.waitFor(SERVER_EVENT.authSucceeded);
    return { a, b };
  }

  it("links attachments and broadcasts message.created with metadata to both clients", async () => {
    const { a, b } = await connectPair();
    const att1 = await readyAttachment(senderId);
    const att2 = await readyAttachment(senderId);

    const nonce = `att-send-${Date.now()}`;
    const content = `look at these ${nonce}`;
    a.send(
      clientEvent.messageSend({
        channelId: textChannelId,
        content,
        nonce,
        attachmentIds: [att1.id, att2.id],
      }),
    );

    // The OTHER client receives the enriched broadcast...
    const received = await b.waitFor(
      SERVER_EVENT.messageCreated,
      (e) => e.payload.nonce === nonce,
    );
    expect(received.payload.authorId).toBe(senderId);
    expect(received.payload.content).toBe(content);
    const attachments = received.payload.attachments ?? [];
    expect(attachments.map((x) => x.id).sort()).toEqual([att1.id, att2.id].sort());
    for (const dto of attachments) {
      expect(dto.messageId).toBe(received.payload.id);
      expect(dto.channelId).toBe(textChannelId);
      expect(dto.uploaderId).toBe(senderId);
      expect(dto.kind).toBe("image");
      expect(dto.mime).toBe("image/png");
      expect(dto.sizeBytes).toBe(1234);
      expect(dto.width).toBe(640);
      expect(dto.height).toBe(480);
    }

    // ...and the sender's echo carries the same enrichment.
    const echo = await a.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.nonce === nonce);
    expect((echo.payload.attachments ?? []).map((x) => x.id).sort()).toEqual(
      [att1.id, att2.id].sort(),
    );

    // The server-only object key NEVER goes over the wire (ADR 0008 §2) — checked
    // on the raw frames, because the envelope schema would strip a leaked key.
    for (const frame of [...a.rawFrames, ...b.rawFrames]) {
      expect(frame).not.toContain("storagePath");
      expect(frame).not.toContain(att1.storagePath);
      expect(frame).not.toContain(att2.storagePath);
    }

    // Persisted: both rows now linked to the message.
    const linked = await repos.attachments.listForMessage(received.payload.id);
    expect(linked.map((r) => r.id).sort()).toEqual([att1.id, att2.id].sort());

    a.close();
    b.close();
  });

  it("accepts a caption-less send (empty content, attachments only)", async () => {
    const { a, b } = await connectPair();
    const att = await readyAttachment(senderId);

    const nonce = `att-nocap-${Date.now()}`;
    a.send(
      clientEvent.messageSend({
        channelId: textChannelId,
        content: "",
        nonce,
        attachmentIds: [att.id],
      }),
    );

    const received = await b.waitFor(
      SERVER_EVENT.messageCreated,
      (e) => e.payload.nonce === nonce,
    );
    expect(received.payload.content).toBe("");
    expect(received.payload.attachments?.map((x) => x.id)).toEqual([att.id]);

    a.close();
    b.close();
  });

  it("rejects a send with neither text nor attachments (typed, nonce'd error)", async () => {
    const { a, b } = await connectPair();

    const nonce = `att-empty-${Date.now()}`;
    a.sendRaw(
      JSON.stringify(
        clientEvent.messageSend({
          channelId: textChannelId,
          content: "   ",
          nonce,
          attachmentIds: [],
        }),
      ),
    );
    const err = await a.waitFor(SERVER_EVENT.errorRaised, (e) => e.payload.nonce === nonce);
    expect(err.payload.code).toBe("INVALID_PAYLOAD");

    // The connection survives and a subsequent valid send still works.
    const okNonce = `att-after-empty-${Date.now()}`;
    a.send(
      clientEvent.messageSend({ channelId: textChannelId, content: "still alive", nonce: okNonce }),
    );
    await b.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.nonce === okNonce);

    a.close();
    b.close();
  });

  it("refuses a foreign uploader's attachment id and broadcasts nothing", async () => {
    const { a, b } = await connectPair();
    const foreign = await readyAttachment(receiverId); // owned by B, sent by A

    const nonce = `att-foreign-${Date.now()}`;
    a.send(
      clientEvent.messageSend({
        channelId: textChannelId,
        content: "not mine",
        nonce,
        attachmentIds: [foreign.id],
      }),
    );
    const err = await a.waitFor(SERVER_EVENT.errorRaised, (e) => e.payload.nonce === nonce);
    expect(err.payload.code).toBe("INVALID_PAYLOAD");
    // Same message as the REST 400 — and identical to the unknown-id case, so
    // probing someone else's ids confirms nothing (no existence oracle).
    expect(err.payload.message).toBe("One or more attachments are invalid.");

    // Ordered-socket barrier: a later good message arrives, the refused one never did.
    const barrierNonce = `att-foreign-barrier-${Date.now()}`;
    a.send(
      clientEvent.messageSend({ channelId: textChannelId, content: "barrier", nonce: barrierNonce }),
    );
    await b.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.nonce === barrierNonce);
    const leaked = b.envelopes.some(
      (env) =>
        env.event.type === SERVER_EVENT.messageCreated && env.event.payload.nonce === nonce,
    );
    expect(leaked).toBe(false);
    // The foreign row is untouched (still unlinked, still B's).
    const untouched = await repos.attachments.findById(foreign.id);
    expect(untouched?.messageId).toBeNull();

    a.close();
    b.close();
  });

  it("refuses an unknown (nonexistent) attachment id with the same INVALID_PAYLOAD (no existence oracle)", async () => {
    const { a, b } = await connectPair();

    // A completely nonexistent id (never uploaded) → the `not_found` link
    // branch. It must answer with the EXACT code + message of the foreign-id
    // case above, so probing random/other ids reveals nothing about what
    // exists or who owns it (ADR 0008 §2; mirrors attachments.ts).
    const nonce = `att-unknown-${Date.now()}`;
    a.send(
      clientEvent.messageSend({
        channelId: textChannelId,
        content: "ghost",
        nonce,
        attachmentIds: [randomUUID()],
      }),
    );
    const err = await a.waitFor(SERVER_EVENT.errorRaised, (e) => e.payload.nonce === nonce);
    expect(err.payload.code).toBe("INVALID_PAYLOAD");
    expect(err.payload.message).toBe("One or more attachments are invalid.");

    // Ordered-socket barrier: a later good message lands, the refused one never
    // broadcast to the peer.
    const barrierNonce = `att-unknown-barrier-${Date.now()}`;
    a.send(
      clientEvent.messageSend({ channelId: textChannelId, content: "barrier", nonce: barrierNonce }),
    );
    await b.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.nonce === barrierNonce);
    const leaked = b.envelopes.some(
      (env) =>
        env.event.type === SERVER_EVENT.messageCreated && env.event.payload.nonce === nonce,
    );
    expect(leaked).toBe(false);

    a.close();
    b.close();
  });

  it("refuses a not-ready (pending) attachment id", async () => {
    const { a, b } = await connectPair();
    const pending = await repos.attachments.createPending({
      channelId: textChannelId,
      uploaderId: senderId,
      kind: "image",
      mime: "image/png",
      sizeBytes: 999,
      storagePath: `${textChannelId}/${randomUUID()}.png`,
    });

    const nonce = `att-pending-${Date.now()}`;
    a.send(
      clientEvent.messageSend({
        channelId: textChannelId,
        content: "too early",
        nonce,
        attachmentIds: [pending.id],
      }),
    );
    const err = await a.waitFor(SERVER_EVENT.errorRaised, (e) => e.payload.nonce === nonce);
    expect(err.payload.code).toBe("INVALID_PAYLOAD");
    expect(err.payload.message).toBe("An attachment is not ready to send yet.");

    a.close();
    b.close();
  });

  it("dedupes a retried attachment send (same nonce): one row, same id, same attachment set", async () => {
    const { a, b } = await connectPair();
    const att1 = await readyAttachment(senderId);
    const att2 = await readyAttachment(senderId);

    const nonce = `att-retry-${Date.now()}`;
    const content = `retry with files ${nonce}`;
    const send = () =>
      a.send(
        clientEvent.messageSend({
          channelId: textChannelId,
          content,
          nonce,
          attachmentIds: [att1.id, att2.id],
        }),
      );

    send();
    const first = await a.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.nonce === nonce);
    // Retry the SAME send (simulating a lost first echo).
    send();

    // Wait until the retry's re-broadcast lands (no fixed sleep — poll the log).
    const echoesOf = (target: TestClient) =>
      target.envelopes
        .map((env) => env.event)
        .filter(
          (ev): ev is ServerEventOf<"message.created"> =>
            ev.type === SERVER_EVENT.messageCreated,
        )
        .filter((ev) => ev.payload.nonce === nonce);
    const deadline = Date.now() + 4000;
    while (echoesOf(a).length < 2) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the retry re-broadcast");
      await new Promise((r) => setTimeout(r, 50));
    }

    // Every broadcast (sender echoes AND receiver copies) carries the SAME
    // canonical id and the SAME full attachment set — never duplicated, never
    // dropped on the deduped retry.
    for (const ev of [...echoesOf(a), ...echoesOf(b)]) {
      expect(ev.payload.id).toBe(first.payload.id);
      expect((ev.payload.attachments ?? []).map((x) => x.id).sort()).toEqual(
        [att1.id, att2.id].sort(),
      );
    }

    // Exactly one persisted row; exactly the two attachments, linked once.
    const page = await repos.messages.listPage({ channelId: textChannelId, limit: 100 });
    expect(page.items.filter((m) => m.content === content)).toHaveLength(1);
    const linked = await repos.attachments.listForMessage(first.payload.id);
    expect(linked.map((r) => r.id).sort()).toEqual([att1.id, att2.id].sort());

    a.close();
    b.close();
  });
});
