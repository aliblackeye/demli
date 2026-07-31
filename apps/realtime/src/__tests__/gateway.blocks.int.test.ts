/**
 * M18 blocking at the GATEWAY (ADR 0017) — real Postgres + real WebSockets.
 * Auto-skipped (with a notice) when the database is unreachable.
 *
 * The HTTP suite (`apps/api/.../blocks.int.test.ts`) proves the REST surfaces.
 * This proves the REALTIME half, which is the part a client-side hide could
 * never give us:
 *
 *  1. a blocked user's LIVE `message.created` never reaches the blocker's socket
 *     (filtered server-side — the text is not sent, not sent-and-hidden), while
 *     everyone else in the channel still receives it;
 *  2. the same for the typing indicator;
 *  3. a WS DM send across a block is refused with a nonce'd `BLOCKED` error, so
 *     switching transport cannot bypass the REST gate;
 *  4. `user.blocks_updated` RESYNCS a live connection with no reconnect — the
 *     filter starts and stops applying mid-session (the M9-4 resync pattern).
 */

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
import { clientEvent, serverEvent, SERVER_EVENT } from "@demli/protocol";
import type { User } from "@demli/types";
import { createGateway, type Gateway } from "../gateway.js";
import { InMemoryPresenceStore } from "../presence.js";
import { DATABASE_URL, isDbUp, TestClient } from "./harness.js";
import { refuseToSkipIfRequired } from "@demli/db/testing";

interface Actor {
  id: string;
  token: string;
  user: User;
}

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

/** Give the gateway a beat to deliver (or deliberately NOT deliver) a frame. */
async function settle(ms = 400): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const dbUp = await isDbUp();
if (!dbUp) {
  refuseToSkipIfRequired("postgres");
  console.warn("[gateway.blocks.int.test] DATABASE unreachable — skipping integration tests");
}

describe.skipIf(!dbUp)("gateway blocking — live fan-out filter + WS send gate", () => {
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

  it("never delivers a blocked author's live message to the blocker — but does to everyone else", async () => {
    const owner = await makeActor(repos, "blkO");
    const blocker = await makeActor(repos, "blkB");
    const noisy = await makeActor(repos, "blkN");
    const group = await repos.groups.create({ name: "Block Crew", ownerId: owner.id });
    await repos.groups.addMember(group.id, blocker.id, "member");
    await repos.groups.addMember(group.id, noisy.id, "member");
    const channel = await repos.channels.create({
      groupId: group.id,
      kind: "text",
      name: "general",
    });

    await repos.userBlocks.block(blocker.id, noisy.id);

    // Both connect AFTER the block, so the set is seeded at handshake.
    const blockerSock = await TestClient.connect(port, blocker.token);
    const ownerSock = await TestClient.connect(port, owner.token);
    const noisySock = await TestClient.connect(port, noisy.token);
    await blockerSock.waitFor(SERVER_EVENT.authSucceeded);
    await ownerSock.waitFor(SERVER_EVENT.authSucceeded);
    await noisySock.waitFor(SERVER_EVENT.authSucceeded);

    const content = "message from a blocked user";
    noisySock.send(
      clientEvent.messageSend({ channelId: channel.id, content, nonce: `blk-${Date.now()}` }),
    );

    // The uninvolved owner receives it normally — a block is per-viewer.
    await ownerSock.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.content === content);
    await settle();

    // The blocker's socket never saw the text AT ALL — not even in a raw frame,
    // which is the whole point of filtering server-side rather than client-side.
    expect(
      blockerSock.envelopes.some(
        (e) => e.event.type === SERVER_EVENT.messageCreated && e.event.payload.content === content,
      ),
    ).toBe(false);
    expect(blockerSock.rawFrames.some((f) => f.includes(content))).toBe(false);

    blockerSock.close();
    ownerSock.close();
    noisySock.close();
  });

  it("filters the typing indicator of a blocked user too", async () => {
    const owner = await makeActor(repos, "typO");
    const blocker = await makeActor(repos, "typB");
    const noisy = await makeActor(repos, "typN");
    const group = await repos.groups.create({ name: "Typing Crew", ownerId: owner.id });
    await repos.groups.addMember(group.id, blocker.id, "member");
    await repos.groups.addMember(group.id, noisy.id, "member");
    const channel = await repos.channels.create({
      groupId: group.id,
      kind: "text",
      name: "general",
    });
    await repos.userBlocks.block(blocker.id, noisy.id);

    const blockerSock = await TestClient.connect(port, blocker.token);
    const ownerSock = await TestClient.connect(port, owner.token);
    const noisySock = await TestClient.connect(port, noisy.token);
    await blockerSock.waitFor(SERVER_EVENT.authSucceeded);
    await ownerSock.waitFor(SERVER_EVENT.authSucceeded);
    await noisySock.waitFor(SERVER_EVENT.authSucceeded);

    noisySock.send(clientEvent.typingStart({ channelId: channel.id, userId: noisy.id }));
    await ownerSock.waitFor(
      SERVER_EVENT.typingStarted,
      (e) => e.payload.userId === noisy.id,
    );
    await settle();
    expect(
      blockerSock.envelopes.some(
        (e) => e.event.type === SERVER_EVENT.typingStarted && e.event.payload.userId === noisy.id,
      ),
    ).toBe(false);

    blockerSock.close();
    ownerSock.close();
    noisySock.close();
  });

  it("refuses a WS DM send across a block with a nonce'd BLOCKED error", async () => {
    const a = await makeActor(repos, "wdmA");
    const b = await makeActor(repos, "wdmB");
    const { dm } = await repos.dms.getOrCreate(a.id, b.id);
    await repos.userBlocks.block(b.id, a.id);

    const aSock = await TestClient.connect(port, a.token);
    await aSock.waitFor(SERVER_EVENT.authSucceeded);

    const nonce = `wsblk-${Date.now()}`;
    aSock.send(
      clientEvent.messageSend({ channelId: dm.streamId, content: "let me in", nonce }),
    );

    const err = await aSock.waitFor(
      SERVER_EVENT.errorRaised,
      (e) => e.payload.nonce === nonce,
    );
    // The transport cannot be used to route around the REST gate.
    expect(err.payload.code).toBe("BLOCKED");

    // Nothing was persisted.
    const page = await repos.messages.listPage({ channelId: dm.streamId });
    expect(page.items.some((m) => m.content === "let me in")).toBe(false);

    aSock.close();
  });

  it("resyncs a LIVE connection on user.blocks_updated — no reconnect needed", async () => {
    const owner = await makeActor(repos, "rsyO");
    const blocker = await makeActor(repos, "rsyB");
    const noisy = await makeActor(repos, "rsyN");
    const group = await repos.groups.create({ name: "Resync Crew", ownerId: owner.id });
    await repos.groups.addMember(group.id, blocker.id, "member");
    await repos.groups.addMember(group.id, noisy.id, "member");
    const channel = await repos.channels.create({
      groupId: group.id,
      kind: "text",
      name: "general",
    });

    // Connect with NO block in place — the handshake seeds an empty set.
    const blockerSock = await TestClient.connect(port, blocker.token);
    const noisySock = await TestClient.connect(port, noisy.token);
    await blockerSock.waitFor(SERVER_EVENT.authSucceeded);
    await noisySock.waitFor(SERVER_EVENT.authSucceeded);

    const before = "visible before the block";
    noisySock.send(
      clientEvent.messageSend({ channelId: channel.id, content: before, nonce: `pre-${Date.now()}` }),
    );
    await blockerSock.waitFor(
      SERVER_EVENT.messageCreated,
      (e) => e.payload.content === before,
    );

    // Block mid-session, exactly as the API does: write the row, then publish the
    // user-scoped resync signal. The gateway RE-DERIVES the set from the DB.
    await repos.userBlocks.block(blocker.id, noisy.id);
    await mutationBus.publish({
      userId: blocker.id,
      event: serverEvent.blocksUpdated({ userId: noisy.id, blocked: true }),
    });
    await blockerSock.waitFor(SERVER_EVENT.blocksUpdated);

    const after = "hidden after the block";
    noisySock.send(
      clientEvent.messageSend({ channelId: channel.id, content: after, nonce: `post-${Date.now()}` }),
    );
    // The sender still gets their own echo, so this is a real barrier.
    await noisySock.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.content === after);
    await settle();
    expect(blockerSock.rawFrames.some((f) => f.includes(after))).toBe(false);

    // …and UNBLOCKING resyncs the other way, again with no reconnect.
    await repos.userBlocks.unblock(blocker.id, noisy.id);
    await mutationBus.publish({
      userId: blocker.id,
      event: serverEvent.blocksUpdated({ userId: noisy.id, blocked: false }),
    });
    await blockerSock.waitFor(
      SERVER_EVENT.blocksUpdated,
      (e) => e.payload.blocked === false,
    );

    const restored = "visible again after unblock";
    noisySock.send(
      clientEvent.messageSend({
        channelId: channel.id,
        content: restored,
        nonce: `re-${Date.now()}`,
      }),
    );
    await blockerSock.waitFor(
      SERVER_EVENT.messageCreated,
      (e) => e.payload.content === restored,
    );

    blockerSock.close();
    noisySock.close();
  });
});
