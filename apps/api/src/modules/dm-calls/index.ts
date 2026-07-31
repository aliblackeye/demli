import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AccessToken } from "livekit-server-sdk";
import type { RealtimeMutationPublisher } from "@demli/db";
import type { OfflineNotifier, PushNotification } from "@demli/notifications";
import {
  serverEvent,
  type DmCallActiveResponse,
  type DmCallMediaCredential,
  type DmCallSide,
  type DmCallTokenResponse,
} from "@demli/protocol";
import type {
  CallEndReason,
  CallStatus,
  CallTarget,
  DmCall,
  User,
  UserId,
} from "@demli/types";
import { ApiError, errorBody, parseWith } from "../../errors.js";
import { assertNotBlocked } from "../../lib/blocks.js";
import type { CallRoomLivenessReader } from "../../lib/dm-call-sweeper.js";
import {
  postDmCallSystemMessage,
  type DmCallOutcomeToken,
} from "../../lib/dm-call-system-messages.js";
import { requireUser } from "../../plugins/auth.js";
import { MEDIA_TOKEN_TTL_SECONDS } from "../media/index.js";
import type { VoiceSessionRegistry } from "../media/voice-session.js";
import { userRateLimit } from "../../lib/rate-limit.js";

/**
 * DM-call lifecycle + token minting (ADR 0012 / plan Wave 2).
 *
 * Three cleanly separated planes:
 *   - CONTROL   : these HTTP endpoints (start / accept / reject / cancel / hangup
 *                 / upgrade) — they run the mutual-friend gate, write the call
 *                 log, mint LiveKit tokens, and rate-limit.
 *   - NOTIFY    : user-scoped `call.*` events over the mutation bus; the gateway
 *                 forwards them generically (no new routing — ADR 0012 §4).
 *   - MEDIA     : LiveKit room `dmcall:<callId>` — audio/video NEVER touches
 *                 WebSocket (§10/§35). Tokens are minted ONLY through this gated
 *                 lifecycle; there is deliberately no arbitrary-room endpoint.
 *
 * Every endpoint re-checks the LIVE accepted friendship (a DM survives unfriend,
 * so DM membership is not proof of friendship, ADR 0012 §3) and is rate-limited
 * per session. Single-session (§5) falls out for free: the call room is just a
 * room string, so `recordAndEvict` evicts a prior group-voice session on join.
 *
 * ## Connection reliability (call-UX plan 2026-07-30, K2)
 *
 * The two planes are independent transports, so their messages CROSS. The callee
 * is rung over its socket and can accept before the caller's own `POST /dm-calls`
 * response lands; a caller whose media then fails sends a teardown for a call the
 * server already considers accepted. Three rules keep that from producing a live
 * row nobody is in — the founder's "accepted but never connected", which used to
 * be escapable only via the 3-6 minute sweeper:
 *
 *  1. NO lifecycle response waits on a push round-trip (`dispatchCallPush`), so
 *     the caller learns its own call id before a third party can slow it down.
 *  2. `GET /dm-calls/active` answers "what call am I in?" from the database, so a
 *     client that missed or out-ordered an event re-seats instead of dropping it.
 *  3. Every terminal/accept transition is guarded ON THE STATUS IN SQL
 *     (`closeIfIn` / `activateIfRinging`), and a teardown for an already-closed —
 *     or already-ACCEPTED — call closes it idempotently instead of 409ing. A
 *     refused teardown is how a row got stuck live in the first place.
 */

/** Ring deadline window (ADR 0012 §4, default 30s). */
export const RING_TIMEOUT_SECONDS = 30;

/**
 * How long a call push may take before we say so in the log (call-UX plan K2.1).
 *
 * Call pushes are dispatched FIRE-AND-FORGET: no lifecycle response ever waits on
 * the Expo round-trip, so this is not a request budget — it is an observability
 * budget. It exists because the previous code awaited the push, which is how a
 * slow provider became a several-second `POST /dm-calls` and opened the window
 * where the callee accepted before the caller had its own 201. Un-awaiting that
 * work must not turn a broken push channel into silence, so a dispatch that
 * outlives this window (or fails outright) is logged.
 */
export const CALL_PUSH_SLOW_MS = 5_000;

/**
 * Per-DM start cooldown (security F2). After the SAME caller's most recent
 * UN-ANSWERED attempt in a DM (missed | declined | canceled), a fresh start is
 * throttled for this long. This bounds start+cancel ring churn to one ring per
 * window even across multiple sessions — the per-session rate limit alone caps
 * a single token's budget, so N sessions would otherwise get N× the churn. An
 * ANSWERED call (`ended` / `upgraded`) never triggers it, so an immediate
 * call-back after a real conversation still connects. Tuned via the reported
 * ~6s re-ring window (F2); 10s comfortably closes it.
 */
export const START_COOLDOWN_MS = 10_000;

/**
 * Terminal statuses reachable WITHOUT the callee accepting — i.e. the ones a
 * caller can produce alone (cancel / timeout / the callee declining), which is
 * exactly the churn surface the cooldown throttles. `ended`/`upgraded` require
 * an accept, so they are deliberately excluded (call-back stays instant).
 */
const UNANSWERED_TERMINAL_STATUSES: readonly CallStatus[] = ["missed", "declined", "canceled"];

/**
 * How long the `inRoom` media-plane probe may take before `GET /dm-calls/active`
 * gives up on it and answers `null` (ADR 0023 §3).
 *
 * The resync read is on the critical path of every socket reconnect, and the
 * probe is an ADVISORY extra: without it the client falls back to the cautious
 * "I might be in this room on another device" branch, which costs one button
 * press. With no bound, a wedged SFU admin API would instead hang the one
 * request a client uses to escape a broken call — trading a cheap degradation
 * for the expensive one. Generous next to a healthy LiveKit (single-digit ms on
 * the same host) and far under any client-side request timeout.
 */
export const IN_ROOM_PROBE_TIMEOUT_MS = 1_500;

const startCallSchema = z.object({
  dmId: z.string().uuid("Invalid DM id."),
  media: z.enum(["audio", "video"]),
});

const callParamsSchema = z.object({
  id: z.string().uuid("Invalid call id."),
});

/**
 * Cancel body. `reason` distinguishes a manual withdraw (`canceled`) from the
 * caller-client ring timer firing (`timeout` → the call is logged `missed`).
 * Optional/blank-tolerant so a bare cancel defaults to a manual withdraw.
 */
const cancelSchema = z.object({
  reason: z.enum(["canceled", "timeout"]).optional(),
});

const upgradeSchema = z.object({
  inviteeUserId: z.string().uuid("Invalid invitee id."),
});

/**
 * Recent-calls query (Voice-UX #2). `limit` is coerced from the query string and
 * clamped 1..50 (the repo re-clamps authoritatively); `before` is the opaque
 * keyset cursor from a previous page's `nextCursor`. Both optional — a bare call
 * returns the first page at the default size.
 */
const recentCallsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  before: z.string().min(1).max(512).optional(),
});

/**
 * Has this `ringing` row's deadline passed? `expiresAt` is the server-issued ring
 * deadline; when it is null (a legacy row, or any path that failed to stamp it)
 * we fall back to `createdAt + RING_TIMEOUT` so the ring is still bounded. Without
 * the fallback such a row could never be reaped and would block its DM forever.
 */
function ringDeadlinePassed(call: DmCall, at: number = Date.now()): boolean {
  const deadline = call.expiresAt
    ? new Date(call.expiresAt).getTime()
    : new Date(call.createdAt).getTime() + RING_TIMEOUT_SECONDS * 1000;
  return !Number.isNaN(deadline) && at > deadline;
}

/** Any Postgres unique-violation — the `dm_calls_one_live_per_dm` race guard. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "23505"
  );
}

export interface DmCallsModuleDeps {
  mutationBus?: RealtimeMutationPublisher;
  /**
   * Mobile-push dispatcher. Call rings use `notifier.notifyAlways` so the push
   * reaches the callee's device EVEN WHEN they read "online" (#103): a
   * backgrounded app holds a live WS but shows no on-screen ring, so the
   * offline gate would wrongly silence the call. The matching `call.invite` WS
   * event still drives the LIVE ring UI when the app is foregrounded. All pushes
   * are best-effort (the notifier swallows) and never fail the request.
   */
  notifier?: OfflineNotifier;
  /**
   * The shared single-active-voice-session registry (built once in `buildApp`).
   * When present, minting a call token records the user's active room and evicts
   * any session in a DIFFERENT room (ADR 0012 §5). Null in tests that only assert
   * lifecycle without eviction.
   */
  voiceSessions?: VoiceSessionRegistry | null;
  /**
   * Media-plane participant probe — the SAME reader the sweeper uses, shared so
   * "who is actually in this room" has exactly one implementation. Used only to
   * answer `DmCallActiveResponse.inRoom` on the resync read (ADR 0023 §3).
   *
   * Null/absent ⇒ `inRoom` is always `null` ("unknown"), which the client reads
   * as "stay out of the room until the user says otherwise". That is the safe
   * degradation: see the field's doc for why unknown must never become `false`.
   */
  callLiveness?: CallRoomLivenessReader | null;
}

export async function registerDmCallsModule(
  server: FastifyInstance,
  deps: DmCallsModuleDeps = {},
): Promise<void> {
  const { mutationBus, notifier } = deps;
  const voiceSessions = deps.voiceSessions ?? null;
  const callLiveness = deps.callLiveness ?? null;

  /**
   * Throw 403 unless `a` and `b` are currently ACCEPTED friends (§3) AND no block
   * exists between them in either direction (M18, ADR 0017).
   *
   * The block check lives HERE, inside the gate every call endpoint already
   * calls (start / accept / reject / cancel / hangup / upgrade), so a call can
   * neither be STARTED into a block nor survive one that lands mid-ring — no
   * endpoint can forget it. It runs first: a blocked pair gets the block error,
   * not "you can only call friends", because blocking severs the friendship and
   * the friendship message would be misleading.
   */
  async function assertMutualFriends(a: UserId, b: UserId): Promise<void> {
    await assertNotBlocked(server, a, b);
    const friendship = await server.repos.friendships.getFriendshipWith(a, b);
    if (!friendship || friendship.status !== "accepted") {
      throw new ApiError(403, "FORBIDDEN", "You can only call friends.");
    }
  }

  /**
   * Mint LiveKit credentials for a call room — the ONE authorization path for a
   * call-room token (ADR 0012 §2). Returns the media half of
   * `DmCallTokenResponse` (mirrors `/media/token`).
   *
   * `recordSession` folds in single-active-session eviction (§5): the call room is
   * just another room string, so joining a call evicts a prior group voice
   * session (and vice versa) for free. Fire-and-forget — `recordAndEvict`
   * swallows every error internally, so it never delays or fails the join.
   *
   * The RESYNC read passes `recordSession: false`, and that is load-bearing.
   * `GET /dm-calls/active` runs on every socket (re)connect, and it re-issues
   * credentials for a room the user was ALREADY recorded into by start/accept —
   * so recording again buys nothing, while evicting would let a stale live row
   * (or a routine reconnect) kick the user out of the group voice channel they
   * are actually sitting in. A read must not disconnect a device.
   */
  async function mintCallCredential(
    user: User,
    call: DmCall,
    options: { recordSession?: boolean } = {},
  ): Promise<DmCallMediaCredential> {
    const accessToken = new AccessToken(
      server.apiEnv.livekitApiKey,
      server.apiEnv.livekitApiSecret,
      { identity: user.id, name: user.displayName, ttl: MEDIA_TOKEN_TTL_SECONDS },
    );
    accessToken.addGrant({
      room: call.roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });
    if (voiceSessions && options.recordSession !== false) {
      void voiceSessions.recordAndEvict(user.id, call.roomName);
    }
    return {
      url: server.apiEnv.livekitUrl,
      token: await accessToken.toJwt(),
      roomName: call.roomName,
      identity: user.id,
      expiresAt: new Date(Date.now() + MEDIA_TOKEN_TTL_SECONDS * 1000).toISOString(),
    };
  }

  /**
   * The start/accept response: the call plus the credentials that admit the user
   * to its room. Records the session (this IS a join).
   */
  async function buildCallToken(user: User, call: DmCall): Promise<DmCallTokenResponse> {
    const media = await mintCallCredential(user, call);
    return { call, ...media };
  }

  /**
   * Send a call push WITHOUT the lifecycle waiting on it (call-UX plan K2.1).
   *
   * The Expo round-trip is a third-party HTTP call with no bounded latency, and
   * every call push is a courtesy: the ring, the retraction and the upgrade
   * invite all also travel as `call.*` events over the socket, which is what
   * actually drives the UI. Awaiting it therefore bought nothing and cost
   * everything — it put provider latency directly into `POST /dm-calls`, so the
   * callee (already rung over its socket) could ACCEPT before the caller's 201
   * arrived, leaving the caller's FSM to drop an out-of-phase `call.accepted` and
   * the row stuck `active`. That is the founder's "kabul etti ama bağlanmadı".
   *
   * So: never awaited, and never silent. `notifyAlways` already swallows its own
   * errors, so the catch here is belt-and-braces for a synchronous throw; the
   * timer covers the failure mode that has no error at all — a dispatch that just
   * hangs. Both end in the log, so a dead push channel is visible without any
   * user-visible symptom.
   */
  function dispatchCallPush(
    recipientIds: readonly UserId[],
    notification: PushNotification,
    label: string,
  ): void {
    if (!notifier) return;
    const startedAt = Date.now();
    let settled = false;
    const slowTimer = setTimeout(() => {
      if (settled) return;
      server.log.warn(
        `[dm-calls] ${label} push still pending after ${CALL_PUSH_SLOW_MS}ms — abandoned, call unaffected`,
      );
    }, CALL_PUSH_SLOW_MS);
    // Never hold the event loop open for a courtesy notification.
    slowTimer.unref?.();

    const done = (err?: unknown): void => {
      settled = true;
      clearTimeout(slowTimer);
      if (err) {
        server.log.warn(
          `[dm-calls] ${label} push failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed >= CALL_PUSH_SLOW_MS) {
        server.log.warn(`[dm-calls] ${label} push completed late (${elapsed}ms)`);
      }
    };

    try {
      void notifier.notifyAlways(recipientIds, notification).then(
        () => done(),
        (err: unknown) => done(err),
      );
    } catch (err) {
      done(err);
    }
  }

  /**
   * Is `user`'s LiveKit identity in `call`'s room right now? The media half of
   * the resync read (ADR 0023 §3) — see `DmCallActiveResponse.inRoom` for what
   * each answer means and why "unknown" is its own value.
   *
   * Two probes, in the sweeper's order and for the sweeper's reason: LiveKit
   * DROPS a room once it empties, so `listParticipants` on a finished call is a
   * NotFound *error*, not an empty list. Reading occupancy from the room list
   * first turns "the room is gone" into the honest `false` it is, and reserves
   * the error path for a media plane we genuinely could not reach. Getting that
   * backwards would answer `null` for every dead room and permanently block the
   * media-repair path this endpoint exists to drive (K2.3).
   *
   * Bounded by {@link IN_ROOM_PROBE_TIMEOUT_MS} and never throws: a resync that
   * cannot answer this still has to answer everything else.
   */
  async function readInRoom(user: User, call: DmCall): Promise<boolean | null> {
    if (!callLiveness) return null;
    const liveness = callLiveness;
    try {
      return await withProbeTimeout(
        (async () => {
          const rooms = await liveness.rooms();
          // Absent from the list, or listed with nobody in it — either way the
          // room holds no one, so it certainly does not hold us.
          if ((rooms.get(call.roomName) ?? 0) === 0) return false;
          const identities = await liveness.participants(call.roomName);
          return identities.includes(user.id);
        })(),
      );
    } catch (err) {
      // Not an error for the CALLER: the client degrades to the cautious branch.
      // Logged because a media plane we cannot probe is worth seeing.
      server.log.warn(
        { err, callId: call.id },
        "[dm-calls] inRoom probe failed — answering 'unknown'",
      );
      return null;
    }
  }

  /**
   * Tell BOTH participants — every session of each — that a call is over
   * (ADR 0023 §4), the mirror of the accept fan-out.
   *
   * `call.ended` used to reach only the OTHER side, which was correct while a
   * device could not be in a call it had not personally joined. Under the seat
   * model it can: the actor's other devices sit on an "in a call elsewhere"
   * band, and with no terminal of their own that band hangs there until the next
   * resync. The sweeper has always announced to both sides; this makes the
   * client-authored terminals agree. The actor's own echo is a no-op in the
   * reducer (its slot is already `ended`).
   */
  async function announceCallEnded(call: DmCall, reason: CallEndReason): Promise<void> {
    const event = serverEvent.callEnded({ callId: call.id, reason });
    for (const userId of [call.callerId, call.calleeId]) {
      await mutationBus?.publish({ userId, event });
    }
  }

  /**
   * Write the inline DM call-history system message for a terminal outcome
   * (ADR 0012 §7). Loads the DM stream relative to a participant (`authorId` is
   * one) and delegates to the shared helper. Best-effort — never fails the
   * request.
   */
  async function writeOutcomeSystemMessage(
    call: DmCall,
    authorId: UserId,
    token: DmCallOutcomeToken,
    durationSeconds?: number,
  ): Promise<void> {
    const dm = await server.repos.dms.findById(call.dmId, authorId);
    if (!dm) return;
    await postDmCallSystemMessage({
      repos: server.repos,
      mutationBus,
      log: server.log,
      dmId: call.dmId,
      streamId: dm.streamId,
      memberIds: [call.callerId, call.calleeId],
      authorId,
      token,
      durationSeconds,
    });
  }

  /**
   * Close a LIVE call as `ended` — the hangup outcome — on behalf of `actor`.
   *
   * Shared by `/hangup` and by `/cancel` when the cancel arrives for a call that
   * has ALREADY been accepted (call-UX plan K2.3). Both are the same event: a
   * participant is walking away from a call whose row is live, and the row must
   * end up terminal either way. Cancel used to answer 409 there, the client
   * swallowed it, and the row stayed `active` with nobody in the room — reachable
   * only by the 3-6 minute sweeper, which is why the founder's only escape was to
   * leave the room and call again.
   *
   * IDEMPOTENT by construction: the transition is guarded in SQL (`closeIfIn`), so
   * when the other participant closed the call first this returns their row and
   * writes NOTHING — no duplicate call-history message, no second `call.ended`.
   */
  async function endLiveCall(call: DmCall, actor: User): Promise<{ call: DmCall }> {
    const endedAt = new Date();
    const ended = await server.repos.calls.closeIfIn(
      call.id,
      ["ringing", "active"],
      "ended",
      endedAt,
    );
    if (!ended) {
      // Lost the race: somebody already moved it off live. Report the CURRENT row
      // rather than an error — the caller's goal (this call is over) already holds.
      const current = await server.repos.calls.findById(call.id);
      if (!current) throw new ApiError(404, "NOT_FOUND", "Call not found.");
      return { call: current };
    }

    // Talk time from accept → hangup; 0 when the call never connected.
    const durationSeconds = call.startedAt
      ? Math.max(0, (endedAt.getTime() - new Date(call.startedAt).getTime()) / 1000)
      : 0;
    await writeOutcomeSystemMessage(call, actor.id, "call_ended", durationSeconds);

    await announceCallEnded(call, "hung_up");
    return { call: ended };
  }

  // ==========================================================================
  // POST /dm-calls  { dmId, media }  → start a call (returns the CALLER token)
  // ==========================================================================
  server.post(
    "/dm-calls",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 10, timeWindow: "1 minute" }),
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { dmId, media } = parseWith(startCallSchema, request.body);

      // DM membership + kind gate: findById returns the DM (participant = the
      // OTHER member = the callee) ONLY when the caller is one of its two
      // members. A non-DM id or a DM the caller is not in → 404 (no leak).
      const dm = await server.repos.dms.findById(dmId, user.id);
      if (!dm) throw new ApiError(404, "NOT_FOUND", "DM not found.");
      const calleeId = dm.participant.id;

      // Live mutual-friend gate (§3) — re-read per request, never trusted.
      await assertMutualFriends(user.id, calleeId);

      // Newest call on this DM (any status): drives the stale-ring sweep and the
      // start cooldown (security F2) — both run BEFORE the live-call 409 below.
      const latest = await server.repos.calls.findLatestForDm(dmId);

      // Stale-ring sweep (F1 follow-up / the ADR 0012 ring-sweeper open item). A
      // ring whose deadline has passed but whose row is still `ringing` — a dead
      // caller-client that never canceled — would block this DM's calls forever
      // via the `dm_calls_one_live_per_dm` partial index (findLiveForDm keeps
      // returning it → every start 409s). Reap it to `missed` inline so the new
      // call can proceed immediately, rather than waiting for the periodic
      // sweeper (lib/dm-call-sweeper.ts) that now backs this up globally.
      //
      // The deadline falls back to `createdAt + RING_TIMEOUT` when `expiresAt` is
      // null: guarding on a non-null `expiresAt` alone made a null-deadline
      // `ringing` row permanently un-sweepable — a DM bricked forever.
      if (latest && latest.status === "ringing" && ringDeadlinePassed(latest)) {
        await server.repos.calls.closeIfIn(latest.id, ["ringing"], "missed", new Date());
      }

      // Start cooldown (F2): if THIS caller's most recent attempt in this DM ended
      // un-answered within the window, throttle the re-ring with a 429. Evaluated
      // on the PRE-sweep snapshot, so a ring we JUST swept above (it was `ringing`,
      // not a terminal status) never counts against the caller — only a genuinely
      // recent missed/declined/canceled attempt does. A LIVE call is not terminal
      // and falls through to the 409 below, so the caller can still rejoin it.
      if (
        latest &&
        latest.callerId === user.id &&
        UNANSWERED_TERMINAL_STATUSES.includes(latest.status)
      ) {
        const elapsedMs = Date.now() - new Date(latest.createdAt).getTime();
        if (elapsedMs < START_COOLDOWN_MS) {
          const retryAfterSeconds = Math.ceil((START_COOLDOWN_MS - elapsedMs) / 1000);
          throw new ApiError(
            429,
            "RATE_LIMITED",
            "You're calling too quickly. Please wait a few seconds before trying again.",
            retryAfterSeconds,
          );
        }
      }

      // At most one live call per DM. Pre-check for a friendly 409 that carries
      // the existing call so a re-tapping caller can rejoin it.
      const existing = await server.repos.calls.findLiveForDm(dmId);
      if (existing) {
        return reply.status(409).send({
          ...errorBody("CONFLICT", "A call is already in progress in this DM."),
          call: existing,
        });
      }

      const expiresAt = new Date(Date.now() + RING_TIMEOUT_SECONDS * 1000);
      let call: DmCall;
      try {
        call = await server.repos.calls.create({
          dmId,
          callerId: user.id,
          calleeId,
          media,
          expiresAt,
        });
      } catch (err) {
        // Race: a concurrent start won the partial unique index. Return the
        // winner's live call as a 409 rather than a 500.
        if (isUniqueViolation(err)) {
          const raced = await server.repos.calls.findLiveForDm(dmId);
          if (raced) {
            return reply.status(409).send({
              ...errorBody("CONFLICT", "A call is already in progress in this DM."),
              call: raced,
            });
          }
        }
        throw err;
      }

      const tokenResponse = await buildCallToken(user, call);

      // Ring the callee (user-scoped). Control metadata only — media is LiveKit.
      await mutationBus?.publish({
        userId: calleeId,
        event: serverEvent.callInvite({
          callId: call.id,
          target: { kind: "dm", dmId },
          caller: user,
          media,
          expiresAt: expiresAt.toISOString(),
        }),
      });
      // Ring the callee's device even when they read "online" (#103). A
      // backgrounded app holds a live WS yet shows no on-screen ring, so the
      // offline gate would wrongly silence the call — notifyAlways bypasses it.
      // `collapseKey` (Android notification tag / iOS apns-collapse-id) lets the
      // cancel/timeout retraction below REPLACE this ring instead of stacking a
      // second notification. `priority:"high"` is applied by the push service.
      //
      // NOT AWAITED (K2.1): the 201 below must reach the caller before a
      // third-party HTTP round-trip can, or the callee — already rung over its
      // socket by the publish above — can accept a call the caller has not been
      // told it started. See `dispatchCallPush` for the full reasoning; failures
      // and hangs are logged there rather than swallowed.
      dispatchCallPush(
        [calleeId],
        {
          title: user.displayName,
          body: "is calling you.",
          data: { type: "call_invite", callId: call.id, dmId },
          collapseKey: callPushTag(call.id),
        },
        "ring",
      );

      return reply.status(201).send(tokenResponse);
    },
  );

  // ==========================================================================
  // GET /dm-calls/recent  → the caller's cross-DM call history (Voice-UX #2)
  // ==========================================================================
  // A read-only, keyset-paged log of every call the caller took part in (caller
  // OR callee), newest-first. Server-side authorization (§28): the repo filters
  // by the authenticated user in SQL, so a user can never see a call between two
  // other people — there is no id/dmId input to tamper with. Rate-limited per
  // session like the other list reads.
  server.get(
    "/dm-calls/recent",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 60, timeWindow: "1 minute" }),
      },
    },
    async (request) => {
      const user = requireUser(request);
      const { limit, before } = parseWith(recentCallsQuerySchema, request.query);
      const page = await server.repos.calls.listRecentForUser(user.id, {
        limit,
        before: before ?? null,
      });
      return { calls: page.items, nextCursor: page.nextCursor };
    },
  );

  // ==========================================================================
  // GET /dm-calls/active  → the caller's live call, if any (STATE RESYNC)
  // ==========================================================================
  // The call-plane counterpart of `voice.resync` / `GET /voice/occupancy`
  // (call-UX plan K2.2): "what call am I actually in right now?", answered from a
  // fresh database read. The client pulls it on WS (re)connect and whenever an
  // out-of-phase `call.accepted` arrives, so a control event that crossed with
  // its own HTTP response can no longer strand a live call — the caller re-seats
  // on the row instead of dropping the event.
  //
  // Authorization: the row is looked up BY the authenticated user id (either
  // side), so there is no id to tamper with and no call between two other people
  // is reachable. Deliberately NO friendship/block re-check: this read is how a
  // client escapes a call, and an unfriend mid-call must never make the call
  // invisible-but-live (the same F1 reasoning the terminal endpoints carry).
  server.get(
    "/dm-calls/active",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 60, timeWindow: "1 minute" }),
      },
    },
    async (request): Promise<DmCallActiveResponse> => {
      const user = requireUser(request);
      const empty: DmCallActiveResponse = {
        call: null,
        peer: null,
        side: null,
        media: null,
        // No call ⇒ no room ⇒ nothing to say about being in one.
        inRoom: null,
      };

      const call = await server.repos.calls.findLiveForUser(user.id);
      if (!call) return empty;

      // A ring past its deadline is not live truth. Reap it inline — exactly as
      // start does — so a resync can never re-seat a client onto a dead ring, and
      // so the DM is unblocked immediately instead of at the next sweeper tick.
      if (call.status === "ringing" && ringDeadlinePassed(call)) {
        await server.repos.calls.closeIfIn(call.id, ["ringing"], "missed", new Date());
        return empty;
      }

      const side: DmCallSide = call.callerId === user.id ? "caller" : "callee";
      // The peer comes from the DM the call belongs to (`participant` is the OTHER
      // member), so it is the same public User shape every other call payload
      // carries — no friendCode, no second client round-trip.
      const dm = await server.repos.dms.findById(call.dmId, user.id);
      const peer = dm?.participant ?? null;

      // Credentials only for a user already entitled to the room: the caller
      // (who joined at start) or anyone in an ACCEPTED call. A ringing callee gets
      // none — /accept is the only path allowed to flip the row and mint theirs.
      const entitled = side === "caller" || call.status === "active";
      const media = entitled
        ? await mintCallCredential(user, call, { recordSession: false })
        : null;

      // The AUTO-JOIN GATE (ADR 0023 §3). Probed only for a user who could
      // actually act on it: a ringing callee has no credentials and no seat, so
      // there is nothing for the answer to gate and no reason to pay for it.
      const inRoom = entitled ? await readInRoom(user, call) : null;

      return { call, peer, side, media, inRoom };
    },
  );

  // ==========================================================================
  // POST /dm-calls/:id/accept  → accept (returns the CALLEE token)
  // ==========================================================================
  server.post(
    "/dm-calls/:id/accept",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 20, timeWindow: "1 minute" }),
      },
    },
    async (request) => {
      const user = requireUser(request);
      const { id } = parseWith(callParamsSchema, request.params);

      const call = await server.repos.calls.findById(id);
      if (!call) throw new ApiError(404, "NOT_FOUND", "Call not found.");
      if (call.calleeId !== user.id) {
        throw new ApiError(403, "FORBIDDEN", "Only the person being called can accept.");
      }
      if (call.status !== "ringing") {
        throw new ApiError(409, "CONFLICT", "This call is no longer ringing.");
      }
      // Ring deadline: a dead caller-client cannot leave a call ringable forever
      // (§4) — the server independently rejects an accept after expiry. Uses the
      // same createdAt fallback as the sweep, so a row with no stamped deadline is
      // bounded here too instead of staying acceptable indefinitely.
      if (ringDeadlinePassed(call)) {
        throw new ApiError(409, "CONFLICT", "This call has expired.");
      }
      await assertMutualFriends(call.callerId, call.calleeId);

      // Guarded in SQL, not by the read above: an unconditional flip can land
      // AFTER the caller's cancel and resurrect the call as `active` with nobody
      // behind it. Losing that race is a 409, the same answer the pre-check gives.
      const active = await server.repos.calls.activateIfRinging(id, new Date());
      if (!active) throw new ApiError(409, "CONFLICT", "This call is no longer ringing.");

      const tokenResponse = await buildCallToken(user, active);

      const accepted = serverEvent.callAccepted({
        callId: call.id,
        target: { kind: "dm", dmId: call.dmId },
        callee: user,
      });
      await mutationBus?.publish({ userId: call.callerId, event: accepted });
      // The CALLEE's other devices need this too. A user signed in on both a
      // phone and a desktop is the normal case here, and only the device that
      // pressed Accept learned the call had been answered: the desktop kept
      // ringing at a call already in progress, and showed nothing about being in
      // one. Founder, both halves: "telefondan gelen bi aramaya cevap
      // verdiğimde pcde hala arama devam ediyormuş gibi gözüküyor" and "mobilde
      // benimle seslide olmasına rağmen pcde açık olan hesabımda aramada
      // olduğum gözükmüyor. platformlar birbiriyle senkron olmalı."
      //
      // The event is user-scoped, so this reaches every session of the callee —
      // including the one that accepted. That device is already `pending`/`active`
      // on this call and its reducer ignores the echo; the others resync and
      // adopt the live call, which is what makes it VISIBLE rather than merely
      // silent.
      await mutationBus?.publish({ userId: user.id, event: accepted });

      return tokenResponse;
    },
  );

  // ==========================================================================
  // POST /dm-calls/:id/reject  → callee declines a ringing call
  // ==========================================================================
  server.post(
    "/dm-calls/:id/reject",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 30, timeWindow: "1 minute" }),
      },
    },
    async (request) => {
      const user = requireUser(request);
      const { id } = parseWith(callParamsSchema, request.params);

      const call = await server.repos.calls.findById(id);
      if (!call) throw new ApiError(404, "NOT_FOUND", "Call not found.");
      if (call.calleeId !== user.id) {
        throw new ApiError(403, "FORBIDDEN", "Only the person being called can decline.");
      }
      if (call.status !== "ringing") {
        throw new ApiError(409, "CONFLICT", "This call is no longer ringing.");
      }
      // No friendship re-check on terminal endpoints (security F1): an unfriend
      // mid-ring/mid-call must never strand the row `active`/`ringing`, or the
      // one-live-call-per-DM index blocks that DM forever. Participant identity
      // above is sufficient authority to END a call.

      // Guarded in SQL so a decline that crosses an accept from the callee's OTHER
      // device cannot stamp `declined` over a live call.
      const ended = await server.repos.calls.closeIfIn(id, ["ringing"], "declined", new Date());
      if (!ended) throw new ApiError(409, "CONFLICT", "This call is no longer ringing.");

      await writeOutcomeSystemMessage(call, user.id, "call_declined");
      // Both sides (ADR 0023 §4): the decliner's OTHER devices are ringing too,
      // and this is what silences them.
      await announceCallEnded(call, "declined");

      return { call: ended };
    },
  );

  // ==========================================================================
  // POST /dm-calls/:id/cancel  { reason? }  → caller withdraws a ringing call
  //   …and, tolerantly, closes an ALREADY-ACCEPTED one (K2.3) instead of 409ing.
  // ==========================================================================
  server.post(
    "/dm-calls/:id/cancel",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 30, timeWindow: "1 minute" }),
      },
    },
    async (request) => {
      const user = requireUser(request);
      const { id } = parseWith(callParamsSchema, request.params);
      const { reason } = parseWith(cancelSchema, request.body ?? {});

      const call = await server.repos.calls.findById(id);
      if (!call) throw new ApiError(404, "NOT_FOUND", "Call not found.");
      if (call.callerId !== user.id) {
        throw new ApiError(403, "FORBIDDEN", "Only the caller can cancel this call.");
      }
      // No friendship re-check here — see the decline handler's F1 note.

      // Already terminal → IDEMPOTENT 200 with the row as it stands (K2.3). The
      // 409 this used to be is worse than useless: a client that cancels after a
      // reject/timeout has nothing to do with the error but drop it, and the two
      // sides then disagree about whether the call is over. "It is already closed"
      // is a success for a request whose goal is "close it".
      if (call.status !== "ringing" && call.status !== "active") {
        return { call };
      }

      // ACCEPTED between the caller's decision and this request — the exact race
      // K2 is about. Close it as a hangup instead of refusing: the caller is gone
      // (media error, ring timer, withdraw), so refusing would leave the row
      // `active` with an empty room, escapable only via the 3-6 minute sweeper.
      // Logged because it means a client sent `cancel` where `hangup` now belongs
      // (pre-W1B clients, or a genuine race) and we want to see which.
      if (call.status === "active") {
        server.log.warn(
          `[dm-calls] cancel arrived for an ACCEPTED call ${call.id} — closing it as a hangup (accept/cancel race)`,
        );
        return await endLiveCall(call, user);
      }

      // A ring-timer expiry logs the call `missed`; a manual withdraw `canceled`.
      const timedOut = reason === "timeout";
      const status = timedOut ? "missed" : "canceled";
      // Guarded in SQL: if the accept won this exact instant, `closeIfIn` returns
      // null instead of stamping a terminal status over a LIVE call, and we fall
      // through to the same hangup closure as above.
      const ended = await server.repos.calls.closeIfIn(id, ["ringing"], status, new Date());
      if (!ended) {
        const current = await server.repos.calls.findById(id);
        if (!current) throw new ApiError(404, "NOT_FOUND", "Call not found.");
        if (current.status === "active") {
          server.log.warn(
            `[dm-calls] cancel lost the race to accept on call ${current.id} — closing it as a hangup`,
          );
          return await endLiveCall(current, user);
        }
        return { call: current };
      }

      await writeOutcomeSystemMessage(
        call,
        user.id,
        timedOut ? "call_missed" : "call_canceled",
      );
      // Both sides (ADR 0023 §4): the caller's other devices are showing an
      // outgoing ring they did not place, and only this retracts it.
      await announceCallEnded(call, timedOut ? "timeout" : "canceled");
      // Retract the ring on the callee's device(s) (#103). The SAME collapseKey
      // makes this REPLACE the "is calling you." notification with a "Missed
      // call" line rather than leave a stale ring on a backgrounded phone.
      // Presence-independent for the same reason the ring was: a
      // backgrounded-but-connected callee still holds the ring. (The callee's own
      // reject/accept clears the ring client-side on the acting device; a
      // multi-device silent clear for those is a client-wave item — see report.)
      //
      // Not awaited, same as the ring (K2.1): the caller's teardown must not wait
      // on a push provider either — that delay is how a cancel and an accept end
      // up overlapping in the first place.
      dispatchCallPush(
        [call.calleeId],
        {
          title: user.displayName,
          body: "Missed call",
          data: { type: "call_ended", callId: call.id, reason: timedOut ? "timeout" : "canceled" },
          collapseKey: callPushTag(call.id),
        },
        "ring retraction",
      );

      return { call: ended };
    },
  );

  // ==========================================================================
  // POST /dm-calls/:id/hangup  → either participant ends a live call
  // ==========================================================================
  server.post(
    "/dm-calls/:id/hangup",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 30, timeWindow: "1 minute" }),
      },
    },
    async (request) => {
      const user = requireUser(request);
      const { id } = parseWith(callParamsSchema, request.params);

      const call = await server.repos.calls.findById(id);
      if (!call) throw new ApiError(404, "NOT_FOUND", "Call not found.");
      const isParticipant = call.callerId === user.id || call.calleeId === user.id;
      if (!isParticipant) {
        throw new ApiError(403, "FORBIDDEN", "You are not part of this call.");
      }
      // No friendship re-check here — see the decline handler's F1 note.

      // Already terminal → IDEMPOTENT 200, not 409 (K2.3, same reasoning as
      // cancel): both participants hang up at once on a normal goodbye, and the
      // second one must not be told its teardown failed.
      if (call.status !== "active" && call.status !== "ringing") {
        return { call };
      }

      return await endLiveCall(call, user);
    },
  );

  // ==========================================================================
  // POST /dm-calls/:id/upgrade  { inviteeUserId }  → seamless group upgrade
  // ==========================================================================
  server.post(
    "/dm-calls/:id/upgrade",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 10, timeWindow: "1 minute" }),
      },
    },
    async (request) => {
      const user = requireUser(request);
      const { id } = parseWith(callParamsSchema, request.params);
      const { inviteeUserId } = parseWith(upgradeSchema, request.body);

      const call = await server.repos.calls.findById(id);
      if (!call) throw new ApiError(404, "NOT_FOUND", "Call not found.");
      // The inviter must be one of the two originals (either may add a third).
      const isParticipant = call.callerId === user.id || call.calleeId === user.id;
      if (!isParticipant) {
        throw new ApiError(403, "FORBIDDEN", "You are not part of this call.");
      }
      // Upgrade only a LIVE (active) call — the third person joins an ongoing one.
      if (call.status !== "active") {
        throw new ApiError(409, "CONFLICT", "This call is not active.");
      }
      const otherOriginalId = call.callerId === user.id ? call.calleeId : call.callerId;
      if (inviteeUserId === call.callerId || inviteeUserId === call.calleeId) {
        throw new ApiError(400, "VALIDATION_ERROR", "That user is already in the call.");
      }
      // Gate (§6 / ADR open item 2): the INVITER must be mutual
      // friends with the third person; the other original need not be.
      await assertMutualFriends(user.id, inviteeUserId);
      // …and the third person must not be blocked BY (or blocking) the other
      // original either (M18): an upgrade drops all three into one live room and
      // a shared group, so consent from the inviter alone is not enough to put
      // two people who blocked each other in the same call.
      await assertNotBlocked(server, otherOriginalId, inviteeUserId);

      // Hydrate the three users for member.joined payloads + the group name.
      const [inviter, other, invitee] = await Promise.all([
        server.repos.users.findById(user.id),
        server.repos.users.findById(otherOriginalId),
        server.repos.users.findById(inviteeUserId),
      ]);
      if (!inviter || !other || !invitee) {
        throw new ApiError(404, "NOT_FOUND", "User not found.");
      }

      // Single-transaction upgrade (Wave 1): new group + 3 memberships + hidden
      // text stream + voice channel bound to the ONGOING call room + flip the
      // call → upgraded. The two originals are already in that LiveKit room, so
      // there is zero reconnect and zero media gap; the DM stream is untouched.
      const { group, voiceChannelId } = await server.repos.callUpgrade.upgradeDmToGroup({
        callId: call.id,
        name: buildGroupName([inviter, other, invitee]),
        ownerId: user.id,
        memberIds: [otherOriginalId, inviteeUserId],
      });

      // 1) member.joined ×3 (group-scoped) FIRST — the gateway indexes and
      //    subscribes each user's connections into the new group off these
      //    BEFORE the call.* events navigate their UI (Wave 3 relies on order).
      for (const u of [inviter, other, invitee]) {
        const member = await server.repos.groups.getMembership(group.id, u.id);
        if (member) {
          await mutationBus?.publish({
            groupId: group.id,
            event: serverEvent.memberJoined({ groupId: group.id, member, user: u }),
          });
        }
      }
      // 2) call.upgraded → the two originals: their UI moves DM call → group voice
      //    channel; media stays put (their session room already equals it).
      for (const originalId of [call.callerId, call.calleeId]) {
        await mutationBus?.publish({
          userId: originalId,
          event: serverEvent.callUpgraded({ callId: call.id, group, voiceChannelId }),
        });
      }
      // 3) call.invite{target:group} → the invitee: the same ring, for the group
      //    voice channel (whose room IS the live call), so accepting lands them in.
      const inviteExpiresAt = new Date(Date.now() + RING_TIMEOUT_SECONDS * 1000).toISOString();
      const target: CallTarget = { kind: "group", groupId: group.id, voiceChannelId };
      await mutationBus?.publish({
        userId: inviteeUserId,
        event: serverEvent.callInvite({
          callId: call.id,
          target,
          caller: inviter,
          media: call.media,
          expiresAt: inviteExpiresAt,
        }),
      });
      // Ring the invitee's device presence-independently, same as the 1-1 start
      // (#103) — a backgrounded invitee with a live WS still needs the ring. The
      // collapseKey keeps the group-upgrade ring on the same per-call slot. Not
      // awaited, same as the 1-1 ring (K2.1): the two originals are already in the
      // room and their UI moves on this response.
      dispatchCallPush(
        [inviteeUserId],
        {
          title: inviter.displayName,
          body: "added you to a call.",
          data: { type: "call_invite", callId: call.id, groupId: group.id, voiceChannelId },
          collapseKey: callPushTag(call.id),
        },
        "upgrade ring",
      );

      return { group, voiceChannelId };
    },
  );
}

/**
 * Reject with a timeout if `work` outlives {@link IN_ROOM_PROBE_TIMEOUT_MS}.
 *
 * The loser of the race is only ABANDONED, not cancelled — there is no cancel
 * token in the LiveKit admin client — so `work` is given a no-op rejection
 * handler: an unhandled rejection from the slow probe would otherwise surface as
 * a process-level warning long after the request it belonged to was answered.
 */
function withProbeTimeout<T>(work: Promise<T>): Promise<T> {
  work.catch(() => undefined);
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`media-plane probe exceeded ${IN_ROOM_PROBE_TIMEOUT_MS}ms`)),
        IN_ROOM_PROBE_TIMEOUT_MS,
      );
      timer.unref?.();
    }),
  ]);
}

/** A compact, comma-joined group name from the participants' display names. */
function buildGroupName(users: User[]): string {
  const joined = users.map((u) => u.displayName).join(", ");
  return joined.length > 100 ? `${joined.slice(0, 99)}…` : joined;
}

/**
 * Per-call push collapse tag (#103). The ring and its retraction share this tag
 * so a later same-tag push REPLACES the ring on the device (Android notification
 * `tag` / iOS `apns-collapse-id`) instead of stacking a second notification. The
 * client wave can also key a silent background dismiss on it (`type:"call_ended"`).
 */
function callPushTag(callId: string): string {
  return `call:${callId}`;
}
