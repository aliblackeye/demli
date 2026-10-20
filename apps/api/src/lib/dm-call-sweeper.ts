/**
 * DM-call liveness sweeper — the backstop that guarantees NO call row can stay
 * live forever (founder P0, 2026-07-27: two `dm_calls` rows stuck `status=active,
 * ended_at IS NULL`, one of them THREE DAYS old, which kept re-seeding the client
 * call FSM on every reconnect → a ring that would not stop).
 *
 * WHY THIS EXISTS — every pre-existing termination path needs a LIVE CLIENT to
 * author it: reject / cancel / hangup / upgrade are all HTTP endpoints, and the
 * only automatic reaper was a lazy, per-DM, `ringing`-only sweep inside
 * `POST /dm-calls` (modules/dm-calls/index.ts). So an ACCEPTED call whose two
 * participants both vanished — app killed, machine slept, network gone, or a
 * DEPLOY restarting everything mid-call — had literally no path to `ended_at`.
 * That is the whole bug; this module closes it.
 *
 * THE CRITERION IS LIVENESS, NOT AGE. A call may legitimately run for hours (a
 * film night), so "old ⇒ dead" would cut real conversations. The only honest
 * source of truth for "is anyone actually in this call" is the MEDIA PLANE:
 * LiveKit's room `dmcall:<callId>` (ADR 0012 §2 — the room name is a pure
 * function of the call id). Rules that follow from that:
 *
 *  - `ringing` rows need no probe at all. A ring has a server-issued deadline and
 *    the accept endpoint itself refuses a late accept, so past-deadline ⇒ missed.
 *  - `active` rows are closed ONLY when their LiveKit room is absent/empty, and
 *    only after it has looked that way CONTINUOUSLY for {@link DEFAULT_EMPTY_GRACE_MS}.
 *    One momentary reading of zero participants (both peers reconnecting, an SFU
 *    node blip) must never end a live call.
 *  - If LiveKit itself is UNREACHABLE we sweep NOTHING active. An unavailable
 *    media plane is not evidence that rooms are empty — fabricating "empty" here
 *    is precisely how a sweeper would kill a healthy call. (Same rule the voice
 *    occupancy reader already follows.)
 *
 * RESTART RECONCILIATION is the same tick, seeded differently: on the FIRST tick
 * after boot the process has no observation history, so an empty room's "empty
 * since" is taken to be the call's own `startedAt`. A row that survived a restart
 * and whose room is empty is therefore closed immediately, while a genuinely live
 * call — whose room is still occupied, because LiveKit is a separate container
 * that outlives an API deploy — is untouched. When the deploy restarts LiveKit
 * too, every room really is gone and every ghost row is reaped at once: exactly
 * the founder's scenario.
 *
 * THE ALONE-IDLE PASS is the same question asked one participant later, and the
 * founder's own framing: a call you are the last person in is a call that ended,
 * you just have not hung up yet. So the same tick ejects the last participant of a
 * DM call or a GROUP-DM voice channel after {@link DEFAULT_ALONE_GRACE_MS} — and
 * pointedly NOT of a server voice channel, where sitting alone is a legitimate
 * thing to do all day. That distinction is resolved from `friend_groups.kind` in
 * the database ({@link classifyVoiceRoom}), never guessed from a room name, and
 * anything unrecognized is left alone.
 *
 * Schedule/lifecycle mirrors {@link ./account-purge.ts}: started only in the
 * long-running server, `unref`'d, cleared on graceful shutdown, and every tick
 * fully guarded so a failure is logged and never thrown.
 */

import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { ParticipantInfo_State, RoomServiceClient } from "livekit-server-sdk";
import type { RealtimeMutationPublisher, Repositories } from "@demli/db";
import { callMissedPush, resolveMissedCallDm, type OfflineNotifier } from "@demli/notifications";
import { serverEvent } from "@demli/protocol";
import type { CallId, DmCall, UserId } from "@demli/types";
import { livekitHttpUrl } from "../modules/media/voice-session.js";
import { postDmCallSystemMessage, type DmCallOutcomeToken } from "./dm-call-system-messages.js";

/** How often the sweeper looks at the live rows. */
export const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/**
 * How long an `active` call's room must look EMPTY before the call is closed.
 *
 * Sized against the failure it must not cause. LiveKit needs ~10-20s to notice a
 * participant is gone, and a client that loses its network recovers a media
 * session within seconds-to-tens-of-seconds; three minutes of BOTH participants
 * being absent from the SFU is no longer a call by any definition, while still
 * being far outside the range of any normal reconnect. Deliberately not shorter:
 * the cost of sweeping too eagerly (cutting a live conversation) is much worse
 * than the cost of sweeping late (a ghost row lingering a few extra minutes).
 */
export const DEFAULT_EMPTY_GRACE_MS = 3 * 60_000;

/**
 * How long the LAST person in a CALL surface may sit alone before the server ends
 * it for them (founder request: "özel aramada ya da grup seslisinde yalnız
 * kalınca belli bir süre sonra otomatik çıkarsın").
 *
 * Three minutes, the same window as {@link DEFAULT_EMPTY_GRACE_MS}, because the
 * two answer the same question with the same evidence and one number is far
 * easier to reason about than two. Sized by the two ways it can be wrong:
 *  - TOO SHORT and a peer whose network died — phone locked, app restarting,
 *    train tunnel — comes back to find the call gone and the other person ejected.
 *    A cold app restart plus re-auth plus an SFU join is comfortably under a
 *    minute, so three gives that a wide margin.
 *  - TOO LONG and a forgotten open microphone keeps publishing to a room nobody
 *    is in. Three minutes bounds that.
 *
 * NEVER applies to a server voice channel — see {@link classifyVoiceRoom}.
 */
export const DEFAULT_ALONE_GRACE_MS = 3 * 60_000;

/**
 * Probe over the media plane — the ONLY source of truth for who is actually in a
 * room. Deliberately narrow so production wires a bare LiveKit
 * `RoomServiceClient` and tests inject plain functions with no SFU anywhere.
 *
 * BOTH methods MUST THROW when the media plane could not be reached. Answering
 * "no rooms" for "I don't know" would read as "every call is abandoned" and end
 * live calls — the single worst failure this whole module can have.
 */
export interface CallRoomLivenessReader {
  /**
   * Every room the SFU currently holds → its participant count. Unfiltered on
   * purpose: the alone-idle sweep starts from rooms the database has no live row
   * for (an upgraded group's voice channel), so it cannot pre-name them.
   */
  rooms(): Promise<Map<string, number>>;
  /** The participant identities (= user ids) in one room. */
  participants(roomName: string): Promise<string[]>;
}

/** The SFU capability needed to actually cut a lone participant's media. */
export type VoiceEjector = Pick<RoomServiceClient, "removeParticipant">;

/**
 * What KIND of surface a live LiveKit room is. The whole point of the alone-idle
 * sweep hinges on this, so it is resolved from the database, never guessed from
 * the room name:
 *
 * - `call`     — a DM call room (`dmcall:<id>`) with no channel bound to it yet.
 * - `groupDm`  — a voice channel belonging to a flat group chat or a DM
 *                (`friend_groups.kind` ∈ {group, dm}) — including the voice
 *                channel a seamless upgrade pins to a `dmcall:` room.
 * - `server`   — a voice channel of a real server (`kind = server`). NEVER ejected:
 *                sitting alone in one is legitimate (music, "I'm here"), which is
 *                exactly the founder's carve-out.
 * - `unknown`  — the room resolves to nothing we recognize. Treated like `server`
 *                (hands off), because an unrecognized room is the one case where
 *                acting could hurt someone for reasons we cannot see.
 */
export type VoiceRoomKind = "call" | "groupDm" | "server" | "unknown";

export interface VoiceRoomClassification {
  kind: VoiceRoomKind;
  /** The voice channel this room belongs to, when there is one. */
  channelId: string | null;
}

/** `dmcall:<uuid>` — the room-name shape a DM call mints (ADR 0012 §2). */
const DM_CALL_ROOM_PREFIX = "dmcall:";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve a live SFU room to the surface it belongs to (see {@link VoiceRoomKind}).
 *
 * Resolution order mirrors the media-token path's `room = livekitRoom ?? id`, in
 * reverse: an explicit `livekit_room` override wins, then the room name as a
 * channel id, and only a room that matches NEITHER is judged by its name. The
 * uuid guard exists because the room name is external input — handing arbitrary
 * text to a uuid-typed lookup is a database error, not a miss.
 */
export async function classifyVoiceRoom(
  repos: Repositories,
  roomName: string,
): Promise<VoiceRoomClassification> {
  const channel =
    (await repos.channels.findByLivekitRoom(roomName)) ??
    (UUID_RE.test(roomName) ? await repos.channels.findById(roomName as never) : null);
  if (channel) {
    const group = await repos.groups.findById(channel.groupId);
    if (!group) return { kind: "unknown", channelId: channel.id };
    // The ONE branch the founder must be able to trust: a server voice channel is
    // never idle-ejected, however long someone sits in it alone.
    if (group.kind === "server") return { kind: "server", channelId: channel.id };
    return { kind: "groupDm", channelId: channel.id };
  }
  // A `dmcall:` room with no channel bound to it is a plain 1-1 DM call.
  if (roomName.startsWith(DM_CALL_ROOM_PREFIX)) return { kind: "call", channelId: null };
  return { kind: "unknown", channelId: null };
}

export interface DmCallSweeperOptions {
  repos: Repositories;
  /**
   * Media-plane liveness probe. When absent, `active` rows are NEVER swept (only
   * expired rings are) — a deliberately conservative default so a deployment
   * without LiveKit admin credentials degrades to "no automatic hangup" rather
   * than "hang up everything".
   */
  liveness?: CallRoomLivenessReader | null;
  /**
   * SFU admin used to cut a lone participant's media. Without it the alone-idle
   * sweep is OFF entirely (not "notify but leave the mic open") — telling someone
   * they were disconnected while their microphone keeps publishing would be worse
   * than doing nothing.
   */
  ejector?: VoiceEjector | null;
  /** Publishes the `call.ended` fan-out + the DM system message. */
  mutationBus?: RealtimeMutationPublisher;
  /**
   * Replaces an expired ring on the callee's phone with the missed-call line —
   * the push the caller's own cancel would have sent. Omitted ⇒ no push.
   */
  notifier?: OfflineNotifier;
  log: FastifyBaseLogger;
  /** Ring window used as the deadline fallback for rows with no `expires_at`. */
  ringWindowMs: number;
  intervalMs?: number;
  emptyGraceMs?: number;
  aloneGraceMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface DmCallSweeper {
  /** Run one pass now (also what the interval calls). Never throws. */
  sweepOnce(): Promise<DmCallSweepResult>;
  /** Stop the interval. */
  stop(): void;
}

export interface DmCallSweepResult {
  /** Rings closed as `missed` because their deadline had passed. */
  expiredRings: number;
  /** Accepted calls closed as `ended` because their room was empty. */
  abandonedCalls: number;
  /** Lone participants ejected from a call surface after the idle window. */
  aloneEjections: number;
  /** True when the media plane could not be probed, so no `active` row was swept. */
  livenessUnavailable: boolean;
}

/**
 * Create the sweeper. `start` is separate from construction so tests can drive
 * {@link DmCallSweeper.sweepOnce} deterministically without a timer.
 */
export function createDmCallSweeper(options: DmCallSweeperOptions): DmCallSweeper {
  const {
    repos,
    mutationBus,
    notifier,
    log,
    ringWindowMs,
    liveness = null,
    ejector = null,
    intervalMs = DEFAULT_SWEEP_INTERVAL_MS,
    emptyGraceMs = DEFAULT_EMPTY_GRACE_MS,
    aloneGraceMs = DEFAULT_ALONE_GRACE_MS,
    now = () => Date.now(),
  } = options;

  /**
   * `callId → epoch ms at which its room was FIRST seen empty`. Cleared the
   * moment the room is occupied again, so a call only ever accumulates
   * CONTINUOUS emptiness. Process-local on purpose: it is a debounce, not a
   * source of truth, and the boot seeding below covers what a fresh process
   * cannot remember.
   */
  const emptySince = new Map<CallId, number>();

  /**
   * `roomName → since when exactly ONE person has been in it, plus what kind of
   * surface it is`. Same debounce shape as {@link emptySince}, and the reason a
   * peer's 10-second network blip costs nobody their call: the entry is deleted
   * the instant the room is not solo, so the window restarts from scratch when
   * they come back. The classification is cached with it so a solo room costs at
   * most one pair of lookups per solo streak, not one per tick.
   */
  const aloneSince = new Map<string, { since: number; room: VoiceRoomClassification }>();

  /** First tick of this process ⇒ apply restart reconciliation seeding. */
  let firstTick = true;

  async function sweepOnce(): Promise<DmCallSweepResult> {
    const result: DmCallSweepResult = {
      expiredRings: 0,
      abandonedCalls: 0,
      aloneEjections: 0,
      livenessUnavailable: false,
    };
    const reconciling = firstTick;
    const at = new Date(now());

    // ONE read of the live rows feeds every pass below. Reading first also BOUNDS
    // every write to that page: no pass issues an UPDATE whose reach is "every row
    // in this state", so a backlog costs one page per tick instead of one tick that
    // rewrites the table and floods the bus with its fan-out.
    let live: DmCall[];
    try {
      live = await repos.calls.listLive();
    } catch (err) {
      log.error({ err }, "dm-call sweep: reading live calls failed");
      return result;
    }

    // 1) Expired rings — no probe needed, the deadline IS the criterion. The
    //    deadline is re-checked inside the UPDATE, so a row that was accepted
    //    between this read and the write is left alone.
    try {
      const ringing = live.filter((call) => call.status === "ringing").map((call) => call.id);
      const missed = await repos.calls.expireRinging(ringing, at, ringWindowMs);
      result.expiredRings = missed.length;
      for (const call of missed) {
        await announceSwept(call, "timeout", "call_missed");
        await retractRing(call);
      }
      if (missed.length > 0) {
        log.info(`dm-call sweep: closed ${missed.length} expired ring(s)`);
      }
    } catch (err) {
      log.error({ err }, "dm-call sweep: expiring rings failed");
    }

    // 2) ONE media-plane snapshot feeds both remaining passes, so "who is in this
    //    room" is answered identically for both and costs one round trip.
    if (!liveness) {
      result.livenessUnavailable = true;
      return result;
    }
    let rooms: Map<string, number>;
    try {
      rooms = await liveness.rooms();
    } catch (err) {
      // The media plane is the ONLY evidence we accept. Unreachable ⇒ we know
      // nothing ⇒ we end nothing. Never fabricate "empty".
      log.warn({ err }, "dm-call sweep: media plane unreachable — skipping this pass");
      result.livenessUnavailable = true;
      return result;
    }
    // The restart reconciliation is spent only once we have actually SEEN the
    // media plane. If LiveKit was still coming up during the first tick (a
    // realistic ordering on a full `docker compose up`), clearing the flag
    // unconditionally would silently forfeit the reconciliation and leave every
    // ghost row from that deploy to expire the slow way.
    firstTick = false;

    try {
      result.abandonedCalls = await sweepAbandoned(live, at, reconciling, rooms);
    } catch (err) {
      log.error({ err }, "dm-call sweep: abandoned-call pass failed");
    }
    try {
      result.aloneEjections = await sweepAlone(at, rooms);
    } catch (err) {
      log.error({ err }, "dm-call sweep: alone-idle pass failed");
    }
    return result;
  }

  /** Accepted calls whose LiveKit room holds NOBODY → close the row. */
  async function sweepAbandoned(
    live: readonly DmCall[],
    at: Date,
    reconciling: boolean,
    rooms: Map<string, number>,
  ): Promise<number> {
    const active = live.filter((call) => call.status === "active");
    // Forget bookkeeping for calls that are no longer live at all, so the map
    // cannot grow without bound across a long-running process.
    const liveIds = new Set(active.map((call) => call.id));
    for (const id of [...emptySince.keys()]) {
      if (!liveIds.has(id)) emptySince.delete(id);
    }
    if (active.length === 0) return 0;

    const nowMs = at.getTime();
    const abandoned: CallId[] = [];
    for (const call of active) {
      if ((rooms.get(call.roomName) ?? 0) > 0) {
        emptySince.delete(call.id);
        continue;
      }
      // First sighting of an empty room: remember WHEN. On the first tick after a
      // restart we have no history, so an already-accepted call is credited with
      // having been empty since it started — that is the restart reconciliation,
      // and it is safe precisely because an occupied room short-circuits above.
      const seededAt = reconciling ? startedAtMs(call, nowMs) : nowMs;
      const since = emptySince.get(call.id) ?? seededAt;
      emptySince.set(call.id, since);
      if (nowMs - since >= emptyGraceMs) abandoned.push(call.id);
    }
    if (abandoned.length === 0) return 0;

    const ended = await repos.calls.endAbandoned(abandoned, at);
    for (const call of ended) {
      emptySince.delete(call.id);
      await announceSwept(call, "hung_up", "call_ended", durationSeconds(call, at));
    }
    if (ended.length > 0) {
      log.info(`dm-call sweep: closed ${ended.length} abandoned call(s) (empty LiveKit room)`);
    }
    return ended.length;
  }

  /**
   * The last person in a CALL surface has been alone past the idle window → end it
   * for them (founder request). A SERVER voice channel is never touched, and that
   * is enforced by {@link classifyVoiceRoom} reading the group's kind out of the
   * database, not by pattern-matching a room name.
   *
   * The server, not the client, is the actor here: the whole point is to stop a
   * microphone that its owner has walked away from, and a client that has been
   * left running (minimized, asleep, backgrounded on a phone) is exactly the one
   * that will not act. The SFU force-remove is what actually cuts the media; the
   * events are only so the UI can explain what happened.
   */
  async function sweepAlone(at: Date, rooms: Map<string, number>): Promise<number> {
    // No SFU admin ⇒ the feature is OFF. Announcing a disconnect we cannot enforce
    // would leave the microphone publishing — worse than doing nothing.
    if (!ejector || !liveness) return 0;
    const nowMs = at.getTime();

    // Any room that is no longer solo restarts its window from zero. This IS the
    // reconnect tolerance: a peer who drops and comes back wipes the counter, so a
    // ten-second blip never starts an eviction clock that outlives it.
    for (const roomName of [...aloneSince.keys()]) {
      if (rooms.get(roomName) !== 1) aloneSince.delete(roomName);
    }

    let ejected = 0;
    for (const [roomName, count] of rooms) {
      if (count !== 1) continue;
      let entry = aloneSince.get(roomName);
      if (!entry) {
        entry = { since: nowMs, room: await classifyVoiceRoom(repos, roomName) };
        aloneSince.set(roomName, entry);
      }
      // A server voice channel (or anything we cannot identify) is tracked but
      // never acted on — the founder must be able to sit in one indefinitely.
      if (entry.room.kind === "server" || entry.room.kind === "unknown") continue;
      if (nowMs - entry.since < aloneGraceMs) continue;

      let identities: string[];
      try {
        identities = await liveness.participants(roomName);
      } catch (err) {
        log.warn({ err }, `dm-call sweep: participants(${roomName}) failed — leaving it alone`);
        continue;
      }
      // Re-verify against the fresher read: someone may have joined between the
      // room snapshot and now, in which case this is no longer a solo room.
      if (identities.length !== 1) {
        aloneSince.delete(roomName);
        continue;
      }
      const userId = identities[0] as UserId;
      await ejectLoneParticipant(roomName, userId, entry.room, at);
      aloneSince.delete(roomName);
      ejected += 1;
    }
    if (ejected > 0) {
      log.info(`dm-call sweep: ejected ${ejected} participant(s) left alone in a call`);
    }
    return ejected;
  }

  /**
   * Cut one lone participant's media and tell them why. A live DM call also has
   * its row closed through the normal terminal path, so the call log and the
   * inline DM history line read exactly like a hang-up — which is what it is.
   */
  async function ejectLoneParticipant(
    roomName: string,
    userId: UserId,
    room: VoiceRoomClassification,
    at: Date,
  ): Promise<void> {
    // Close the call row FIRST when there is one, so the DM is unblocked even if
    // the SFU call below fails.
    const call = (await repos.calls.listLive()).find(
      (c) => c.roomName === roomName && c.status === "active",
    );
    if (call) {
      const [ended] = await repos.calls.endAbandoned([call.id], at);
      if (ended) {
        await announceSwept(ended, "hung_up", "call_ended", durationSeconds(ended, at));
      }
    }

    // The AUTHORITATIVE teardown (mirrors the moderation voice-disconnect path):
    // best-effort, because the participant may already be gone, and a failure here
    // must never abort the rest of the sweep.
    try {
      await ejector?.removeParticipant(roomName, userId);
    } catch (err) {
      log.info(
        { err },
        `dm-call sweep: removeParticipant(${roomName}) failed — the client leaves on its own`,
      );
    }

    // A channel-backed surface (a group-DM voice channel, including an upgraded
    // call's) has no call row to signal with, so the user-scoped voice notice is
    // what lets their client leave cleanly and say why.
    if (room.channelId) {
      await mutationBus?.publish({
        userId,
        event: serverEvent.voiceDisconnected({
          roomId: roomName as never,
          channelId: room.channelId as never,
          reason: "alone",
        }),
      });
    }
  }

  /**
   * Tell BOTH participants the call is over and write the inline DM history line.
   * Both are best-effort: the row is already closed, which is what unblocks the
   * DM and stops any client that re-reads it.
   */
  async function announceSwept(
    call: DmCall,
    reason: "timeout" | "hung_up",
    token: DmCallOutcomeToken,
    seconds?: number,
  ): Promise<void> {
    for (const userId of participantsOf(call)) {
      await mutationBus?.publish({
        userId,
        event: serverEvent.callEnded({ callId: call.id, reason }),
      });
    }
    await writeSweptSystemMessage(call, token, seconds);
  }

  /** Best-effort: a push failure never stops the sweep. */
  async function retractRing(call: DmCall): Promise<void> {
    if (!notifier) return;
    try {
      const caller = await repos.users.findById(call.callerId);
      if (!caller) return;
      await notifier.notifyAlways(
        [call.calleeId],
        callMissedPush({
          callerName: caller.displayName,
          callId: call.id,
          reason: "timeout",
          dm: await resolveMissedCallDm(repos.dms, call),
        }),
      );
    } catch (err) {
      log.warn({ err, callId: call.id }, "dm-call sweep: ring retraction push failed");
    }
  }

  async function writeSweptSystemMessage(
    call: DmCall,
    token: DmCallOutcomeToken,
    seconds?: number,
  ): Promise<void> {
    try {
      // `findById` is participant-scoped, so read the DM relative to the caller
      // (always one of its two members) to reach the hidden stream channel.
      const dm = await repos.dms.findById(call.dmId, call.callerId);
      if (!dm) return;
      await postDmCallSystemMessage({
        repos,
        mutationBus,
        log,
        dmId: call.dmId,
        streamId: dm.streamId,
        memberIds: [call.callerId, call.calleeId],
        authorId: call.callerId,
        token,
        durationSeconds: seconds,
      });
    } catch (err) {
      log.error({ err, callId: call.id }, "dm-call sweep: system message write failed");
    }
  }

  const timer = setInterval(() => {
    void sweepOnce();
  }, intervalMs);
  timer.unref?.();

  return {
    sweepOnce,
    stop: () => clearInterval(timer),
  };
}

/**
 * Production liveness probe: LiveKit's own room list. A room that does not exist
 * (the SFU drops empty rooms) and a room with zero participants are the same
 * answer — nobody is in the call.
 *
 * `listRooms()` is UNFILTERED because the alone-idle pass starts from rooms the
 * database has no live row for (an upgraded call's group voice channel, every
 * server voice channel), so it cannot name them up front. `listParticipants` is
 * then called only for the handful of rooms we are about to act on.
 *
 * Mirrors {@link ../modules/voice/index.createVoiceOccupancyReader}: same admin
 * credentials, same `ws(s)→http(s)` host conversion, always constructible so a
 * wrong host degrades to "probe throws ⇒ sweep skipped", never a boot failure.
 */
export function createLiveKitCallLiveness(server: FastifyInstance): CallRoomLivenessReader {
  const roomService = new RoomServiceClient(
    livekitHttpUrl(server.apiEnv.livekitUrl),
    server.apiEnv.livekitApiKey,
    server.apiEnv.livekitApiSecret,
  );
  return {
    // Any failure PROPAGATES on purpose — the caller treats a throw as "no
    // evidence" and sweeps nothing, which is the only safe reading.
    async rooms(): Promise<Map<string, number>> {
      const list = await roomService.listRooms();
      const counts = new Map<string, number>();
      for (const room of list) counts.set(room.name, room.numParticipants);
      return counts;
    },
    async participants(roomName: string): Promise<string[]> {
      const list = await roomService.listParticipants(roomName);
      return list
        .filter((p) => p.state !== ParticipantInfo_State.DISCONNECTED)
        .map((p) => p.identity);
    },
  };
}

function participantsOf(call: DmCall): UserId[] {
  return [call.callerId, call.calleeId];
}

/** `startedAt` in epoch ms, falling back to `createdAt`, then to `now`. */
function startedAtMs(call: DmCall, fallback: number): number {
  const stamp = call.startedAt ?? call.createdAt;
  const parsed = stamp ? new Date(stamp).getTime() : Number.NaN;
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** Talk time for the history line; 0 when the call never recorded an accept. */
function durationSeconds(call: DmCall, endedAt: Date): number {
  if (!call.startedAt) return 0;
  const started = new Date(call.startedAt).getTime();
  if (Number.isNaN(started)) return 0;
  return Math.max(0, (endedAt.getTime() - started) / 1000);
}
