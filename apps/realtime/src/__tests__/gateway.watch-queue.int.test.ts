/**
 * Watch-party QUEUE at the gateway (M20 wave 2, ADR 0016) — real Postgres, real
 * WebSockets. Auto-skipped (with a notice) when the database is unreachable.
 *
 * The playback suite next door proves the authority chain for the PLAYHEAD. This
 * one proves the three things a queue adds on top, each of which is a way a
 * shared list can go wrong in a way a shared playhead cannot:
 *
 *  - somebody who may not touch it, touching it;
 *  - two people rearranging it at once and leaving it corrupt (duplicated,
 *    missing, or holding a row the server never had);
 *  - the automatic advance running twice on one ENDED and eating an extra video.
 *
 * Covered:
 *  1. an occupant who is neither host nor owner cannot add, remove, reorder or
 *     play — and the SERVER OWNER can do all four;
 *  2. reordering is reconciled against server truth, so two concurrent reorders
 *     always leave a valid permutation and never a corrupted list;
 *  3. the queue cap is enforced and refused honestly (`WATCH_QUEUE_FULL`);
 *  4. a videoRef that is not a YouTube video never enters the queue;
 *  5. a client that joins the room is handed the queue, and a reconnecting one
 *     gets it again on rejoin;
 *  6. `watch.ended` advances to the next item — ONCE, however many times it is
 *     reported — and freezes (rather than ending the party) when nothing is left;
 *  7. stopping the session clears the queue with it;
 *  8. the queue does NOT ride the drift heartbeat (§27).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WATCH_QUEUE_MAX_ITEMS } from "@demli/config";
import {
  applyMigrations,
  createDb,
  createRepositories,
  generateSessionToken,
  hashSessionToken,
  InMemoryMutationBus,
  InMemoryWatchPartyStore,
  sessionExpiresAt,
  type DbClient,
  type Repositories,
} from "@demli/db";
import { clientEvent, SERVER_EVENT, type WatchQueueItem } from "@demli/protocol";
import { createGateway, type Gateway } from "../gateway.js";
import { InMemoryPresenceStore } from "../presence.js";
import { DATABASE_URL, isDbUp, TestClient } from "./harness.js";
import { refuseToSkipIfRequired } from "@demli/db/testing";

const VIDEO = "dQw4w9WgXcQ";
const VIDEO_2 = "9bZkp7q19f0";
const VIDEO_3 = "kJQP7kiw5Fk";
const VIDEO_4 = "JGwWNGJdvx8";

interface Actor {
  id: string;
  token: string;
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
  return { id: user.id, token };
}

/** Deterministic uuids for queue item ids (the wire requires uuid shape). */
function itemId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/**
 * Wait a fixed moment. ONLY for asserting that something does NOT happen.
 *
 * For "X did happen", use `waitFor` with a predicate instead: a stopwatch there
 * is a bet on scheduling that pays out on an idle machine and loses under a full
 * suite, and it fails looking like a product bug rather than a slow frame. One
 * such wait in this file did exactly that.
 */
async function settle(ms = 400): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const dbUp = await isDbUp();
if (!dbUp) {
  refuseToSkipIfRequired("postgres");
  console.warn("[gateway.watch-queue.int.test] DATABASE unreachable — skipping integration tests");
}

describe.skipIf(!dbUp)("gateway watch party queue", () => {
  let client: DbClient;
  let repos: Repositories;
  let gateway: Gateway;
  let port: number;
  /**
   * The gateway's own session store, held so the CAP test can seed a full queue
   * directly. Driving it to 50 over the socket would take ~13 s of waiting on the
   * watch bucket's 4/s refill and would be testing the rate limiter, not the cap.
   */
  const watchStore = new InMemoryWatchPartyStore();

  async function makeRoom(
    label: string,
    memberCount: number,
  ): Promise<{
    groupId: string;
    channelId: string;
    actors: Actor[];
    sockets: TestClient[];
  }> {
    const actors: Actor[] = [];
    for (let i = 0; i < memberCount; i++) {
      actors.push(await makeActor(repos, `${label}${i}`));
    }
    const owner = actors[0]!;
    const group = await repos.groups.create({ name: `Queue ${label}`, ownerId: owner.id });
    for (const member of actors.slice(1)) {
      await repos.groups.addMember(group.id, member.id, "member");
    }
    const channel = await repos.channels.create({
      groupId: group.id,
      kind: "voice",
      name: "cinema",
    });

    const sockets: TestClient[] = [];
    for (const actor of actors) {
      const socket = await TestClient.connect(port, actor.token);
      await socket.waitFor(SERVER_EVENT.authSucceeded);
      sockets.push(socket);
    }
    return { groupId: group.id, channelId: channel.id, actors, sockets };
  }

  async function joinVoice(
    socket: TestClient,
    channelId: string,
    userId: string,
  ): Promise<void> {
    socket.send(clientEvent.voiceJoin({ channelId }));
    await socket.waitFor(
      SERVER_EVENT.voiceParticipantJoined,
      (e) => e.payload.channelId === channelId && e.payload.userId === userId,
    );
  }

  /** The most recent queue this socket was told about. */
  function lastQueue(socket: TestClient): WatchQueueItem[] | null {
    for (let i = socket.envelopes.length - 1; i >= 0; i--) {
      const event = socket.envelopes[i]!.event;
      if (event.type === SERVER_EVENT.watchQueueUpdated) return event.payload.queue;
    }
    return null;
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
        watchParty: watchStore,
      },
      // The drift heartbeat is parked far out of the way so every frame an
      // assertion counts is one a deliberate action produced.
      { port: 0, watchHeartbeatIntervalMs: 60_000 },
    );
    port = await gateway.ready;
  });

  afterAll(async () => {
    await gateway?.close();
    await client?.close();
  });

  it("refuses every queue mutation from an occupant who is not the host", async () => {
    const { channelId, actors, sockets } = await makeRoom("auth", 3);
    const [ownerSock, hostSock, otherSock] = sockets as [TestClient, TestClient, TestClient];
    await joinVoice(ownerSock, channelId, actors[0]!.id);
    await joinVoice(hostSock, channelId, actors[1]!.id);
    await joinVoice(otherSock, channelId, actors[2]!.id);

    // The plain member starts it, so THEY are the host and the owner is not.
    hostSock.send(clientEvent.watchStart({ channelId, source: "youtube", videoRef: VIDEO }));
    await otherSock.waitFor(SERVER_EVENT.watchStarted);
    hostSock.send(
      clientEvent.watchQueueAdd({ channelId, itemId: itemId(1), videoRef: VIDEO_2 }),
    );
    await otherSock.waitFor(SERVER_EVENT.watchQueueUpdated);

    // A third occupant: in the room, but neither host nor owner. All four
    // mutations refuse with the SAME code the playback controls use — the queue
    // did not invent a gate of its own.
    const attempts = [
      clientEvent.watchQueueAdd({ channelId, itemId: itemId(99), videoRef: VIDEO_3 }),
      clientEvent.watchQueueRemove({ channelId, itemId: itemId(1) }),
      clientEvent.watchQueueReorder({ channelId, itemIds: [itemId(1)] }),
      clientEvent.watchQueuePlay({ channelId, itemId: itemId(1) }),
    ];
    for (const attempt of attempts) {
      otherSock.envelopes.length = 0;
      otherSock.send(attempt);
      const denied = await otherSock.waitFor(SERVER_EVENT.errorRaised, () => true, 4000);
      expect(denied.payload.code, attempt.type).toBe("NOT_HOST");
    }

    await settle();
    // Nothing they tried changed anything.
    expect(lastQueue(hostSock)?.map((item) => item.itemId)).toEqual([itemId(1)]);

    // The SERVER OWNER, who is also not the host, can do all of it — a room is
    // never held hostage by the person who happened to press start.
    ownerSock.envelopes.length = 0;
    ownerSock.send(
      clientEvent.watchQueueAdd({ channelId, itemId: itemId(2), videoRef: VIDEO_3 }),
    );
    const asOwner = await ownerSock.waitFor(SERVER_EVENT.watchQueueUpdated);
    expect(asOwner.payload.queue.map((item) => item.videoId)).toEqual([VIDEO_2, VIDEO_3]);

    for (const socket of sockets) socket.close();
  });

  it("stamps the adder and the time on the server, not from the payload", async () => {
    const { channelId, actors, sockets } = await makeRoom("stamp", 2);
    const [hostSock, peerSock] = sockets as [TestClient, TestClient];
    await joinVoice(hostSock, channelId, actors[0]!.id);
    await joinVoice(peerSock, channelId, actors[1]!.id);

    hostSock.send(clientEvent.watchStart({ channelId, source: "youtube", videoRef: VIDEO }));
    await peerSock.waitFor(SERVER_EVENT.watchStarted);

    hostSock.send(
      clientEvent.watchQueueAdd({
        channelId,
        itemId: itemId(1),
        // A LINK, not a bare id — what gets stored must be the normalized id.
        videoRef: `https://www.youtube.com/watch?v=${VIDEO_2}&t=90`,
        title: "A perfectly ordinary title",
        durationSeconds: 212,
      }),
    );
    const updated = await peerSock.waitFor(SERVER_EVENT.watchQueueUpdated);
    const [item] = updated.payload.queue;
    expect(item?.videoId).toBe(VIDEO_2);
    expect(item?.addedBy).toBe(actors[0]!.id);
    expect(Number.isFinite(Date.parse(item?.addedAt ?? ""))).toBe(true);
    expect(item?.title).toBe("A perfectly ordinary title");
    expect(item?.durationSeconds).toBe(212);
    // The raw link never reaches another client.
    expect(peerSock.rawFrames.some((frame) => frame.includes("youtube.com/watch"))).toBe(false);

    // Re-sending the same itemId is idempotent — a retry across a reconnect must
    // not double the row.
    peerSock.envelopes.length = 0;
    hostSock.send(
      clientEvent.watchQueueAdd({ channelId, itemId: itemId(1), videoRef: VIDEO_3 }),
    );
    await settle();
    expect(
      peerSock.envelopes.some((e) => e.event.type === SERVER_EVENT.watchQueueUpdated),
    ).toBe(false);

    for (const socket of sockets) socket.close();
  });

  it("sanitizes an adder-supplied title instead of trusting it", async () => {
    const { channelId, actors, sockets } = await makeRoom("title", 2);
    const [hostSock, peerSock] = sockets as [TestClient, TestClient];
    await joinVoice(hostSock, channelId, actors[0]!.id);
    await joinVoice(peerSock, channelId, actors[1]!.id);

    hostSock.send(clientEvent.watchStart({ channelId, source: "youtube", videoRef: VIDEO }));
    await peerSock.waitFor(SERVER_EVENT.watchStarted);

    // The title is another member's text on everyone's screen. Newlines would let
    // one row look like several; the bidi override would let it read backwards.
    hostSock.send(
      clientEvent.watchQueueAdd({
        channelId,
        itemId: itemId(1),
        videoRef: VIDEO_2,
        title: "line one\nline two\u202Ereversed\u202C",
      }),
    );
    const updated = await peerSock.waitFor(SERVER_EVENT.watchQueueUpdated);
    const title = updated.payload.queue[0]?.title ?? "";
    expect(title).not.toContain("\n");
    expect(title).not.toContain("\u202E");
    expect(title).toContain("line one");

    // A title that is nothing but whitespace is no title at all.
    hostSock.send(
      clientEvent.watchQueueAdd({
        channelId,
        itemId: itemId(2),
        videoRef: VIDEO_3,
        title: "   \n  ",
      }),
    );
    const second = await peerSock.waitFor(
      SERVER_EVENT.watchQueueUpdated,
      (e) => e.payload.queue.length === 2,
    );
    expect(second.payload.queue[1]?.title).toBeNull();

    for (const socket of sockets) socket.close();
  });

  it("keeps the queue a valid permutation under two concurrent reorders", async () => {
    const { channelId, actors, sockets } = await makeRoom("race", 2);
    const [ownerSock, hostSock] = sockets as [TestClient, TestClient];
    await joinVoice(ownerSock, channelId, actors[0]!.id);
    await joinVoice(hostSock, channelId, actors[1]!.id);

    hostSock.send(clientEvent.watchStart({ channelId, source: "youtube", videoRef: VIDEO }));
    await ownerSock.waitFor(SERVER_EVENT.watchStarted);

    const refs = [VIDEO_2, VIDEO_3, VIDEO_4];
    for (const [i, videoRef] of refs.entries()) {
      hostSock.send(clientEvent.watchQueueAdd({ channelId, itemId: itemId(i + 1), videoRef }));
      await ownerSock.waitFor(
        SERVER_EVENT.watchQueueUpdated,
        (e) => e.payload.queue.length === i + 1,
      );
    }

    // TWO controllers reorder in the same instant, each from the view they had.
    // The host reverses; the owner names a stale id (already-removed rows are the
    // realistic version of this) alongside real ones.
    ownerSock.envelopes.length = 0;
    hostSock.send(
      clientEvent.watchQueueReorder({
        channelId,
        itemIds: [itemId(3), itemId(2), itemId(1)],
      }),
    );
    ownerSock.send(
      clientEvent.watchQueueReorder({
        channelId,
        itemIds: [itemId(2), itemId(404), itemId(1)],
      }),
    );
    await settle(600);

    const final = lastQueue(ownerSock);
    expect(final).not.toBeNull();
    // Whoever won, the result is a PERMUTATION of what the server holds: all
    // three items, each exactly once, and nothing invented.
    const ids = final!.map((item) => item.itemId).sort();
    expect(ids).toEqual([itemId(1), itemId(2), itemId(3)].sort());
    expect(new Set(ids).size).toBe(3);
    // The id the server never had is not in the answer.
    expect(final!.some((item) => item.itemId === itemId(404))).toBe(false);

    // Both sockets agree — the room is not left holding two different lists.
    expect(lastQueue(hostSock)!.map((item) => item.itemId)).toEqual(
      final!.map((item) => item.itemId),
    );

    for (const socket of sockets) socket.close();
  });

  it("moves an item to the front without losing the others", async () => {
    const { channelId, actors, sockets } = await makeRoom("move", 2);
    const [hostSock, peerSock] = sockets as [TestClient, TestClient];
    await joinVoice(hostSock, channelId, actors[0]!.id);
    await joinVoice(peerSock, channelId, actors[1]!.id);

    hostSock.send(clientEvent.watchStart({ channelId, source: "youtube", videoRef: VIDEO }));
    await peerSock.waitFor(SERVER_EVENT.watchStarted);
    for (const [i, videoRef] of [VIDEO_2, VIDEO_3, VIDEO_4].entries()) {
      hostSock.send(clientEvent.watchQueueAdd({ channelId, itemId: itemId(i + 1), videoRef }));
      await peerSock.waitFor(
        SERVER_EVENT.watchQueueUpdated,
        (e) => e.payload.queue.length === i + 1,
      );
    }

    // A partial order — the common UI action, "drag this one to the top" — leaves
    // everything it did not mention in its existing relative order behind it.
    hostSock.send(clientEvent.watchQueueReorder({ channelId, itemIds: [itemId(3)] }));
    const updated = await peerSock.waitFor(
      SERVER_EVENT.watchQueueUpdated,
      (e) => e.payload.queue[0]?.itemId === itemId(3),
    );
    expect(updated.payload.queue.map((item) => item.itemId)).toEqual([
      itemId(3),
      itemId(1),
      itemId(2),
    ]);

    for (const socket of sockets) socket.close();
  });

  it("refuses an add past the cap, and says so honestly", async () => {
    const { channelId, actors, sockets } = await makeRoom("cap", 2);
    const [hostSock, peerSock] = sockets as [TestClient, TestClient];
    await joinVoice(hostSock, channelId, actors[0]!.id);
    await joinVoice(peerSock, channelId, actors[1]!.id);

    hostSock.send(clientEvent.watchStart({ channelId, source: "youtube", videoRef: VIDEO }));
    await peerSock.waitFor(SERVER_EVENT.watchStarted);

    // Seeded straight into the store rather than sent 50 times over the socket.
    // The watch bucket refills at 4 frames/s, so driving this over the wire would
    // spend ~13 s proving the RATE LIMITER works — which its own test already
    // does — before ever reaching the cap this test is about.
    const seeded = await watchStore.get(channelId);
    expect(seeded).not.toBeNull();
    await watchStore.save({
      ...seeded!,
      queue: Array.from({ length: WATCH_QUEUE_MAX_ITEMS }, (_, i) => ({
        itemId: itemId(i + 1),
        videoId: VIDEO_2,
        addedBy: actors[0]!.id,
        addedAt: new Date().toISOString(),
        title: null,
        durationSeconds: null,
      })),
    });

    hostSock.envelopes.length = 0;
    hostSock.send(
      clientEvent.watchQueueAdd({
        channelId,
        itemId: itemId(WATCH_QUEUE_MAX_ITEMS + 1),
        videoRef: VIDEO_3,
      }),
    );
    const denied = await hostSock.waitFor(SERVER_EVENT.errorRaised, () => true, 6000);
    expect(denied.payload.code).toBe("WATCH_QUEUE_FULL");
    // The message names the number and the way out, rather than just refusing.
    expect(denied.payload.message).toContain(String(WATCH_QUEUE_MAX_ITEMS));
    // Refused, not silently dropped: the stored queue is untouched.
    expect((await watchStore.get(channelId))?.queue).toHaveLength(WATCH_QUEUE_MAX_ITEMS);

    // A REMOVE makes room again, so the cap is a limit and not a dead end.
    hostSock.send(
      clientEvent.watchQueueRemove({ channelId, itemId: itemId(1) }),
    );
    await peerSock.waitFor(
      SERVER_EVENT.watchQueueUpdated,
      (e) => e.payload.queue.length === WATCH_QUEUE_MAX_ITEMS - 1,
    );
    hostSock.send(
      clientEvent.watchQueueAdd({
        channelId,
        itemId: itemId(WATCH_QUEUE_MAX_ITEMS + 1),
        videoRef: VIDEO_3,
      }),
    );
    const refilled = await peerSock.waitFor(
      SERVER_EVENT.watchQueueUpdated,
      (e) => e.payload.queue.length === WATCH_QUEUE_MAX_ITEMS,
    );
    expect(refilled.payload.queue.at(-1)?.videoId).toBe(VIDEO_3);

    for (const socket of sockets) socket.close();
  });

  it("never lets a non-YouTube reference into the queue", async () => {
    const { channelId, actors, sockets } = await makeRoom("bad", 2);
    const [hostSock, peerSock] = sockets as [TestClient, TestClient];
    await joinVoice(hostSock, channelId, actors[0]!.id);
    await joinVoice(peerSock, channelId, actors[1]!.id);

    hostSock.send(clientEvent.watchStart({ channelId, source: "youtube", videoRef: VIDEO }));
    await peerSock.waitFor(SERVER_EVENT.watchStarted);

    // Refused at the protocol boundary, before a handler sees the frame — the
    // same list the playback suite proves for `watch.start`.
    const hostile = [
      "https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ",
      "javascript:alert(1)",
      "../../etc/passwd",
      "dQw4w9WgXcQQQQ",
    ];
    for (const [i, videoRef] of hostile.entries()) {
      hostSock.envelopes.length = 0;
      hostSock.sendRaw(
        JSON.stringify({
          type: "watch.queue_add",
          payload: { channelId, itemId: itemId(500 + i), videoRef },
        }),
      );
      const denied = await hostSock.waitFor(SERVER_EVENT.errorRaised, () => true, 4000);
      expect(denied.payload.code, videoRef).toBe("INVALID_PAYLOAD");
    }

    await settle();
    expect(lastQueue(peerSock)).toBeNull();

    for (const socket of sockets) socket.close();
  });

  it("hands the queue to a client when it joins the room, and again on rejoin", async () => {
    const { channelId, actors, sockets } = await makeRoom("join", 2);
    const [hostSock, peerSock] = sockets as [TestClient, TestClient];
    await joinVoice(hostSock, channelId, actors[0]!.id);

    hostSock.send(clientEvent.watchStart({ channelId, source: "youtube", videoRef: VIDEO }));
    await hostSock.waitFor(SERVER_EVENT.watchStarted);
    hostSock.send(clientEvent.watchQueueAdd({ channelId, itemId: itemId(1), videoRef: VIDEO_2 }));
    await hostSock.waitFor(SERVER_EVENT.watchQueueUpdated);

    // The peer was a member the whole time (it saw `watch.started` channel-wide)
    // but was never IN the room, so it has no queue.
    await peerSock.waitFor(SERVER_EVENT.watchStarted);
    expect(lastQueue(peerSock)).toBeNull();

    await joinVoice(peerSock, channelId, actors[1]!.id);
    const onJoin = await peerSock.waitFor(SERVER_EVENT.watchQueueUpdated);
    expect(onJoin.payload.queue.map((item) => item.videoId)).toEqual([VIDEO_2]);

    // Drop and come back — the case every network blip and every deploy hits.
    peerSock.close();
    await peerSock.closed;
    const reconnected = await TestClient.connect(port, actors[1]!.token);
    await reconnected.waitFor(SERVER_EVENT.authSucceeded);
    // The reconnect snapshot re-seats the PLAYER; the queue arrives with the
    // room, which is the moment this socket rejoins the audience for it.
    await reconnected.waitFor(SERVER_EVENT.watchStarted);
    await joinVoice(reconnected, channelId, actors[1]!.id);
    const afterRejoin = await reconnected.waitFor(SERVER_EVENT.watchQueueUpdated);
    expect(afterRejoin.payload.queue.map((item) => item.videoId)).toEqual([VIDEO_2]);

    reconnected.close();
    hostSock.close();
  });

  it("advances on watch.ended exactly once, however many times it is reported", async () => {
    const { channelId, actors, sockets } = await makeRoom("adv", 2);
    const [hostSock, peerSock] = sockets as [TestClient, TestClient];
    await joinVoice(hostSock, channelId, actors[0]!.id);
    await joinVoice(peerSock, channelId, actors[1]!.id);

    hostSock.send(clientEvent.watchStart({ channelId, source: "youtube", videoRef: VIDEO }));
    await peerSock.waitFor(SERVER_EVENT.watchStarted);
    for (const [i, videoRef] of [VIDEO_2, VIDEO_3].entries()) {
      hostSock.send(clientEvent.watchQueueAdd({ channelId, itemId: itemId(i + 1), videoRef }));
      await peerSock.waitFor(
        SERVER_EVENT.watchQueueUpdated,
        (e) => e.payload.queue.length === i + 1,
      );
    }

    // A player can report ENDED more than once; a duplicate must not eat the
    // second video. Both frames name the video that finished, and only the first
    // one matches the session's current video.
    hostSock.send(clientEvent.watchEnded({ channelId, videoId: VIDEO }));
    hostSock.send(clientEvent.watchEnded({ channelId, videoId: VIDEO }));
    const advanced = await peerSock.waitFor(
      SERVER_EVENT.watchState,
      (e) => e.payload.videoId === VIDEO_2,
    );
    // Restarted at the top — NOT exactly 0. The stored state is "position 0 as of
    // updatedAtMs" and the broadcast projects it forward to send time, so the
    // number carries however long the gateway took to get here. `toBe(0)` held on
    // an idle machine and failed once in a full-suite run at ~0.1s: it was
    // asserting the scheduler, not the product. What must be true is that the new
    // video starts from the top instead of inheriting the finished one's clock —
    // any real carry-over would be seconds or minutes, so a sub-second window
    // separates the two without pretending the projection stands still.
    expect(advanced.payload.positionSec).toBeGreaterThanOrEqual(0);
    expect(advanced.payload.positionSec).toBeLessThan(1);
    expect(advanced.payload.playing).toBe(true);

    // Wait for the CONSUMPTION frame, not for a stopwatch. `watch.state` arriving
    // does not mean the queue frame has landed, so a fixed sleep here is a bet on
    // scheduling: it held on an idle machine and lost under a full-suite run,
    // failing as "queue still has two items" — which reads as a broken advance
    // and is really just a frame in flight.
    await peerSock.waitFor(
      SERVER_EVENT.watchQueueUpdated,
      (e) => e.payload.queue.length === 1,
    );
    // Exactly one item was consumed: VIDEO_3 is still waiting.
    expect(lastQueue(peerSock)!.map((item) => item.videoId)).toEqual([VIDEO_3]);

    // A LATE report for a video that is no longer playing is ignored too.
    hostSock.send(clientEvent.watchEnded({ channelId, videoId: VIDEO }));
    await settle();
    expect(lastQueue(peerSock)!.map((item) => item.videoId)).toEqual([VIDEO_3]);

    for (const socket of sockets) socket.close();
  });

  it("freezes on the last video instead of ending the party when the queue runs out", async () => {
    const { channelId, actors, sockets } = await makeRoom("last", 2);
    const [hostSock, peerSock] = sockets as [TestClient, TestClient];
    await joinVoice(hostSock, channelId, actors[0]!.id);
    await joinVoice(peerSock, channelId, actors[1]!.id);

    hostSock.send(clientEvent.watchStart({ channelId, source: "youtube", videoRef: VIDEO }));
    await peerSock.waitFor(SERVER_EVENT.watchStarted);

    hostSock.send(clientEvent.watchEnded({ channelId, videoId: VIDEO }));
    const frozen = await peerSock.waitFor(
      SERVER_EVENT.watchState,
      (e) => e.payload.playing === false,
    );
    // Same video, paused. The room is still sitting there deciding what is next,
    // so the party — and its channel-wide badge — must still be running.
    expect(frozen.payload.videoId).toBe(VIDEO);
    expect(
      peerSock.envelopes.some((e) => e.event.type === SERVER_EVENT.watchStopped),
    ).toBe(false);

    // And it really is still live: the host can queue something and play it.
    hostSock.send(clientEvent.watchQueueAdd({ channelId, itemId: itemId(1), videoRef: VIDEO_2 }));
    await peerSock.waitFor(SERVER_EVENT.watchQueueUpdated);
    hostSock.send(clientEvent.watchQueuePlay({ channelId, itemId: itemId(1) }));
    const playing = await peerSock.waitFor(
      SERVER_EVENT.watchState,
      (e) => e.payload.videoId === VIDEO_2,
    );
    expect(playing.payload.playing).toBe(true);
    expect(lastQueue(peerSock)).toEqual([]);

    for (const socket of sockets) socket.close();
  });

  it("keeps skipped-over items when the host plays one from the middle", async () => {
    const { channelId, actors, sockets } = await makeRoom("skip", 2);
    const [hostSock, peerSock] = sockets as [TestClient, TestClient];
    await joinVoice(hostSock, channelId, actors[0]!.id);
    await joinVoice(peerSock, channelId, actors[1]!.id);

    hostSock.send(clientEvent.watchStart({ channelId, source: "youtube", videoRef: VIDEO }));
    await peerSock.waitFor(SERVER_EVENT.watchStarted);
    for (const [i, videoRef] of [VIDEO_2, VIDEO_3, VIDEO_4].entries()) {
      hostSock.send(clientEvent.watchQueueAdd({ channelId, itemId: itemId(i + 1), videoRef }));
      await peerSock.waitFor(
        SERVER_EVENT.watchQueueUpdated,
        (e) => e.payload.queue.length === i + 1,
      );
    }

    hostSock.send(clientEvent.watchQueuePlay({ channelId, itemId: itemId(3) }));
    await peerSock.waitFor(SERVER_EVENT.watchState, (e) => e.payload.videoId === VIDEO_4);
    // "Play that one" is not "throw these away" — the two it jumped stay queued.
    expect(lastQueue(peerSock)!.map((item) => item.itemId)).toEqual([itemId(1), itemId(2)]);

    // A row that is already gone answers plainly rather than silently.
    hostSock.envelopes.length = 0;
    hostSock.send(clientEvent.watchQueuePlay({ channelId, itemId: itemId(3) }));
    const denied = await hostSock.waitFor(SERVER_EVENT.errorRaised, () => true, 4000);
    expect(denied.payload.code).toBe("INVALID_PAYLOAD");

    for (const socket of sockets) socket.close();
  });

  it("clears the queue when the session ends", async () => {
    const { channelId, actors, sockets } = await makeRoom("end", 2);
    const [hostSock, peerSock] = sockets as [TestClient, TestClient];
    await joinVoice(hostSock, channelId, actors[0]!.id);
    await joinVoice(peerSock, channelId, actors[1]!.id);

    hostSock.send(clientEvent.watchStart({ channelId, source: "youtube", videoRef: VIDEO }));
    await peerSock.waitFor(SERVER_EVENT.watchStarted);
    hostSock.send(clientEvent.watchQueueAdd({ channelId, itemId: itemId(1), videoRef: VIDEO_2 }));
    await peerSock.waitFor(SERVER_EVENT.watchQueueUpdated);

    hostSock.send(clientEvent.watchStop({ channelId }));
    await peerSock.waitFor(SERVER_EVENT.watchStopped);

    // The session record is deleted, queue and all: a fresh party in the same
    // channel starts empty rather than inheriting the last one's playlist.
    peerSock.envelopes.length = 0;
    hostSock.send(clientEvent.watchStart({ channelId, source: "youtube", videoRef: VIDEO_3 }));
    await peerSock.waitFor(SERVER_EVENT.watchStarted);
    await settle();
    expect(lastQueue(peerSock)).toBeNull();

    // …and the queue really is gone server-side, not merely un-broadcast.
    hostSock.envelopes.length = 0;
    hostSock.send(clientEvent.watchQueuePlay({ channelId, itemId: itemId(1) }));
    const denied = await hostSock.waitFor(SERVER_EVENT.errorRaised, () => true, 4000);
    expect(denied.payload.code).toBe("INVALID_PAYLOAD");

    for (const socket of sockets) socket.close();
  });
});

// ---------------------------------------------------------------------------
// The queue must NOT ride the drift heartbeat (§27) — its own gateway, so the
// cadence can be short without polluting the frame counts above.
// ---------------------------------------------------------------------------

describe.skipIf(!dbUp)("gateway watch party queue — heartbeat silence", () => {
  let client: DbClient;
  let repos: Repositories;
  let gateway: Gateway;
  let port: number;

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);
    gateway = createGateway(
      {
        repos,
        presence: new InMemoryPresenceStore(),
        mutationBus: new InMemoryMutationBus(),
      },
      { port: 0, watchHeartbeatIntervalMs: 150 },
    );
    port = await gateway.ready;
  });

  afterAll(async () => {
    await gateway?.close();
    await client?.close();
  });

  it("re-states the position every tick and the queue never", async () => {
    const host = await makeActor(repos, "hbq");
    const group = await repos.groups.create({ name: "Queue heartbeat", ownerId: host.id });
    const channel = await repos.channels.create({
      groupId: group.id,
      kind: "voice",
      name: "cinema",
    });

    const hostSock = await TestClient.connect(port, host.token);
    await hostSock.waitFor(SERVER_EVENT.authSucceeded);
    hostSock.send(clientEvent.voiceJoin({ channelId: channel.id }));
    await hostSock.waitFor(
      SERVER_EVENT.voiceParticipantJoined,
      (e) => e.payload.userId === host.id,
    );
    hostSock.send(
      clientEvent.watchStart({ channelId: channel.id, source: "youtube", videoRef: VIDEO }),
    );
    await hostSock.waitFor(SERVER_EVENT.watchStarted);
    hostSock.send(
      clientEvent.watchQueueAdd({
        channelId: channel.id,
        itemId: itemId(1),
        videoRef: VIDEO_2,
      }),
    );
    await hostSock.waitFor(SERVER_EVENT.watchQueueUpdated);

    const queueFramesBefore = hostSock.envelopes.filter(
      (e) => e.event.type === SERVER_EVENT.watchQueueUpdated,
    ).length;
    await settle(700);

    // Several heartbeats went past: the position was re-stated repeatedly…
    const states = hostSock.envelopes.filter((e) => e.event.type === SERVER_EVENT.watchState);
    expect(states.length).toBeGreaterThanOrEqual(2);
    // …and the queue was not re-sent once. This is the §27 claim the split into a
    // separate event exists to make: the hot frame stays small.
    const queueFramesAfter = hostSock.envelopes.filter(
      (e) => e.event.type === SERVER_EVENT.watchQueueUpdated,
    ).length;
    expect(queueFramesAfter).toBe(queueFramesBefore);

    hostSock.close();
  });
});
