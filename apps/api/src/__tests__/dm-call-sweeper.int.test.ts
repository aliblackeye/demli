/**
 * DM-call liveness sweeper integration tests — real Postgres from docker-compose;
 * auto-skipped (with a notice) when the database is unreachable.
 *
 * These cover the founder P0 of 2026-07-27 (two `dm_calls` rows stuck
 * `status=active, ended_at IS NULL`, one THREE DAYS old, re-seeding the client
 * call FSM on every reconnect → a ring that would not stop) from both sides:
 *
 *  - the ghost really is reaped: an accepted call whose LiveKit room is empty
 *    ends, and a deploy's worth of ghosts is reconciled on the first tick;
 *  - AND — the test that matters most — a LIVE call is never reaped. A film
 *    night runs for hours, so "old ⇒ dead" would be a far worse bug than the one
 *    being fixed. Occupancy of the media plane is the only criterion, and an
 *    UNREACHABLE media plane sweeps nothing at all.
 *
 * LiveKit is stubbed by the {@link CallRoomLivenessReader} seam, so no SFU is
 * needed and the "media plane is down" case is exercised for real.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import {
  applyMigrations,
  createDb,
  createRepositories,
  InMemoryMutationBus,
  type DbClient,
  type RealtimeMutation,
  type Repositories,
} from "@demli/db";
import type { PushNotification } from "@demli/notifications";
import { SERVER_EVENT } from "@demli/protocol";
import {
  createDmCallSweeper,
  type CallRoomLivenessReader,
  type DmCallSweeper,
  type VoiceEjector,
} from "../lib/dm-call-sweeper.js";
import { RING_TIMEOUT_SECONDS } from "../modules/dm-calls/index.js";
import { refuseToSkipIfRequired } from "@demli/db/testing";

const DATABASE_URL =
  process.env["DATABASE_URL"] ?? "postgresql://postgres:postgres@localhost:5432/demli";
const RING_WINDOW_MS = RING_TIMEOUT_SECONDS * 1000;
const GRACE_MS = 3 * 60_000;

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
  console.warn("[dm-call-sweeper.int.test] DATABASE unreachable — skipping integration tests");
}

const silentLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  fatal: () => undefined,
  silent: () => undefined,
  level: "silent",
  child: () => silentLog,
} as unknown as FastifyBaseLogger;

/**
 * A media plane under full test control (room → identities, or a hard failure).
 *
 * `baseline` reports every OTHER live call room as busy. The sweeper is a global
 * job and the test database is shared with the `apps/realtime` and `packages/db`
 * suites running at the same time, so without this a test that advances its clock
 * past the grace window would reap a NEIGHBOURING suite's call. Defaulting foreign
 * rooms to occupied is also the truthful model: those calls really are live.
 */
function fakeLiveness(baseline?: () => Promise<string[]>): {
  reader: CallRoomLivenessReader;
  /** Put these users in the room. Two anonymous ones by default (= "occupied"). */
  occupy(room: string, identities?: string[]): void;
  /** Empty exactly this room. */
  clear(room: string): void;
  fail(on: boolean): void;
} {
  const overrides = new Map<string, string[]>();
  const emptied = new Set<string>();
  let failing = false;

  async function snapshot(): Promise<Map<string, string[]>> {
    const rooms = new Map<string, string[]>();
    for (const name of (await baseline?.()) ?? []) rooms.set(name, ["other", "suite"]);
    for (const name of emptied) rooms.delete(name);
    for (const [name, ids] of overrides) rooms.set(name, ids);
    return rooms;
  }

  return {
    reader: {
      async rooms(): Promise<Map<string, number>> {
        if (failing) throw new Error("livekit unreachable");
        return new Map([...(await snapshot())].map(([name, ids]) => [name, ids.length]));
      },
      async participants(room: string): Promise<string[]> {
        if (failing) throw new Error("livekit unreachable");
        return (await snapshot()).get(room) ?? [];
      },
    },
    occupy: (room, identities = ["someone", "someone-else"]) => {
      emptied.delete(room);
      overrides.set(room, identities);
    },
    clear: (room) => {
      overrides.delete(room);
      emptied.add(room);
    },
    fail: (on: boolean) => {
      failing = on;
    },
  };
}

/** Records every SFU force-remove the sweeper performs. */
function fakeEjector(): { ejector: VoiceEjector; removed: Array<[string, string]> } {
  const removed: Array<[string, string]> = [];
  return {
    ejector: {
      removeParticipant: async (room: string, identity: string) => {
        removed.push([room, identity]);
      },
    } as unknown as VoiceEjector,
    removed,
  };
}

function uniq(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

describe.skipIf(!dbUp)("DM-call liveness sweeper (founder P0: calls stuck active)", () => {
  let client: DbClient;
  let repos: Repositories;
  let bus: InMemoryMutationBus;
  const published: RealtimeMutation[] = [];
  const sweepers: DmCallSweeper[] = [];

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);
    bus = new InMemoryMutationBus();
    await bus.subscribe((m) => published.push(m));
    // The sweeper is a GLOBAL job, so it sees every live row in the shared test
    // database — including hundreds abandoned by earlier RUNS. Settle those up
    // front so `listLive()`'s bounded batch is about this suite's rows and the
    // assertions below are not hostage to leftovers. Age-scoped on purpose: the
    // `apps/realtime` / `packages/db` suites run against this same database at the
    // same time, and their rows are seconds old, not minutes.
    await client.sql`
      update dm_calls set status = 'ended', ended_at = now(), expires_at = null
      where status in ('ringing', 'active') and created_at < now() - interval '5 minutes'
    `;
  });

  /** Every live call room, so foreign suites' rooms read as busy (see fakeLiveness). */
  async function otherLiveRooms(): Promise<string[]> {
    return (await repos.calls.listLive()).map((call) => call.roomName);
  }

  /** Who received `call.ended` for ONE specific call id (the sweeper is global). */
  function endedRecipients(callId: string): string[] {
    return published
      .filter(
        (m) =>
          m.event.type === SERVER_EVENT.callEnded &&
          (m.event.payload as { callId: string }).callId === callId,
      )
      .map((m) => m.userId as string);
  }

  afterAll(async () => {
    for (const s of sweepers) s.stop();
    await client?.close();
  });

  /** A fresh DM between two brand-new users (distinct pair ⇒ distinct dm_key). */
  async function freshDm(): Promise<{ dmId: string; callerId: string; calleeId: string }> {
    const caller = await repos.users.create({
      username: uniq("swp_caller"),
      displayName: "caller",
      passwordHash: "not-used",
    });
    const callee = await repos.users.create({
      username: uniq("swp_callee"),
      displayName: "callee",
      passwordHash: "not-used",
    });
    const { dm } = await repos.dms.getOrCreate(caller.id, callee.id);
    return { dmId: dm.id, callerId: caller.id, calleeId: callee.id };
  }

  /** An ACCEPTED call whose accept happened `agoMs` ago. */
  async function activeCall(agoMs: number): Promise<{ id: string; roomName: string }> {
    const { dmId, callerId, calleeId } = await freshDm();
    const call = await repos.calls.create({ dmId, callerId, calleeId, media: "audio" });
    const active = await repos.calls.setStatus(call.id, "active", {
      startedAt: new Date(Date.now() - agoMs),
    });
    expect(active?.status).toBe("active");
    return { id: call.id, roomName: call.roomName };
  }

  const pushes: Array<{ to: readonly string[]; push: PushNotification }> = [];

  function makeSweeper(
    liveness: CallRoomLivenessReader | null,
    now: () => number = () => Date.now(),
    ejector: VoiceEjector | null = null,
  ): DmCallSweeper {
    const sweeper = createDmCallSweeper({
      repos,
      liveness,
      ejector,
      mutationBus: bus,
      notifier: {
        notify: async () => undefined,
        notifyAlways: async (to, push) => {
          pushes.push({ to, push });
        },
      },
      log: silentLog,
      ringWindowMs: RING_WINDOW_MS,
      // Far longer than any test — every pass in these tests is driven by an
      // explicit `sweepOnce()`, never by the wall clock.
      intervalMs: 60 * 60_000,
      emptyGraceMs: GRACE_MS,
      aloneGraceMs: GRACE_MS,
      now,
    });
    sweepers.push(sweeper);
    return sweeper;
  }

  /** A SERVER (`friend_groups.kind = 'server'`) with one voice channel. */
  async function serverVoiceChannel(): Promise<{ channelId: string; userId: string }> {
    const owner = await repos.users.create({
      username: uniq("swp_srv"),
      displayName: "srv owner",
      passwordHash: "not-used",
    });
    const group = await repos.groups.create({ name: "A Server", ownerId: owner.id });
    expect(group.kind).toBe("server");
    const channel = await repos.channels.create({
      groupId: group.id,
      kind: "voice",
      name: "lobby",
    });
    return { channelId: channel.id, userId: owner.id };
  }

  /** A flat GROUP CHAT (`kind = 'group'`) with a voice channel bound to `room`. */
  async function groupDmVoiceChannel(
    room?: string,
  ): Promise<{ channelId: string; roomName: string; userId: string }> {
    const owner = await repos.users.create({
      username: uniq("swp_gdm"),
      displayName: "gdm owner",
      passwordHash: "not-used",
    });
    const group = await repos.groupChats.create({ name: "Crew", ownerId: owner.id });
    const channel = await repos.channels.createVoiceChannel({
      groupId: group.id,
      name: "call",
      livekitRoom: room ?? null,
    });
    return { channelId: channel.id, roomName: room ?? channel.id, userId: owner.id };
  }

  // =========================================================================
  // THE ONE THAT MUST NEVER REGRESS: a live call is not collateral damage
  // =========================================================================
  it("NEVER ends a call whose LiveKit room is occupied, however long it has run", async () => {
    // A four-hour film night. Age alone must not matter.
    const call = await activeCall(4 * 60 * 60_000);
    const livekit = fakeLiveness(otherLiveRooms);
    livekit.occupy(call.roomName);
    const sweeper = makeSweeper(livekit.reader);

    // The first tick is the post-restart reconciliation — the most aggressive
    // pass there is — and even it must leave an occupied room alone; and so must
    // every later tick, no matter how much time passes.
    await sweeper.sweepOnce();
    await sweeper.sweepOnce();

    const after = await repos.calls.findById(call.id);
    expect(after?.status).toBe("active");
    expect(after?.endedAt).toBeNull();
  });

  it("sweeps nothing when the media plane is unreachable (no evidence ⇒ no action)", async () => {
    const call = await activeCall(6 * 60_000);
    const livekit = fakeLiveness(otherLiveRooms);
    livekit.clear(call.roomName); // this call's room really is empty
    livekit.fail(true); // LiveKit down: an empty answer would be a LIE, not a fact.
    const sweeper = makeSweeper(livekit.reader);

    const result = await sweeper.sweepOnce();
    expect(result.livenessUnavailable).toBe(true);
    expect(result.abandonedCalls).toBe(0);
    expect((await repos.calls.findById(call.id))?.status).toBe("active");

    // Once LiveKit answers again and says the room is empty, the SAME sweeper
    // reaps it — the outage only DEFERRED the reconciliation, it did not forfeit
    // it (a realistic boot ordering has LiveKit come up after the API).
    livekit.fail(false);
    const recovered = await sweeper.sweepOnce();
    expect(recovered.abandonedCalls).toBeGreaterThanOrEqual(1);
    expect((await repos.calls.findById(call.id))?.status).toBe("ended");
  });

  it("sweeps nothing active when no liveness probe is configured at all", async () => {
    const call = await activeCall(6 * 60_000);
    const sweeper = makeSweeper(null);

    const result = await sweeper.sweepOnce();
    expect(result.livenessUnavailable).toBe(true);
    expect(result.abandonedCalls).toBe(0);
    expect((await repos.calls.findById(call.id))?.status).toBe("active");
  });

  // =========================================================================
  // The ghost really does get reaped
  // =========================================================================
  it("closes an accepted call whose room stays empty, and tells both participants", async () => {
    const { dmId, callerId, calleeId } = await freshDm();
    const created = await repos.calls.create({ dmId, callerId, calleeId, media: "audio" });
    await repos.calls.setStatus(created.id, "active", {
      startedAt: new Date(Date.now() - 10 * 60_000),
    });
    const livekit = fakeLiveness(otherLiveRooms);
    // Occupied on the first (reconciling) tick so this test exercises the STEADY
    // -STATE debounce rather than the restart path.
    livekit.occupy(created.roomName);
    let clock = Date.now();
    const sweeper = makeSweeper(livekit.reader, () => clock);
    await sweeper.sweepOnce();
    expect((await repos.calls.findById(created.id))?.status).toBe("active");

    // Everyone drops out of the room. One empty reading is NOT enough — a pair of
    // peers reconnecting must not lose their call.
    livekit.clear(created.roomName);
    await sweeper.sweepOnce();
    expect((await repos.calls.findById(created.id))?.status).toBe("active");

    // Still empty a full grace window later ⇒ nobody is in this call.
    published.length = 0;
    clock += GRACE_MS + 1_000;
    expect((await sweeper.sweepOnce()).abandonedCalls).toBeGreaterThanOrEqual(1);

    const ended = await repos.calls.findById(created.id);
    expect(ended?.status).toBe("ended");
    expect(ended?.endedAt).not.toBeNull();

    // Both sides get the terminal control event, so any client still holding the
    // call surface drops it instead of waiting for a hangup that never comes.
    // Scoped to THIS call id: the sweeper is global and the same tick legitimately
    // closes other suites' expired rings on the shared test database.
    expect(endedRecipients(created.id).sort()).toEqual([callerId, calleeId].sort());
    // …and the DM gets its inline history line, exactly like a real hangup.
    const dm = await repos.dms.findById(dmId, callerId);
    const systemMessages = published.filter(
      (m) => m.channelId === dm?.streamId && m.event.type === SERVER_EVENT.messageCreated,
    );
    expect(systemMessages.length).toBe(1);
  });

  it("reconciles on the FIRST tick: a deploy's ghost calls are gone at boot", async () => {
    // Exactly the founder's row: accepted three days ago, never ended, and its
    // LiveKit room died with the container that hosted it.
    const call = await activeCall(3 * 24 * 60 * 60_000);
    const livekit = fakeLiveness(otherLiveRooms);
    livekit.clear(call.roomName); // its room died with the container that hosted it
    const sweeper = makeSweeper(livekit.reader);

    const result = await sweeper.sweepOnce();
    expect(result.abandonedCalls).toBeGreaterThanOrEqual(1);
    const after = await repos.calls.findById(call.id);
    expect(after?.status).toBe("ended");
    expect(after?.endedAt).not.toBeNull();
  });

  it("reconciliation does NOT reap a call accepted seconds before the restart", async () => {
    // Accepted just now: the participants may not have finished joining the SFU
    // yet, so an empty room proves nothing. It must survive the boot pass.
    const call = await activeCall(2_000);
    const livekit = fakeLiveness(otherLiveRooms);
    livekit.clear(call.roomName); // empty, and that still proves nothing yet
    const sweeper = makeSweeper(livekit.reader);

    await sweeper.sweepOnce();
    expect((await repos.calls.findById(call.id))?.status).toBe("active");
  });

  // =========================================================================
  // Rings
  // =========================================================================
  it("closes rings past their deadline as missed and notifies both sides", async () => {
    const { dmId, callerId, calleeId } = await freshDm();
    const call = await repos.calls.create({
      dmId,
      callerId,
      calleeId,
      media: "audio",
      expiresAt: new Date(Date.now() - 1_000),
    });
    published.length = 0;
    const sweeper = makeSweeper(fakeLiveness(otherLiveRooms).reader);

    const result = await sweeper.sweepOnce();
    expect(result.expiredRings).toBeGreaterThanOrEqual(1);

    const after = await repos.calls.findById(call.id);
    expect(after?.status).toBe("missed");
    expect(after?.endedAt).not.toBeNull();
    // Cleared with the transition so the DTO keeps its contract (a deadline is
    // only meaningful while ringing).
    expect(after?.expiresAt).toBeNull();

    expect(endedRecipients(call.id).sort()).toEqual([callerId, calleeId].sort());

    // The callee's phone gets its ring replaced by the missed-call line.
    const retraction = pushes.find((p) => p.push.data?.["callId"] === call.id);
    expect(retraction?.to).toEqual([calleeId]);
    expect(retraction?.push).toMatchObject({ body: "Missed call", collapseKey: `call:${call.id}` });
  });

  it("leaves a ring alone while it is still inside its window", async () => {
    // The ring pass runs on every tick and writes with the sweeper's own clock, so
    // the one thing it must never do is reach a ring that has not actually expired.
    // (It used to be an UNSCOPED `UPDATE … WHERE status='ringing' AND deadline<now`
    // over the whole table; it is now bounded to the page of live rows the tick
    // read, so a backlog costs one page per tick instead of one table-wide flip
    // plus its entire `call.ended` fan-out in a single pass.)
    const { dmId, callerId, calleeId } = await freshDm();
    const fresh = await repos.calls.create({
      dmId,
      callerId,
      calleeId,
      media: "audio",
      expiresAt: new Date(Date.now() + 30_000),
    });

    const result = await makeSweeper(fakeLiveness(otherLiveRooms).reader).sweepOnce();
    expect(result.livenessUnavailable).toBe(false);

    const after = await repos.calls.findById(fresh.id);
    expect(after?.status).toBe("ringing");
    expect(after?.endedAt).toBeNull();
    expect(after?.expiresAt).not.toBeNull();
  });

  it("still reaps a ringing row that never got a deadline stamped", async () => {
    // A null `expires_at` used to make a ring UN-SWEEPABLE: the old inline sweep
    // required a non-null deadline, so such a row blocked its DM forever through
    // the one-live-call-per-DM index. The fallback is createdAt + ring window.
    const { dmId, callerId, calleeId } = await freshDm();
    const call = await repos.calls.create({
      dmId,
      callerId,
      calleeId,
      media: "audio",
      expiresAt: null,
    });
    expect(call.expiresAt).toBeNull();
    await client.sql`
      update dm_calls set created_at = now() - interval '10 minutes' where id = ${call.id}
    `;
    const sweeper = makeSweeper(fakeLiveness(otherLiveRooms).reader);

    await sweeper.sweepOnce();
    expect((await repos.calls.findById(call.id))?.status).toBe("missed");
  });

  it("leaves a ring that is still inside its window alone", async () => {
    const { dmId, callerId, calleeId } = await freshDm();
    const call = await repos.calls.create({
      dmId,
      callerId,
      calleeId,
      media: "audio",
      expiresAt: new Date(Date.now() + RING_WINDOW_MS),
    });
    const sweeper = makeSweeper(fakeLiveness(otherLiveRooms).reader);

    await sweeper.sweepOnce();
    const after = await repos.calls.findById(call.id);
    expect(after?.status).toBe("ringing");
    expect(after?.expiresAt).not.toBeNull();
  });

  // =========================================================================
  // Alone in a call → auto-leave; alone in a SERVER channel → never
  // =========================================================================
  describe("alone-idle auto-leave", () => {
    it("NEVER ejects someone sitting alone in a SERVER voice channel", async () => {
      // The founder's explicit carve-out, and the one failure mode that would be
      // felt immediately: being thrown out of your own server's voice room while
      // listening to music or just idling there. No amount of elapsed time may
      // change this answer.
      const srv = await serverVoiceChannel();
      const livekit = fakeLiveness(otherLiveRooms);
      livekit.occupy(srv.channelId, [srv.userId]); // alone, in a server channel
      const ej = fakeEjector();
      let clock = Date.now();
      const sweeper = makeSweeper(livekit.reader, () => clock, ej.ejector);

      await sweeper.sweepOnce();
      clock += GRACE_MS * 10; // hours later
      const result = await sweeper.sweepOnce();
      clock += GRACE_MS * 10; // and hours after that
      await sweeper.sweepOnce();

      expect(result.aloneEjections).toBe(0);
      expect(ej.removed).toEqual([]);
    });

    it("ejects the last person in a 1-1 DM call and closes the call row", async () => {
      const { dmId, callerId, calleeId } = await freshDm();
      const call = await repos.calls.create({ dmId, callerId, calleeId, media: "audio" });
      await repos.calls.setStatus(call.id, "active", { startedAt: new Date() });
      const livekit = fakeLiveness(otherLiveRooms);
      livekit.occupy(call.roomName, [callerId]); // the callee already hung up
      const ej = fakeEjector();
      let clock = Date.now();
      const sweeper = makeSweeper(livekit.reader, () => clock, ej.ejector);

      // First sighting only starts the clock — nobody is ejected on the spot.
      await sweeper.sweepOnce();
      expect(ej.removed).toEqual([]);
      expect((await repos.calls.findById(call.id))?.status).toBe("active");

      published.length = 0;
      clock += GRACE_MS + 1_000;
      const result = await sweeper.sweepOnce();

      expect(result.aloneEjections).toBe(1);
      // The microphone is cut at the SOURCE — the client may be asleep and never
      // act on an event, which is exactly why the server does this itself.
      expect(ej.removed).toEqual([[call.roomName, callerId]]);
      // …and the call log closes like any other hang-up, so the DM is not left
      // blocked by the one-live-call-per-DM index.
      const ended = await repos.calls.findById(call.id);
      expect(ended?.status).toBe("ended");
      expect(ended?.endedAt).not.toBeNull();
      expect(endedRecipients(call.id).sort()).toEqual([callerId, calleeId].sort());
    });

    it("ejects the last person in a GROUP-DM voice channel with a typed notice", async () => {
      const gdm = await groupDmVoiceChannel();
      const livekit = fakeLiveness(otherLiveRooms);
      livekit.occupy(gdm.roomName, [gdm.userId]);
      const ej = fakeEjector();
      let clock = Date.now();
      const sweeper = makeSweeper(livekit.reader, () => clock, ej.ejector);

      await sweeper.sweepOnce();
      published.length = 0;
      clock += GRACE_MS + 1_000;
      await sweeper.sweepOnce();

      expect(ej.removed).toEqual([[gdm.roomName, gdm.userId]]);
      const notices = published.filter(
        (m) => m.event.type === SERVER_EVENT.voiceDisconnected && m.userId === gdm.userId,
      );
      expect(notices).toHaveLength(1);
      expect(notices[0]!.event.payload).toMatchObject({
        roomId: gdm.roomName,
        channelId: gdm.channelId,
        reason: "alone",
      });
    });

    it("treats an UPGRADED call's group voice channel as a call surface, not a server", async () => {
      // After a seamless upgrade the live call room is pinned to a group voice
      // channel (`channels.livekit_room = dmcall:<id>`). Classifying that by room
      // name alone would be a guess; it is resolved through the override.
      const room = "dmcall:11111111-2222-3333-4444-555555555555";
      const gdm = await groupDmVoiceChannel(room);
      const livekit = fakeLiveness(otherLiveRooms);
      livekit.occupy(room, [gdm.userId]);
      const ej = fakeEjector();
      let clock = Date.now();
      const sweeper = makeSweeper(livekit.reader, () => clock, ej.ejector);

      await sweeper.sweepOnce();
      clock += GRACE_MS + 1_000;
      await sweeper.sweepOnce();

      expect(ej.removed).toEqual([[room, gdm.userId]]);
    });

    it("restarts the idle window the moment someone rejoins (network blip tolerance)", async () => {
      const gdm = await groupDmVoiceChannel();
      const livekit = fakeLiveness(otherLiveRooms);
      livekit.occupy(gdm.roomName, [gdm.userId]);
      const ej = fakeEjector();
      let clock = Date.now();
      const sweeper = makeSweeper(livekit.reader, () => clock, ej.ejector);

      await sweeper.sweepOnce(); // alone since t0

      // The peer's connection came back before the window elapsed.
      clock += GRACE_MS - 1_000;
      livekit.occupy(gdm.roomName, [gdm.userId, "peer-returned"]);
      await sweeper.sweepOnce();

      // They drop again. The counter must start over from HERE, not resume the
      // earlier streak — otherwise a reconnect a second later would still eject.
      livekit.occupy(gdm.roomName, [gdm.userId]);
      await sweeper.sweepOnce();
      clock += GRACE_MS - 1_000;
      await sweeper.sweepOnce();
      expect(ej.removed).toEqual([]);

      // …and the fresh window still completes on its own.
      clock += 2_000;
      await sweeper.sweepOnce();
      expect(ej.removed).toEqual([[gdm.roomName, gdm.userId]]);
    });

    it("does nothing at all without an SFU admin (never announce what we cannot enforce)", async () => {
      const gdm = await groupDmVoiceChannel();
      const livekit = fakeLiveness(otherLiveRooms);
      livekit.occupy(gdm.roomName, [gdm.userId]);
      let clock = Date.now();
      const sweeper = makeSweeper(livekit.reader, () => clock, null);

      await sweeper.sweepOnce();
      published.length = 0;
      clock += GRACE_MS * 4;
      const result = await sweeper.sweepOnce();

      expect(result.aloneEjections).toBe(0);
      expect(
        published.filter((m) => m.event.type === SERVER_EVENT.voiceDisconnected),
      ).toHaveLength(0);
    });

    it("leaves a room with two people in it alone forever", async () => {
      const gdm = await groupDmVoiceChannel();
      const livekit = fakeLiveness(otherLiveRooms);
      livekit.occupy(gdm.roomName, [gdm.userId, "the-other-one"]);
      const ej = fakeEjector();
      let clock = Date.now();
      const sweeper = makeSweeper(livekit.reader, () => clock, ej.ejector);

      await sweeper.sweepOnce();
      clock += GRACE_MS * 5;
      await sweeper.sweepOnce();

      expect(ej.removed).toEqual([]);
    });
  });

  // =========================================================================
  // expires_at — why every production row read back as NULL
  // =========================================================================
  it("stamps expires_at while ringing and clears it on accept (hence NULL in prod)", async () => {
    const { dmId, callerId, calleeId } = await freshDm();
    const deadline = new Date(Date.now() + RING_WINDOW_MS);
    const call = await repos.calls.create({
      dmId,
      callerId,
      calleeId,
      media: "audio",
      expiresAt: deadline,
    });

    // The column really is written — a re-read from Postgres, not the insert DTO.
    const reread = await repos.calls.findById(call.id);
    expect(reread?.expiresAt).not.toBeNull();
    expect(new Date(reread!.expiresAt!).getTime()).toBe(deadline.getTime());

    // …and any move off `ringing` clears it. That is why a snapshot of live
    // production rows (all of them `active`, or terminal) shows expires_at NULL
    // everywhere: the deadline only exists for the ~30s a call is actually
    // ringing. It was never a missing write.
    const accepted = await repos.calls.setStatus(call.id, "active", { startedAt: new Date() });
    expect(accepted?.expiresAt).toBeNull();
    expect((await repos.calls.findById(call.id))?.expiresAt).toBeNull();
  });
});
