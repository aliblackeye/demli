/**
 * Watch party at the GATEWAY (M20, ADR 0016) — real Postgres + real WebSockets.
 * Auto-skipped (with a notice) when the database is unreachable.
 *
 * The feature's whole value is that ONE person's press moves everyone's player,
 * which is also its whole risk: every assertion here is either "the server did
 * not take the client's word for something" or "the room cannot get stuck".
 *
 * Covered:
 *  1. a member who is not IN the voice channel controls nothing (occupancy is
 *     server truth — the payload's channelId proves nothing);
 *  2. an occupant who is not the host controls nothing;
 *  3. the SERVER OWNER can take over a session someone else started;
 *  4. a timed-out member (ADR 0019) controls nothing, exactly as on the message
 *     paths — a mute that stops at chat is not a mute;
 *  5. the host leaving hands control to the longest-present occupant;
 *  6. the last occupant leaving ENDS the session (`channel_empty`);
 *  7. a video reference that is not a YouTube video is refused at the boundary
 *     and nothing is stored or broadcast (the injection boundary);
 *  8. a (re)connecting client is re-seated on the running session, and joining
 *     the room hands it the live position;
 *  9. the drift heartbeat advances the position for the room;
 * 10. control frames are rate limited.
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
import { clientEvent, SERVER_EVENT } from "@demli/protocol";
import { createGateway, type Gateway } from "../gateway.js";
import { InMemoryPresenceStore } from "../presence.js";
import { DATABASE_URL, isDbUp, TestClient } from "./harness.js";
import { refuseToSkipIfRequired } from "@demli/db/testing";

const VIDEO = "dQw4w9WgXcQ";
const OTHER_VIDEO = "9bZkp7q19f0";

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

/** Give the gateway a beat to deliver (or deliberately NOT deliver) a frame. */
async function settle(ms = 400): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const dbUp = await isDbUp();
if (!dbUp) {
  refuseToSkipIfRequired("postgres");
  console.warn("[gateway.watch-party.int.test] DATABASE unreachable — skipping integration tests");
}

describe.skipIf(!dbUp)("gateway watch party", () => {
  let client: DbClient;
  let repos: Repositories;
  let gateway: Gateway;
  let port: number;

  /** A server with one voice channel, plus connected+joined sockets per actor. */
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
    const group = await repos.groups.create({ name: `Watch ${label}`, ownerId: owner.id });
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

  /** Join `socket` to the voice channel and wait until the gateway confirms it. */
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
      // The drift heartbeat is parked far out of the way for this suite so every
      // `watch.state` an assertion counts is one a CONTROL produced. The
      // heartbeat has its own test below, on its own gateway.
      { port: 0, watchHeartbeatIntervalMs: 60_000 },
    );
    port = await gateway.ready;
  });

  afterAll(async () => {
    await gateway?.close();
    await client?.close();
  });

  it("refuses control from a member who is not in the voice channel", async () => {
    const { channelId, actors, sockets } = await makeRoom("out", 2);
    const [host, outsider] = sockets as [TestClient, TestClient];
    await joinVoice(host, channelId, actors[0]!.id);

    host.send(clientEvent.watchStart({ channelId, source: "youtube", videoRef: VIDEO }));
    await host.waitFor(SERVER_EVENT.watchStarted);

    // The outsider can SEE the channel (they are a member, so they got the
    // channel-wide `watch.started`) but is not IN it. Every control is refused.
    await outsider.waitFor(SERVER_EVENT.watchStarted);
    outsider.send(clientEvent.watchControl({ channelId, action: "pause", positionSec: 5 }));
    const denied = await outsider.waitFor(SERVER_EVENT.errorRaised);
    expect(denied.payload.code).toBe("NOT_IN_VOICE");

    await settle();
    // Nothing moved: the host's room never saw a state change.
    expect(host.envelopes.filter((e) => e.event.type === SERVER_EVENT.watchState)).toHaveLength(0);

    for (const socket of sockets) socket.close();
  });

  it("refuses control from an occupant who is not the host", async () => {
    const { channelId, actors, sockets } = await makeRoom("nh", 2);
    const [ownerSock, memberSock] = sockets as [TestClient, TestClient];
    await joinVoice(ownerSock, channelId, actors[0]!.id);
    await joinVoice(memberSock, channelId, actors[1]!.id);

    // The plain MEMBER starts it, so they are the host and the owner is not.
    memberSock.send(clientEvent.watchStart({ channelId, source: "youtube", videoRef: VIDEO }));
    const started = await ownerSock.waitFor(SERVER_EVENT.watchStarted);
    expect(started.payload.hostId).toBe(actors[1]!.id);
    expect(started.payload.videoId).toBe(VIDEO);

    // A THIRD member who is in the room but is neither host nor owner.
    const bystander = await makeActor(repos, "nhb");
    await repos.groups.addMember(
      (await repos.channels.findWithMembership(channelId, actors[0]!.id))!.channel.groupId,
      bystander.id,
      "member",
    );
    const bystanderSock = await TestClient.connect(port, bystander.token);
    await bystanderSock.waitFor(SERVER_EVENT.authSucceeded);
    await joinVoice(bystanderSock, channelId, bystander.id);

    bystanderSock.send(clientEvent.watchStop({ channelId }));
    const denied = await bystanderSock.waitFor(SERVER_EVENT.errorRaised);
    expect(denied.payload.code).toBe("NOT_HOST");

    // Replacing the video is a control too — same refusal, so "start" is not a
    // back door around the host rule.
    bystanderSock.send(clientEvent.watchSetVideo({ channelId, videoRef: OTHER_VIDEO }));
    const deniedSetVideo = await bystanderSock.waitFor(
      SERVER_EVENT.errorRaised,
      (e) => e.payload.message.includes("host"),
      4000,
    );
    expect(deniedSetVideo.payload.code).toBe("NOT_HOST");

    await settle();
    expect(
      ownerSock.envelopes.some((e) => e.event.type === SERVER_EVENT.watchStopped),
    ).toBe(false);

    bystanderSock.close();
    for (const socket of sockets) socket.close();
  });

  it("lets the server owner take over a session someone else started", async () => {
    const { channelId, actors, sockets } = await makeRoom("own", 2);
    const [ownerSock, memberSock] = sockets as [TestClient, TestClient];
    await joinVoice(ownerSock, channelId, actors[0]!.id);
    await joinVoice(memberSock, channelId, actors[1]!.id);

    memberSock.send(clientEvent.watchStart({ channelId, source: "youtube", videoRef: VIDEO }));
    await ownerSock.waitFor(SERVER_EVENT.watchStarted);

    // The owner is not the host, but a room must never be held hostage.
    ownerSock.send(clientEvent.watchControl({ channelId, action: "pause", positionSec: 30 }));
    const state = await memberSock.waitFor(SERVER_EVENT.watchState);
    expect(state.payload.playing).toBe(false);
    expect(state.payload.positionSec).toBe(30);
    // Taking over playback does NOT silently steal the host role.
    expect(state.payload.hostId).toBe(actors[1]!.id);

    ownerSock.send(clientEvent.watchStop({ channelId }));
    const stopped = await memberSock.waitFor(SERVER_EVENT.watchStopped);
    expect(stopped.payload.reason).toBe("host_stopped");

    for (const socket of sockets) socket.close();
  });

  it("refuses control from a timed-out member", async () => {
    const { groupId, channelId, actors, sockets } = await makeRoom("to", 2);
    const [ownerSock, memberSock] = sockets as [TestClient, TestClient];
    await joinVoice(ownerSock, channelId, actors[0]!.id);
    await joinVoice(memberSock, channelId, actors[1]!.id);

    memberSock.send(clientEvent.watchStart({ channelId, source: "youtube", videoRef: VIDEO }));
    await memberSock.waitFor(SERVER_EVENT.watchStarted);

    // Muted mid-session; the socket stays open and is not re-handshaked, so this
    // proves the gate is re-read per frame rather than cached at connect.
    await repos.groups.setMemberTimeout(groupId, actors[1]!.id, new Date(Date.now() + 3_600_000));

    memberSock.send(clientEvent.watchControl({ channelId, action: "pause", positionSec: 9 }));
    const denied = await memberSock.waitFor(SERVER_EVENT.errorRaised);
    expect(denied.payload.code).toBe("TIMED_OUT");

    await settle();
    expect(
      ownerSock.envelopes.some((e) => e.event.type === SERVER_EVENT.watchState),
    ).toBe(false);

    for (const socket of sockets) socket.close();
  });

  it("hands the host role to the longest-present occupant when the host leaves", async () => {
    const { channelId, actors, sockets } = await makeRoom("ho", 3);
    const [hostSock, firstSock, secondSock] = sockets as [TestClient, TestClient, TestClient];
    await joinVoice(hostSock, channelId, actors[0]!.id);
    await joinVoice(firstSock, channelId, actors[1]!.id);
    await joinVoice(secondSock, channelId, actors[2]!.id);

    hostSock.send(clientEvent.watchStart({ channelId, source: "youtube", videoRef: VIDEO }));
    await firstSock.waitFor(SERVER_EVENT.watchStarted);

    hostSock.send(clientEvent.voiceLeave({ channelId }));

    // Deterministic: the occupant who has been in the room longest takes over.
    const handed = await firstSock.waitFor(SERVER_EVENT.watchHostChanged);
    expect(handed.payload.hostId).toBe(actors[1]!.id);
    const handedForSecond = await secondSock.waitFor(SERVER_EVENT.watchHostChanged);
    expect(handedForSecond.payload.hostId).toBe(actors[1]!.id);

    // And the new host really can drive.
    firstSock.send(clientEvent.watchControl({ channelId, action: "pause", positionSec: 3 }));
    const state = await secondSock.waitFor(SERVER_EVENT.watchState);
    expect(state.payload.hostId).toBe(actors[1]!.id);
    expect(state.payload.playing).toBe(false);

    for (const socket of sockets) socket.close();
  });

  it("ends the session when the last occupant leaves", async () => {
    const { channelId, actors, sockets } = await makeRoom("empty", 2);
    const [hostSock, watcherSock] = sockets as [TestClient, TestClient];
    await joinVoice(hostSock, channelId, actors[0]!.id);

    hostSock.send(clientEvent.watchStart({ channelId, source: "youtube", videoRef: VIDEO }));
    await watcherSock.waitFor(SERVER_EVENT.watchStarted);

    hostSock.send(clientEvent.voiceLeave({ channelId }));

    // Channel-wide, so even the member who never joined the room learns the
    // party is over and can drop its badge.
    const stopped = await watcherSock.waitFor(SERVER_EVENT.watchStopped);
    expect(stopped.payload.reason).toBe("channel_empty");

    // The session is really gone — a fresh occupant is told nothing is running.
    await joinVoice(watcherSock, channelId, actors[1]!.id);
    await settle();
    expect(
      watcherSock.envelopes.some((e) => e.event.type === SERVER_EVENT.watchState),
    ).toBe(false);
    watcherSock.send(clientEvent.watchControl({ channelId, action: "play", positionSec: 0 }));
    const denied = await watcherSock.waitFor(SERVER_EVENT.errorRaised);
    expect(denied.payload.code).toBe("WATCH_NOT_ACTIVE");

    for (const socket of sockets) socket.close();
  });

  it("refuses a video reference that is not a YouTube video, and stores nothing", async () => {
    const { channelId, actors, sockets } = await makeRoom("bad", 2);
    const [hostSock, watcherSock] = sockets as [TestClient, TestClient];
    await joinVoice(hostSock, channelId, actors[0]!.id);

    // Every one of these is refused at the protocol boundary, so no handler ever
    // sees it: a lookalike host, a javascript: URL, and an id of the wrong shape.
    const hostile = [
      "https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ",
      "javascript:alert(1)",
      "../../etc/passwd",
      "dQw4w9WgXcQQQQ",
    ];
    for (const videoRef of hostile) {
      hostSock.sendRaw(
        JSON.stringify({
          type: "watch.start",
          payload: { channelId, source: "youtube", videoRef },
        }),
      );
      const denied = await hostSock.waitFor(
        SERVER_EVENT.errorRaised,
        () => true,
        4000,
      );
      expect(denied.payload.code).toBe("INVALID_PAYLOAD");
      // Drop the frame we just matched so the next iteration waits for its own.
      hostSock.envelopes.length = 0;
    }

    await settle();
    // Nothing was started for anyone.
    expect(
      watcherSock.envelopes.some((e) => e.event.type === SERVER_EVENT.watchStarted),
    ).toBe(false);

    // A LINK, on the other hand, is accepted — and what goes back on the wire is
    // the normalized id, never the string the client sent.
    hostSock.send(
      clientEvent.watchStart({
        channelId,
        source: "youtube",
        videoRef: `https://www.youtube.com/watch?v=${VIDEO}&t=42`,
      }),
    );
    const started = await watcherSock.waitFor(SERVER_EVENT.watchStarted);
    expect(started.payload.videoId).toBe(VIDEO);
    expect(watcherSock.rawFrames.some((frame) => frame.includes("youtube.com/watch"))).toBe(false);

    for (const socket of sockets) socket.close();
  });

  it("re-seats a reconnecting client on the running session", async () => {
    const { channelId, actors, sockets } = await makeRoom("re", 2);
    const [hostSock, peerSock] = sockets as [TestClient, TestClient];
    await joinVoice(hostSock, channelId, actors[0]!.id);
    await joinVoice(peerSock, channelId, actors[1]!.id);

    hostSock.send(clientEvent.watchStart({ channelId, source: "youtube", videoRef: VIDEO }));
    await peerSock.waitFor(SERVER_EVENT.watchStarted);
    hostSock.send(clientEvent.watchControl({ channelId, action: "pause", positionSec: 120 }));
    await peerSock.waitFor(SERVER_EVENT.watchState, (e) => e.payload.positionSec === 120);

    // The peer drops and comes back — the case a real client hits on every
    // network blip and every deploy.
    peerSock.close();
    await peerSock.closed;
    const reconnected = await TestClient.connect(port, actors[1]!.token);
    await reconnected.waitFor(SERVER_EVENT.authSucceeded);

    // Pushed by the server on (re)connect, with no request event of its own —
    // the same model as `voice.resync`.
    const snapshot = await reconnected.waitFor(SERVER_EVENT.watchStarted);
    expect(snapshot.payload.channelId).toBe(channelId);
    expect(snapshot.payload.videoId).toBe(VIDEO);
    expect(snapshot.payload.hostId).toBe(actors[0]!.id);
    expect(snapshot.payload.playing).toBe(false);
    expect(snapshot.payload.positionSec).toBe(120);
    expect(typeof snapshot.payload.serverTime).toBe("string");

    // Rejoining the room hands it the live position too.
    await joinVoice(reconnected, channelId, actors[1]!.id);
    const state = await reconnected.waitFor(SERVER_EVENT.watchState);
    expect(state.payload.positionSec).toBe(120);

    reconnected.close();
    hostSock.close();
  });

  it("rate limits control frames without killing the session", async () => {
    const { channelId, actors, sockets } = await makeRoom("rl", 2);
    const [hostSock, peerSock] = sockets as [TestClient, TestClient];
    await joinVoice(hostSock, channelId, actors[0]!.id);
    await joinVoice(peerSock, channelId, actors[1]!.id);

    hostSock.send(clientEvent.watchStart({ channelId, source: "youtube", videoRef: VIDEO }));
    await peerSock.waitFor(SERVER_EVENT.watchStarted);

    for (let i = 0; i < 200; i++) {
      hostSock.send(clientEvent.watchControl({ channelId, action: "seek", positionSec: i }));
    }
    await settle(600);

    // Capacity is 20 and `watch.start` already spent one of those tokens, so 19
    // controls get through plus whatever the 4/s refill adds during delivery.
    // The point is that 200 frames do not become 200 DB reads and 200 fan-outs.
    const delivered = peerSock.envelopes.filter(
      (e) => e.event.type === SERVER_EVENT.watchState,
    ).length;
    expect(delivered).toBeGreaterThanOrEqual(19);
    expect(delivered).toBeLessThan(60);

    const limited = hostSock.envelopes.filter(
      (e) => e.event.type === SERVER_EVENT.errorRaised && e.event.payload.code === "RATE_LIMITED",
    ).length;
    expect(limited).toBeGreaterThan(0);

    // Shedding load must never cost a valid session its socket.
    let closedEarly = false;
    void hostSock.closed.then(() => {
      closedEarly = true;
    });
    await settle(100);
    expect(closedEarly).toBe(false);

    for (const socket of sockets) socket.close();
  });
});

// ---------------------------------------------------------------------------
// Drift heartbeat — its own gateway so the cadence can be short without
// polluting the frame counts above.
// ---------------------------------------------------------------------------

describe.skipIf(!dbUp)("gateway watch party — drift heartbeat", () => {
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

  it("re-states an advancing position to the room, and only to the room", async () => {
    const host = await makeActor(repos, "hbH");
    const bystander = await makeActor(repos, "hbB");
    const group = await repos.groups.create({ name: "Heartbeat", ownerId: host.id });
    await repos.groups.addMember(group.id, bystander.id, "member");
    const channel = await repos.channels.create({
      groupId: group.id,
      kind: "voice",
      name: "cinema",
    });

    const hostSock = await TestClient.connect(port, host.token);
    const bystanderSock = await TestClient.connect(port, bystander.token);
    await hostSock.waitFor(SERVER_EVENT.authSucceeded);
    await bystanderSock.waitFor(SERVER_EVENT.authSucceeded);

    hostSock.send(clientEvent.voiceJoin({ channelId: channel.id }));
    await hostSock.waitFor(
      SERVER_EVENT.voiceParticipantJoined,
      (e) => e.payload.userId === host.id,
    );
    hostSock.send(
      clientEvent.watchStart({ channelId: channel.id, source: "youtube", videoRef: VIDEO }),
    );
    await hostSock.waitFor(SERVER_EVENT.watchStarted);

    // Several ticks: a PLAYING session's position is projected forward from the
    // last control, which is what lets a client that drifted seek back.
    await settle(600);
    const states = hostSock.envelopes
      .filter((e) => e.event.type === SERVER_EVENT.watchState)
      .map((e) => e.event.payload as { positionSec: number });
    expect(states.length).toBeGreaterThanOrEqual(2);
    expect(states[states.length - 1]!.positionSec).toBeGreaterThan(states[0]!.positionSec);

    // The bystander can see the channel but is not in the room: they got the
    // lifecycle event and NONE of the 150 ms drift traffic (§27).
    expect(
      bystanderSock.envelopes.some((e) => e.event.type === SERVER_EVENT.watchStarted),
    ).toBe(true);
    expect(
      bystanderSock.envelopes.some((e) => e.event.type === SERVER_EVENT.watchState),
    ).toBe(false);

    hostSock.close();
    bystanderSock.close();
  });
});
