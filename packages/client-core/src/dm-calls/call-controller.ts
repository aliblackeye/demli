/**
 * DM-call controller (ADR 0012 / plan Wave 5) — the SHARED, framework-free data
 * layer that drives the pure {@link callReducer} and wires it to the api client,
 * the media engine, and the caller-side ring timer.
 *
 * It exposes a small subscribable store (`getState` + `subscribe`, the same
 * contract the media engine uses, so a platform binds it with `useSyncExternalStore`
 * and — per ADR 0002 — wraps it in its own zustand/TanStack layer). Everything it
 * touches is INJECTED (api, engine, current user, signaller, timers), so it stays
 * React/DOM/RN-agnostic and unit-testable with fakes.
 *
 * Responsibilities (plan Wave 5):
 *  1. Call FSM store, above the voice FSM (never a clone of it).
 *  2. Control actions for `/dm-calls/*`; on start/accept, hand the returned
 *     `{ url, token }` + `roomName` to the engine's join. A start 409 carries the
 *     existing call → rejoin it.
 *  3. Single-session: a `voice.session_replaced` on the call room ends the call
 *     cleanly (the engine already evicted itself — no `leave()` here).
 *  4. Caller-driven ring timeout (ADR default 30s) → `cancel(reason:"timeout")`,
 *     consistent with the server's `expires_at` accept guard.
 *
 * CRITICAL upgrade contract (ADR 0012 §6 / Wave 4): on `call.upgraded` this NEVER
 * calls `engine.leave()`/`engine.join(voiceChannelId)` — that would tear media
 * down. It only re-points the surface to the group voice channel and emits a
 * signaling-only `voice.join` (occupancy). `roomName` stays `dmcall:<callId>`.
 */

import type {
  CallAcceptedPayload,
  CallEndedPayload,
  CallInvitePayload,
  CallUpgradedPayload,
  ServerToClientEvent,
  VoiceSessionReplacedPayload,
} from "@demli/protocol";
import type { CallId, CallMedia, ChannelId, DmCall, DmId, UserId } from "@demli/types";
import { ApiClientError, type Api } from "../api-client.js";
import {
  callReducer,
  initialCallState,
  isCallLive,
  type CallAction,
  type CallEndedReason,
  type CallPhase,
  type CallRole,
  type CallSeat,
  type CallState,
  type CallSurface,
} from "./call-state.js";

/** A pre-minted LiveKit grant handed to the engine's join (mirrors `VoiceJoinCredential`). */
interface JoinCredential {
  url: string;
  token: string;
}

/**
 * The STRUCTURAL subset of `@demli/media`'s `VoiceEngine` the call controller
 * drives. Declared locally (not imported) so `@demli/client-core` keeps its
 * lean, RN-safe dependency graph (types/protocol/config/zod) and never pulls in
 * `livekit-client` transitively — the ADR 0002 "inject the dependency" pattern.
 * The real `VoiceEngine` satisfies this without a cast; the desktop/mobile glue
 * passes it straight in.
 */
export interface CallVoiceEngine {
  /**
   * Join a LiveKit room with a PRE-MINTED credential (DM calls, ADR 0012 §2).
   * `roomChannelId` is the call room name (`dmcall:<callId>`) so the engine's
   * `roomId` keys single-session eviction on the same string the server recorded.
   */
  join(roomChannelId: string, credential?: JoinCredential): Promise<void>;
  /** Leave the current room (safe to call best-effort; guards internally). */
  leave(): Promise<void>;
  /**
   * Is media LIVE on this room right now (connected / joining / reconnecting)?
   * Optional: when a platform adapter does not implement it, the controller falls
   * back to its OWN bookkeeping (the room it last handed to {@link join}).
   *
   * Why it exists (call-UX plan K2.3): the resync/adopt paths must be able to tell
   * "the FSM says active" from "media is actually up". Adopting `active` without
   * media is the founder's "I'm in the call and hear nothing" — and re-joining a
   * room we are already connected to would tear the working session down. Only the
   * platform can answer, so the answer is injected instead of guessed.
   */
  isConnectedTo?(roomChannelId: string): boolean;
}

/** The api surface the controller needs (a narrow slice of {@link Api}). */
export type CallApi = Pick<
  Api,
  | "startDmCall"
  | "acceptDmCall"
  | "rejectDmCall"
  | "cancelDmCall"
  | "hangupDmCall"
  | "upgradeDmCall"
  | "getMediaToken"
  | "getActiveDmCall"
>;

/** Names of the control actions, for the optional {@link CallControllerDeps.onError} hook. */
export type CallActionName =
  | "start"
  | "accept"
  | "decline"
  | "cancel"
  | "hangup"
  | "upgrade";

/** Injected timer handle — `ReturnType<typeof setTimeout>` (a number under DOM lib). */
type TimerHandle = ReturnType<typeof setTimeout>;

/** What made the controller re-read the server's authoritative call state. */
export type CallResyncTrigger =
  /** A `call.accepted` the FSM could not place (the lost-frame race, K2.2). */
  | "accepted_out_of_phase"
  /** The realtime socket came back — anything could have happened while away. */
  | "reconnect"
  /** A platform-specific pull (app focus / manual retry). */
  | "manual";

/**
 * One FSM transition, for the SINGLE observability line the plan asks for
 * (K2.7): the pair `voice.status` + `call.phase` is what distinguishes every
 * variant of "accepted but never connected" from every other call complaint, and
 * neither half alone identifies it. `applied: false` means the reducer IGNORED
 * the action — the exact class of bug this wave fixes, so it is logged too.
 */
export interface CallTransition {
  action: CallAction["type"];
  from: CallPhase;
  to: CallPhase;
  applied: boolean;
  callId: CallId | null;
  /** The media FSM's status at this instant, when the platform provides it. */
  voiceStatus: string | null;
}

export interface CallControllerDeps {
  api: CallApi;
  engine: CallVoiceEngine;
  /**
   * The signed-in user's id — used to pick our role (caller vs callee) when a
   * start-409 hands back an already-live call to adopt.
   */
  currentUserId: UserId;
  /**
   * Send the signaling-only `voice.join` for the group voice channel on upgrade
   * (occupancy only — media stays put). Wired by the glue to
   * `realtimeClient.send(clientEvent.voiceJoin({ channelId }))`. Optional: without
   * it the surface still swaps, only occupancy is not announced.
   */
  signalVoiceJoin?: (voiceChannelId: ChannelId) => void;
  /** Ring-timeout scheduling — injected for tests. Defaults to the global timers. */
  setTimer?: (callback: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  /** Fallback ring window (ms) when the server sends no `expiresAt`. ADR default 30s. */
  ringTimeoutMs?: number;
  /** Optional hook for logging/toasting a failed control action (never throws). */
  onError?: (error: unknown, action: CallActionName) => void;
  /**
   * The media FSM's current status (`@demli/media`'s `VoiceStatus`), read as a
   * plain string so this package keeps its lean dependency graph. Used only for
   * the {@link CallTransition} observability line.
   */
  getVoiceStatus?: () => string | null;
  /** Sink for the one-line transition log (K2.7). No-op when absent. */
  onTransition?: (transition: CallTransition) => void;
  /**
   * How many OTHER people the media engine currently sees in the room it is in —
   * `null`/absent when the platform cannot answer.
   *
   * The ONLY input to "am I the last person out?" (ADR 0023 §2), which is what
   * decides whether pressing Leave also ends the call for everyone. There is
   * deliberately no server endpoint for it: the media plane is already the single
   * source of truth for who is in a room (the sweeper's founding principle), and
   * a second, server-side attendance ledger would drift from it.
   *
   * Read only while this device holds the seat, so the count always belongs to
   * the call's own room. An unknown answer is treated as "someone else is still
   * here": leaving a row alive costs a slightly late history line (the sweeper
   * closes it), while wrongly hanging up cuts a conversation that is still going.
   */
  getRemoteParticipantCount?: () => number | null;
}

/** ADR 0012 §4 default ring timeout. */
export const DEFAULT_RING_TIMEOUT_MS = 30_000;

/** What an adopt knows about the call's room beyond the row itself. */
interface AdoptOptions {
  /** A pre-minted grant for the call's room, when the source carried one. */
  credential?: JoinCredential;
  /**
   * The server's media-plane reading of `DmCallActiveResponse.inRoom`:
   * `true` = our identity IS in the room (on some device), `false` = it is not,
   * `null` = the media plane could not be read, `undefined` = this source never
   * had a reading (the start-409 body). The last two are NOT the same: `null` is
   * an answer to act cautiously on, `undefined` is a reason to go ask.
   */
  inRoom?: boolean | null;
}

/**
 * Extra window the CALLEE waits past the ring deadline before ending the ring
 * itself (ADR 0012 §4). The caller's `cancel("timeout")` → server `call.ended`
 * is the authoritative stop; the callee's own timer is a FALLBACK for when that
 * never arrives, so it trails the deadline by this much to let the normal,
 * caller-driven path win the race in the common case.
 */
export const CALLEE_RING_GRACE_MS = 2_000;

/**
 * The controller surface. The store half (`getState`/`subscribe`) binds to the
 * UI; the action half is called by buttons; `applyServerEvent` is fed every
 * server event by the glue (it ignores non-call events).
 */
export interface CallController {
  getState(): CallState;
  subscribe(listener: (state: CallState) => void): () => void;

  /** Start a 1-1 call in a DM (caller). No-op if a call is already live. */
  startCall(input: { dmId: DmId; media: CallMedia }): Promise<void>;
  /** Accept the incoming call (callee). No-op unless ringing incoming. */
  accept(): Promise<void>;
  /** Decline the incoming call (callee). No-op unless ringing incoming. */
  decline(): Promise<void>;
  /** Withdraw our outgoing ring (caller). `reason` defaults to a manual cancel. */
  cancel(reason?: "canceled" | "timeout"): Promise<void>;
  /**
   * End the active call for EVERYONE — the row goes terminal and the peer's
   * `call.ended` follows. No-op unless active.
   *
   * This is no longer what the in-call Leave button does; see {@link leaveRoom}.
   * It stays as the explicit "end this call" action (and as the last-one-out
   * path's implementation).
   */
  hangup(): Promise<void>;
  /**
   * LEAVE THE ROOM — the founder's model, and the whole point of ADR 0023: a DM
   * call is a room, and walking out of one is not the same as ending it.
   *
   * Releases only THIS device's media seat. The call row stays live and the peer
   * keeps talking (or waits); nothing tells them the call ended, so the account
   * can walk back in from any device — the scenario the founder asked for, "leave
   * on mobile, join that same call from the desktop".
   *
   * The one exception is the LAST person out: with nobody left in the room there
   * is no call to walk back into, so this falls through to {@link hangup} and the
   * row (plus its "Call ended · 4:32" history line) closes immediately instead of
   * waiting out the server's alone-grace. The sweeper remains the backstop when
   * this device guesses wrong or never gets to run.
   *
   * No-op unless a DM call is active with the seat on this device.
   */
  leaveRoom(): Promise<void>;
  /**
   * Take the call's media seat onto THIS device (ADR 0023 §3) — "join" from the
   * `vacant` chip, "bring it here" from the `elsewhere` band.
   *
   * The deliberate action that the auto-join gate refuses to take on its own.
   * When the seat is currently on another device, LiveKit's single-connection
   * rule evicts it as this one connects; that device reports the eviction as
   * `seat: "elsewhere"`, not as a call that ended.
   *
   * No-op when no call is live, when the seat is already here, or while another
   * control action is in flight.
   */
  joinHere(): Promise<void>;
  /** Add a third person to the active call (seamless group upgrade). */
  upgrade(input: { inviteeUserId: UserId }): Promise<void>;
  /**
   * Accept the PARKED busy-banner invite: end the current call (server + media),
   * then join the parked call. No-op when nothing is parked.
   */
  acceptPendingInvite(): Promise<void>;
  /**
   * Decline the PARKED busy-banner invite (the current call keeps running). The
   * parked caller gets `declined`. No-op when nothing is parked.
   */
  declinePendingInvite(): Promise<void>;
  /** Clear an ended call back to idle (UI dismiss). */
  dismiss(): void;

  /**
   * Re-read the server's authoritative live call (`GET /dm-calls/active`) and
   * settle the FSM + media onto it (call-UX plan K2.2). Idempotent and
   * single-flight; never throws (a failed resync leaves the current state alone).
   *
   * Call it whenever the client's view of the call may have diverged from the
   * server's: the glue wires it to realtime RECONNECT, and the controller itself
   * runs it when a `call.accepted` arrives that the FSM cannot place.
   */
  resyncActiveCall(trigger?: CallResyncTrigger): Promise<void>;

  /**
   * The media session behind a live call DIED (engine `error` / an unexpected
   * disconnect) — retire the call instead of leaving a phantom `active` slot that
   * blocks every subsequent call (K2.4). Ends the call server-side best-effort so
   * the peer is not left staring at a dead room, then lands `ended: "failed"`.
   * No-op when no call is live.
   */
  reportMediaFailure(): void;

  /** Fed every server event by the glue; reacts only to `call.*` + `voice.session_replaced`. */
  applyServerEvent(event: ServerToClientEvent): void;
  /** Release the ring timer + subscribers (renderer unmount / logout). */
  dispose(): void;
}

export function createCallController(deps: CallControllerDeps): CallController {
  const {
    api,
    engine,
    currentUserId,
    signalVoiceJoin,
    onError,
    getVoiceStatus,
    onTransition,
    getRemoteParticipantCount,
    ringTimeoutMs = DEFAULT_RING_TIMEOUT_MS,
  } = deps;
  const setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h));

  let state: CallState = { ...initialCallState };
  const listeners = new Set<(state: CallState) => void>();
  let ringTimer: TimerHandle | null = null;
  /** Local drop timer for a PARKED busy-banner invite (its own `expiresAt`). */
  let pendingInviteTimer: TimerHandle | null = null;
  /**
   * The room this controller last successfully handed to `engine.join`, cleared on
   * every leave/terminal. The FALLBACK answer to "is media up for this call?" for
   * platforms whose adapter implements no {@link CallVoiceEngine.isConnectedTo}.
   */
  let joinedRoomName: string | null = null;
  /** Single-flight guard for {@link resyncActiveCall}. */
  let resyncInFlight: Promise<void> | null = null;
  /** True once `dispose()` ran — late async work must not resurrect a torn-down slot. */
  let disposed = false;

  function notify(): void {
    const snapshot = state;
    for (const listener of [...listeners]) listener(snapshot);
  }

  /**
   * Apply a pure transition; notify only when the state reference actually changed.
   * EVERY call — applied or ignored — emits the one observability line (K2.7), so
   * a dropped `call.accepted` leaves a trace instead of vanishing.
   */
  function dispatch(action: CallAction): boolean {
    const from = state.phase;
    const next = callReducer(state, action);
    const applied = next !== state;
    if (applied) {
      state = next;
    }
    onTransition?.({
      action: action.type,
      from,
      to: next.phase,
      applied,
      callId: next.callId,
      voiceStatus: getVoiceStatus?.() ?? null,
    });
    if (applied) notify();
    return applied;
  }

  // ── ring timeout (ADR 0012 §4) ────────────────────────────────────────────
  //
  // BOTH lifelines get an independent ring-timeout so a ring can NEVER hang
  // forever regardless of the far side. The server has no active ring-expiry job
  // (it only sweeps a stale row lazily on the next start + guards a late accept),
  // and the `call.ended` that stops the callee is produced ONLY by the caller's
  // `cancel("timeout")` below — so if the caller's app is backgrounded/killed/
  // offline (RN suspends JS timers in the background) or that one signal is lost,
  // the callee would otherwise ring endlessly. The callee's own timer is the
  // safety net that closes that gap.

  function clearRingTimeout(): void {
    if (ringTimer !== null) {
      clearTimer(ringTimer);
      ringTimer = null;
    }
  }

  /**
   * Delay (ms) until a ring should give up, derived from the server's `expiresAt`.
   * CLAMPED to `[0, ringTimeoutMs]`: the server's ring window is at most
   * `ringTimeoutMs` by construction, so device/server CLOCK SKEW can never stretch
   * the timer past it (a phone clock behind the server would otherwise schedule
   * the timeout minutes out → "rings forever"), and a missing/unparseable deadline
   * falls back to the full window rather than `setTimeout(NaN)` (which fires
   * immediately). `graceMs` is added AFTER the clamp so the callee's fallback
   * trails the caller's deadline.
   */
  function ringDelayMs(expiresAt: string | null, graceMs: number): number {
    const deadline = expiresAt ? new Date(expiresAt).getTime() : Number.NaN;
    const remaining = Number.isNaN(deadline)
      ? ringTimeoutMs
      : Math.min(ringTimeoutMs, Math.max(0, deadline - Date.now()));
    return remaining + graceMs;
  }

  /**
   * Arm the single ring-timeout for whichever lifeline is currently ringing. On
   * fire: the CALLER withdraws with `timeout` (server logs it `missed` and tells
   * the callee); the CALLEE ends LOCALLY as a missed call — it cannot author a
   * server `missed` (there is no callee endpoint for it), and the server's accept
   * guard + next-start sweep close the row, so a local stop is the correct,
   * self-contained safety net. `graceMs` lets the callee trail the caller so the
   * caller's authoritative `call.ended` still drives the normal path.
   */
  function scheduleRingTimeout(expiresAt: string | null, graceMs = 0): void {
    clearRingTimeout();
    ringTimer = setTimer(() => {
      ringTimer = null;
      if (state.phase === "outgoing" && state.role === "caller") {
        void cancel("timeout");
      } else if (state.phase === "incoming" && state.role === "callee") {
        // The callee never joined media (still ringing) → no engine leave.
        finishCall("timeout", { leave: false });
      }
    }, ringDelayMs(expiresAt, graceMs));
  }

  // ── parked busy-banner invite (its own local drop timer, ADR 0012 §4) ───────

  function clearPendingInviteTimeout(): void {
    if (pendingInviteTimer !== null) {
      clearTimer(pendingInviteTimer);
      pendingInviteTimer = null;
    }
  }

  /**
   * Drop the parked busy-banner invite when its OWN ring window elapses. We are
   * the callee here, so the server (authoritatively) expires the invite and tells
   * the parked caller; locally we only hide the banner (no endpoint call). Aligned
   * to the parked invite's `expiresAt`.
   */
  function schedulePendingInviteTimeout(callId: string, expiresAt: string): void {
    clearPendingInviteTimeout();
    const ms = Math.max(0, new Date(expiresAt).getTime() - Date.now());
    pendingInviteTimer = setTimer(() => {
      pendingInviteTimer = null;
      dispatch({ type: "clear_pending_invite", callId });
    }, ms);
  }

  /** Clear the parked invite from state AND cancel its drop timer together. */
  function clearPendingInvite(callId: string): void {
    clearPendingInviteTimeout();
    dispatch({ type: "clear_pending_invite", callId });
  }

  // ── engine helpers ────────────────────────────────────────────────────────

  /** Leave the room, swallowing "not in a room" guard errors. */
  async function leaveEngineSafely(): Promise<void> {
    joinedRoomName = null;
    try {
      await engine.leave();
    } catch {
      // Already idle / invalid-in-status — nothing to leave.
    }
  }

  /**
   * Is media live on `roomName`? The platform's answer when the adapter provides
   * one (it can see reconnects and evictions this controller never hears about),
   * otherwise this controller's own join bookkeeping.
   */
  function mediaLiveOn(roomName: string): boolean {
    const platform = engine.isConnectedTo?.(roomName);
    if (platform !== undefined) return platform;
    return joinedRoomName === roomName;
  }

  /** Record where this device's media sits for the current call (ADR 0023 §1). */
  function setSeat(seat: CallSeat): void {
    dispatch({ type: "seat", seat });
  }

  /**
   * Join `roomName` unless media is already live on it. Records the room AND the
   * seat on success — every path into the call's room goes through here, so this
   * is the one place `seat: "here"` is ever established.
   */
  async function joinMedia(roomName: string, credential: JoinCredential): Promise<void> {
    if (mediaLiveOn(roomName)) {
      setSeat("here");
      return;
    }
    await engine.join(roomName, credential);
    joinedRoomName = roomName;
    setSeat("here");
  }

  /**
   * Does THIS DEVICE hold the call's media seat right now?
   *
   * The gate on every teardown that would call `engine.leave()`. Under the seat
   * model a device can hold a live call slot while its media is somewhere else
   * entirely — the "in a call on your phone" band, or a desktop sitting in a
   * SERVER voice channel while the phone runs the DM call. Leaving
   * unconditionally in that state would tear down whatever room this device
   * happens to be in, which is not ours to end.
   *
   * The engine's own answer is accepted alongside the flag so a half-established
   * join (the seat was never recorded, but a session exists) is still cleaned up.
   */
  function holdsCallSeat(): boolean {
    if (state.seat === "here") return true;
    return state.roomName !== null && mediaLiveOn(state.roomName);
  }

  /**
   * Land on the terminal `ended` state and (optionally) release media. `leave` is
   * false only for a single-session eviction, where the engine already left; even
   * when it is true, media is released ONLY if this device actually holds the
   * call's seat (see {@link holdsCallSeat}).
   */
  function finishCall(
    reason: CallEndedReason,
    options: { leave?: boolean } = {},
  ): void {
    clearRingTimeout();
    // The primary call ending also drops any parked busy-banner invite (the
    // `ended` reducer clears the state field; the timer must be cancelled too).
    clearPendingInviteTimeout();
    // Read the seat BEFORE the transition — `ended` vacates it.
    const held = holdsCallSeat();
    dispatch({ type: "ended", callId: state.callId, reason });
    if (options.leave !== false && held) void leaveEngineSafely();
    else joinedRoomName = null;
  }

  /**
   * Tell the SERVER this call is over, picking the endpoint that matches the phase
   * the call is in — and, critically, falling back the OTHER way on a 409.
   *
   * WHY the fallback (call-UX plan K2.3): `cancel` is caller-only and legal ONLY
   * while the row is still `ringing`. If the callee accepted while our media was
   * coming up, the row is already `active`, so `cancel` 409s and — before this —
   * that 409 was swallowed: the row stayed `active` FOREVER (until the 3-6 minute
   * sweeper), `isCallLive` locked out every retry, and the founder's only escape
   * was leaving and calling again. A 409 from `cancel` means "it was accepted" →
   * `hangup` instead, which is idempotent for either participant.
   */
  async function endCallServerSide(
    callId: CallId,
    phase: CallPhase,
    options: { reason?: "canceled" | "timeout"; role?: CallRole | null } = {},
  ): Promise<void> {
    const reason = options.reason ?? "canceled";
    const role = options.role ?? state.role;
    /** Terminals to try, in order. The 2nd runs ONLY on a 409 from the 1st. */
    const attempts: { name: CallActionName; run: () => Promise<unknown> }[] =
      phase === "outgoing"
        ? [
            { name: "cancel", run: () => api.cancelDmCall(callId, reason) },
            { name: "hangup", run: () => api.hangupDmCall(callId) },
          ]
        : phase === "incoming"
          ? [
              { name: "decline", run: () => api.rejectDmCall(callId) },
              { name: "hangup", run: () => api.hangupDmCall(callId) },
            ]
          : [
              { name: "hangup", run: () => api.hangupDmCall(callId) },
              // Fall back to the terminal our ROLE is allowed to author: `cancel`
              // is caller-only, `reject` callee-only, so guessing wrong turns the
              // recovery into a 403 that leaves the row open.
              role === "callee"
                ? { name: "decline", run: () => api.rejectDmCall(callId) }
                : { name: "cancel", run: () => api.cancelDmCall(callId, reason) },
            ];

    for (const [index, attempt] of attempts.entries()) {
      try {
        await attempt.run();
        return;
      } catch (error) {
        const conflict = error instanceof ApiClientError && error.code === "CONFLICT";
        const last = index === attempts.length - 1;
        if (!conflict || last) {
          onError?.(error, attempt.name);
          return;
        }
        // 409 → the row is not in the state we assumed; try the other terminal.
      }
    }
  }

  // ── control actions ───────────────────────────────────────────────────────

  async function startCall(input: { dmId: DmId; media: CallMedia }): Promise<void> {
    if (isCallLive(state)) return; // already busy — Wave 6/7 owns the busy UI
    // Re-entrancy (K2.5): a second tap while the first `POST /dm-calls` is still
    // in flight would create a SECOND row (or a 429 from the start cooldown) and
    // race two joins on one engine. The phase is still `idle` here, so `pending`
    // is the only thing that knows a start is under way.
    if (state.pending) return;
    dispatch({ type: "pending", pending: true });

    let call: DmCall;
    let credential: JoinCredential;
    let roomName: string;
    try {
      const res = await api.startDmCall(input);
      call = res.call;
      roomName = res.roomName;
      credential = { url: res.url, token: res.token };
    } catch (error) {
      dispatch({ type: "pending", pending: false });
      // 409: a call is already live in this DM → adopt/rejoin the existing one.
      if (error instanceof ApiClientError && error.code === "CONFLICT") {
        const existing = (error.details as { call?: DmCall } | null)?.call;
        if (existing) {
          adoptExistingCall(existing);
          return;
        }
      }
      onError?.(error, "start");
      throw error;
    }

    dispatch({ type: "outgoing_started", call });
    // Only ring while we are ACTUALLY ringing: the callee can have accepted (and
    // this client resynced itself to `active`) before this response landed, in
    // which case the reducer kept `active` and a ring timer would later "time out"
    // a live call.
    if (state.phase === "outgoing") scheduleRingTimeout(call.expiresAt);

    try {
      await joinMedia(roomName, credential);
    } catch (error) {
      onError?.(error, "start");
      // Media never came up — withdraw the call (server + local) so it can't hang.
      // The phase decides WHICH terminal the server needs: an accept may have
      // landed while we were joining, and cancelling an accepted call 409s and
      // leaves the row `active` forever (K2.3).
      const callId = call.id;
      const phase = state.phase;
      finishCall("failed");
      await endCallServerSide(callId, phase);
    }
  }

  /**
   * Adopt an already-live call — from a start-409 (`{ error, call }`) or from the
   * `GET /dm-calls/active` resync — and settle this device's SEAT against it.
   *
   * The media half is the fix for the founder's "kabul etti ama bağlanmadı"
   * (K2.3): this used to flip the FSM to `active` and stop, assuming media was
   * already up on this device. When it was not — a retry after a failed join, a
   * resync of an accept we never processed — the user sat in a call UI with no
   * LiveKit session at all: "odadayım, hiçbir şey duymuyorum", and the row stayed
   * `active` so no new call could be placed either.
   *
   * It then over-corrected. Once `call.accepted` started reaching the answering
   * user's OTHER devices, every one of them resynced, adopted, and joined the
   * room WITH THE SAME LIVEKIT IDENTITY — and LiveKit permits one connection per
   * identity, so the desktop's silent housekeeping disconnected the phone the
   * user was actually talking on. {@link settleAdoptedSeat} is the gate that
   * closes that: joining is conditional on the media plane saying the seat is
   * genuinely free.
   */
  function adoptExistingCall(call: DmCall, options: AdoptOptions = {}): void {
    const role: CallRole = call.callerId === currentUserId ? "caller" : "callee";
    dispatch({ type: "adopt", call, role });
    if (state.callId === call.id && (state.phase === "active" || state.phase === "outgoing")) {
      void settleAdoptedSeat(call, options);
    }
    // Arm the give-up timer for EITHER role. The callee arm is not symmetry for
    // its own sake: pressing "call" on a DM where the peer is already ringing US
    // 409s back THAT call, and adopting it puts us in `incoming` — i.e. it starts
    // the ringtone. Without a timer here that ring had no upper bound at all and
    // depended entirely on the caller's `call.ended` ever arriving (founder P0:
    // "zil durmuyor"). `ringDelayMs` clamps to the ring window, so the ring is now
    // bounded whatever the adopted row claims. The callee trails the caller by
    // CALLEE_RING_GRACE_MS so the caller's authoritative end still wins normally.
    if (call.status === "ringing") {
      scheduleRingTimeout(call.expiresAt, role === "callee" ? CALLEE_RING_GRACE_MS : 0);
    } else {
      // Adopting a call that is no longer ringing (the resync of an accept we
      // missed) must also DISARM the ring we were still counting down, or a stale
      // timer sits over a live call.
      clearRingTimeout();
    }
  }

  /**
   * THE AUTO-JOIN GATE (ADR 0023 §3). Decide what this device's seat is for a
   * call it just adopted, and bring media up ONLY when the seat is provably free.
   *
   * `inRoom` is the server's media-plane reading of "is this ACCOUNT's identity
   * in the room" — it cannot say WHICH device, because a LiveKit identity is the
   * user id. So the two questions are answered by two different oracles and the
   * order matters:
   *
   *   1. our own engine — "is it THIS device?" If yes we are done; nothing to fix.
   *   2. `inRoom` — "is it SOME device?" If yes (or if the media plane could not
   *      be read at all) the seat is not ours to take silently. Joining anyway is
   *      exactly the duplicate-identity kick this gate exists to prevent, so this
   *      device sits on the `elsewhere` band and waits for the user.
   *   3. `inRoom === false` — nobody of ours is in the room, so a join can hurt
   *      no one. This is the media-repair path from K2.3, unchanged.
   *
   * `undefined` (as opposed to `null`) means we were never given an answer at all
   * — the start-409 body carries no media-plane reading. Rather than guess, ask:
   * one resync re-enters here with a real value.
   */
  async function settleAdoptedSeat(call: DmCall, options: AdoptOptions): Promise<void> {
    // A ringing CALLEE holds no seat and has no grant — /accept is the only way
    // into the room, so there is nothing to settle and nothing to join.
    if (state.callId !== call.id) return;
    if (state.phase !== "active" && state.phase !== "outgoing") return;

    if (mediaLiveOn(call.roomName)) {
      joinedRoomName = call.roomName;
      setSeat("here");
      return;
    }

    const { inRoom, credential } = options;
    if (inRoom === true || inRoom === null) {
      // Occupied by another device of ours, or unreadable. Both mean "hands off".
      setSeat("elsewhere");
      return;
    }
    if (inRoom === false) {
      setSeat("vacant");
      await ensureAdoptedMedia(call, credential);
      return;
    }
    // No reading in hand. Stay out of the room until we have one; the resync
    // response carries `inRoom` and re-enters this function through `adopt`.
    setSeat("elsewhere");
    if (resyncInFlight !== null) return;
    await resyncActiveCall("manual");
  }

  /**
   * Bring media up for a call we just adopted, if it is not already live. Ends the
   * call cleanly when it cannot be done — never leaves a media-less `active`.
   */
  async function ensureAdoptedMedia(
    call: DmCall,
    credential: JoinCredential | undefined,
  ): Promise<void> {
    if (mediaLiveOn(call.roomName)) return;
    if (credential) {
      try {
        await joinMedia(call.roomName, credential);
        return;
      } catch (error) {
        onError?.(error, "accept");
        failAdoptedCall(call);
        return;
      }
    }
    // No grant in hand. The resync endpoint mints one; it will re-enter this
    // function WITH a credential. Only worth trying once — a resync already under
    // way is the same request.
    if (resyncInFlight !== null) return;
    await resyncActiveCall("manual");
    if (state.callId !== call.id || !isCallLive(state)) return;
    // A seat that landed anywhere but `here` is a DECISION, not a failure: the
    // resync found the room occupied by another of our devices and deliberately
    // stayed out. Failing the call there would hang up on the device that is
    // actually in it — the very bug the gate above prevents.
    if (state.seat !== "vacant") return;
    if (!mediaLiveOn(call.roomName)) failAdoptedCall(call);
  }

  /** Media could not be established for an adopted call → close it, both sides. */
  function failAdoptedCall(call: DmCall): void {
    if (state.callId !== call.id || !isCallLive(state)) return;
    const phase = state.phase;
    finishCall("failed");
    void endCallServerSide(call.id, phase);
  }

  /**
   * Re-read the authoritative live call and settle onto it (K2.2). See
   * {@link CallController.resyncActiveCall}.
   */
  function resyncActiveCall(trigger: CallResyncTrigger = "manual"): Promise<void> {
    if (resyncInFlight !== null) return resyncInFlight;
    const run = (async () => {
      try {
        await performResync(trigger);
      } catch (error) {
        // A resync is best-effort healing: on a network/5xx failure KEEP the
        // current view (§26 — never turn a hiccup into a lost call) and let the
        // next trigger try again.
        onError?.(error, "start");
      } finally {
        resyncInFlight = null;
      }
    })();
    resyncInFlight = run;
    return run;
  }

  async function performResync(trigger: CallResyncTrigger): Promise<void> {
    // A post-upgrade GROUP surface is no longer a DM-call row (the row closes as
    // `upgraded` while the three keep talking), so the DM-call endpoint has no
    // authority over it — reading it would "end" a perfectly live group call.
    if (state.surface?.kind === "group") return;

    const snapshot = await api.getActiveDmCall();
    if (disposed) return;
    const call = snapshot.call;
    const live = call !== null && (call.status === "ringing" || call.status === "active");

    if (!live) {
      // A row that closed as `upgraded` is NOT a dead call — the participants keep
      // talking in the new group's voice channel (ADR 0012 §6). Never end media on it.
      if (call?.status === "upgraded") return;
      // The server says nothing is live. Only act on that when we are NOT in the
      // middle of a control action: a `{ call: null }` read can legitimately race a
      // start whose row is not committed yet, and ending a call we are creating
      // would be a worse bug than the one we are fixing.
      if (state.pending || !isCallLive(state) || state.surface?.kind !== "dm") return;
      if (trigger === "accepted_out_of_phase") return; // an accept implies a row exists
      if (call !== null && state.callId !== call.id) return; // a terminal for some other call
      finishCall(endedReasonForStatus(call?.status ?? null));
      return;
    }

    // Credentials live under `media`, and are null for a callee still being rung
    // (the token is only minted by /accept). Reading them off the top level —
    // which an earlier draft of the client type did — silently yields undefined,
    // so the resync would hang up the call it exists to repair.
    const credential =
      snapshot.media?.url && snapshot.media?.token
        ? { url: snapshot.media.url, token: snapshot.media.token }
        : undefined;
    // The media plane's reading of our own seat (ADR 0023 §3). `undefined` from an
    // older server is normalized to `null` — "unknown", the cautious answer —
    // rather than being mistaken for "the room is free".
    const inRoom = snapshot.inRoom ?? null;

    // Already settled on exactly this call → nothing about the ROW to heal. For an
    // `active` row that includes media actually being up: "FSM active, no LiveKit
    // session" is precisely the state this resync exists to repair.
    const sameCall = state.callId === call.id;
    const inSyncRinging =
      call.status === "ringing" &&
      sameCall &&
      (state.phase === "outgoing" || state.phase === "incoming");
    const inSyncActive =
      call.status === "active" &&
      sameCall &&
      state.phase === "active" &&
      mediaLiveOn(call.roomName);
    if (inSyncRinging || inSyncActive) {
      // The ROW matches; the SEAT still might not (we may have adopted this call
      // with no media-plane reading and parked on `elsewhere`). Settle it from the
      // fresh answer without re-adopting — an `adopt` here would throw away the
      // peer profile the event stream carries and the row's own read does not.
      await settleAdoptedSeat(call, { credential, inRoom });
      return;
    }

    // A DIFFERENT call is live server-side while we hold a live slot: the server is
    // the authority (our slot is stale), so adopt — `adopt` overwrites the slot.
    adoptExistingCall(call, { credential, inRoom });
  }

  /**
   * Map a resynced row's TERMINAL status onto the FSM's ended reason, so the outcome
   * banner tells the truth about a call that ended while we were not listening
   * (§26). `null`/unknown → `failed`: we know it is over, not why.
   */
  function endedReasonForStatus(status: string | null): CallEndedReason {
    switch (status) {
      case "declined":
        return "declined";
      case "canceled":
        return "canceled";
      case "missed":
        return "timeout";
      case "failed":
        return "failed";
      default:
        // Includes the `{ call: null }` answer: the server has NO live call for us,
        // which is overwhelmingly "it is over" (the peer hung up, or the sweeper
        // closed a stale row) rather than "it broke". "Call ended" is the honest,
        // non-alarming outcome for that (§26) — never claim a failure we cannot see.
        return "hung_up";
    }
  }

  function reportMediaFailure(): void {
    if (!isCallLive(state) || state.callId === null) return;
    const callId = state.callId;
    const phase = state.phase;
    // The engine is already dead/erroring — `leave: false` so we don't ask it to
    // tear down a room it has no handle on (it settles itself), but the room
    // bookkeeping must drop or a retry would think media is still up.
    finishCall("failed", { leave: false });
    void endCallServerSide(callId, phase);
  }

  async function accept(): Promise<void> {
    const current = state;
    if (current.phase !== "incoming" || current.callId === null || current.surface === null) {
      return;
    }
    // Re-entrancy (K2.5): a double-tap (or Accept + Accept-with-video) used to run
    // TWO accepts. The second `leaveEngineSafely` bumps the engine's command epoch,
    // so the FIRST join returns early having connected nothing, and the second
    // `POST /accept` 409s — an accepted call with no media on the callee side, i.e.
    // exactly the founder's symptom from the other end. One accept at a time.
    if (current.pending) return;
    const { callId, surface } = current;
    // The user answered — stop the callee's give-up timer so it can't fire during
    // the accept round-trip. It is restored below only if the accept fails and we
    // fall back to ringing (so a recoverable failure never loses the safety net).
    clearRingTimeout();
    dispatch({ type: "pending", pending: true });
    let grant: { roomName: string; url: string; token: string };
    try {
      // Single-active-session (ADR 0012 §5): if we were already in ANOTHER voice
      // session (typically a server voice room), LEAVE it BEFORE minting + joining
      // the call room. JOIN is illegal from a live engine status (§11 FSM: JOIN ∈
      // {idle, error}); accepting straight into join throws InvalidVoiceCommandError
      // and breaks the accept — the founder's P0 crash/freeze when answering while
      // in a server. Leaving HERE, ahead of the accept endpoint (which also evicts
      // us server-side via recordAndEvict), settles the engine to idle first and
      // sidesteps the eviction↔join race entirely: any late `voice.session_replaced`
      // for the old room is then ignored (roomId no longer matches). Mirrors
      // acceptPendingInvite → endCurrentCallForSwitch's leave-before-join order. A
      // guard-swallowed no-op when already idle.
      await leaveEngineSafely();
      grant = await mintAcceptGrant(callId, surface);
    } catch (error) {
      onError?.(error, "accept");
      // A stale ring (server: no longer ringing / expired) → drop it; the matching
      // `call.ended` may also arrive and is then ignored (callId no longer current).
      if (
        error instanceof ApiClientError &&
        error.code === "CONFLICT" &&
        state.phase === "incoming" &&
        state.callId === callId
      ) {
        dispatch({ type: "reset" });
      } else {
        dispatch({ type: "pending", pending: false });
        // Still ringing after a recoverable failure → re-arm the give-up timer.
        if (state.phase === "incoming" && state.callId === callId) {
          scheduleRingTimeout(current.expiresAt, CALLEE_RING_GRACE_MS);
        }
      }
      throw error;
    }

    // The grant exists ⇒ the SERVER already flipped the row to `active` and told
    // the caller we answered. From here a media failure may NOT be treated as "we
    // are still ringing": the caller is sitting in a live room believing we joined
    // (the founder's exact report, seen from the answering side). Close the call on
    // BOTH planes so the retry is instant instead of waiting out the sweeper (K2.3).
    try {
      await joinMedia(grant.roomName, { url: grant.url, token: grant.token });
      dispatch({ type: "accept_confirmed", callId, roomName: grant.roomName });
    } catch (error) {
      onError?.(error, "accept");
      finishCall("failed");
      void endCallServerSide(callId, "active", { role: "callee" });
      throw error;
    }
  }

  /** Mint the join grant for an accept: dm → accept endpoint; group ring → media token. */
  async function mintAcceptGrant(
    callId: string,
    surface: CallSurface,
  ): Promise<{ roomName: string; url: string; token: string }> {
    if (surface.kind === "dm") {
      const res = await api.acceptDmCall(callId);
      return { roomName: res.roomName, url: res.url, token: res.token };
    }
    // Group-upgrade ring: joining the group voice channel resolves — server-side —
    // to the ongoing call room (ADR 0012 §6), so the invitee lands in the live call.
    const res = await api.getMediaToken(surface.voiceChannelId);
    return { roomName: res.roomName, url: res.url, token: res.token };
  }

  async function decline(): Promise<void> {
    const current = state;
    if (current.phase !== "incoming" || current.callId === null || current.surface === null) {
      return;
    }
    const { callId, surface } = current;
    // Optimistic: stop ringing at once. The callee never joined media → no leave.
    finishCall("declined", { leave: false });
    if (surface.kind === "dm") {
      try {
        await api.rejectDmCall(callId);
      } catch (error) {
        onError?.(error, "decline");
      }
    }
    // A group-upgrade ring has no server "reject" — declining just leaves the
    // invitee a member of the new group (ADR 0012 §6).
  }

  async function cancel(reason: "canceled" | "timeout" = "canceled"): Promise<void> {
    const current = state;
    if (current.phase !== "outgoing" || current.callId === null) return;
    const callId = current.callId;
    const role = current.role;
    // Optimistic terminal + release our (solo) media session.
    finishCall(reason);
    // Via the 409-tolerant terminal (K2.3): the ring-timeout cancel racing a fresh
    // accept is EXACTLY the founder's stuck call — a swallowed 409 there left the
    // row `active` with nobody in it and locked out every retry.
    await endCallServerSide(callId, "outgoing", { reason, role });
  }

  async function hangup(): Promise<void> {
    const current = state;
    if (current.phase !== "active" || current.callId === null) return;
    const callId = current.callId;
    const role = current.role;
    finishCall("hung_up");
    await endCallServerSide(callId, "active", { role });
  }

  /**
   * Are we the LAST person in the call's room (ADR 0023 §2)?
   *
   * Asked of the media plane through the platform, because that is the only place
   * the answer exists. UNKNOWN COUNTS AS "NO", deliberately: the two ways of being
   * wrong are not symmetric. Believing we are alone when we are not hangs up on a
   * live conversation; believing someone is left when nobody is leaves a row open
   * that the server's alone-grace sweep closes a few minutes later, costing only a
   * late history line.
   */
  function isLastInRoom(): boolean {
    const remote = getRemoteParticipantCount?.();
    if (remote === null || remote === undefined) return false;
    return remote === 0;
  }

  /**
   * Walk out of the call's room without ending the call (ADR 0023 §2). See
   * {@link CallController.leaveRoom}.
   */
  async function leaveRoom(): Promise<void> {
    const current = state;
    if (current.phase !== "active" || current.callId === null) return;
    // A post-upgrade GROUP surface is an ordinary voice channel — it is left
    // through the voice UI, and its call row is already closed as `upgraded`.
    if (current.surface?.kind !== "dm") return;
    if (!holdsCallSeat()) return;

    const callId = current.callId;
    const role = current.role;
    // Decide BEFORE releasing media: once we disconnect, the engine's participant
    // list is gone and "was anyone else there?" becomes unanswerable.
    const alone = isLastInRoom();

    // Vacate the seat BEFORE the engine reaches idle. The media watcher
    // (`decideCallMediaOutcome`) reads the seat to tell a deliberate exit from a
    // session that died; with the flag set late it would see `here` + `idle` and
    // report a media failure, ending the very call we are keeping alive.
    setSeat("vacant");
    await leaveEngineSafely();

    if (!alone) return;
    // Nobody left behind ⇒ there is no room to come back to. Close the row now so
    // the "Call ended · 4:32" line lands immediately instead of at the sweep.
    finishCall("hung_up", { leave: false });
    await endCallServerSide(callId, "active", { role });
  }

  /** Take the call's media seat onto this device. See {@link CallController.joinHere}. */
  async function joinHere(): Promise<void> {
    const current = state;
    if (current.callId === null || !isCallLive(current)) return;
    if (current.phase !== "active" && current.phase !== "outgoing") return;
    if (current.seat === "here" || current.pending) return;
    const callId = current.callId;
    dispatch({ type: "pending", pending: true });
    try {
      // Always re-read: the grant this device holds may be minutes old, and the
      // row may have moved on entirely while we sat on the band.
      const snapshot = await api.getActiveDmCall();
      if (disposed) return;
      const call = snapshot.call;
      if (!call || call.id !== callId || (call.status !== "ringing" && call.status !== "active")) {
        // The call we were offered a seat in is gone. Let the normal resync path
        // settle the slot rather than inventing an outcome here.
        dispatch({ type: "pending", pending: false });
        await resyncActiveCall("manual");
        return;
      }
      const credential =
        snapshot.media?.url && snapshot.media?.token
          ? { url: snapshot.media.url, token: snapshot.media.token }
          : undefined;
      if (!credential) {
        // Entitled users always get one; without it there is no way in, and
        // pretending otherwise would leave a call UI over no media.
        onError?.(new Error("No media credential for this call"), "accept");
        return;
      }
      // This is the DELIBERATE takeover: if another device holds the seat, the
      // server's single-session rule evicts it as we connect, and it reports that
      // as `seat: "elsewhere"` — not as a call that ended.
      await joinMedia(call.roomName, credential);
    } catch (error) {
      onError?.(error, "accept");
    } finally {
      dispatch({ type: "pending", pending: false });
    }
  }

  async function upgrade(input: { inviteeUserId: UserId }): Promise<void> {
    const current = state;
    if (current.phase !== "active" || current.callId === null) return;
    try {
      await api.upgradeDmCall(current.callId, input);
    } catch (error) {
      onError?.(error, "upgrade");
      throw error;
    }
    // The surface swap + occupancy signal happen when our OWN `call.upgraded`
    // arrives (the server sends it to BOTH originals, the inviter included).
  }

  // ── parked busy-banner invite: accept-and-switch / decline ──────────────────

  /**
   * End the CURRENT call so we can switch to the parked one: tell the server
   * (peer gets `call.ended`) and release its media. Best-effort — a failed
   * endpoint must not block the switch. Does NOT dispatch `ended`: the follow-up
   * `promote_pending_invite` overwrites the whole slot anyway.
   */
  async function endCurrentCallForSwitch(): Promise<void> {
    const current = state;
    const callId = current.callId;
    clearRingTimeout();
    if (callId !== null) {
      try {
        if (current.phase === "active") await api.hangupDmCall(callId);
        else if (current.phase === "outgoing") await api.cancelDmCall(callId, "canceled");
      } catch (error) {
        onError?.(error, current.phase === "outgoing" ? "cancel" : "hangup");
      }
    }
    await leaveEngineSafely();
  }

  async function acceptPendingInvite(): Promise<void> {
    // Capture the parked invite up front so a racing `call.ended` (from tearing
    // the current call down) can't null it out from under us.
    const invite = state.pendingInvite;
    if (invite === null) return;
    // Re-entrancy (K2.5): the switch tears the current call down before joining the
    // parked one, so a second tap mid-switch would leave BOTH calls half-ended.
    if (state.pending) return;
    clearPendingInviteTimeout();
    // Commit to the switch: drop the banner immediately, and mark the whole switch
    // in-flight so the UI can disable its buttons and the platform glue knows the
    // engine's leave/join churn is expected (not a media failure).
    dispatch({ type: "pending", pending: true });
    dispatch({ type: "clear_pending_invite", callId: invite.callId });
    try {
      // 1. End the current call (server + media) — "accepting ends the current call".
      await endCurrentCallForSwitch();
      // 2. Mint the parked call's grant and JOIN its media BEFORE flipping the FSM,
      //    so the switch lands straight on `active` (§3) with no incoming-ring
      //    flash and no ringtone during the handover.
      const grant = await mintAcceptGrant(invite.callId, invite.surface);
      await joinMedia(grant.roomName, { url: grant.url, token: grant.token });
      dispatch({ type: "promote_active", invite, roomName: grant.roomName });
      clearRingTimeout();
    } catch (error) {
      onError?.(error, "accept");
      // The switch failed after the current call was torn down → clean terminal.
      // If the switch got as far as the accept endpoint, the parked call's row is
      // already `active` with nobody from this side in it — close it too (K2.3),
      // best-effort, so its caller is not stranded in a room alone.
      finishCall("failed");
      void endCallServerSide(invite.callId, "active", { role: "callee" });
    }
  }

  async function declinePendingInvite(): Promise<void> {
    const invite = state.pendingInvite;
    if (invite === null) return;
    // Optimistic: drop the banner + its timer at once; the current call runs on.
    clearPendingInvite(invite.callId);
    if (invite.surface.kind === "dm") {
      try {
        await api.rejectDmCall(invite.callId);
      } catch (error) {
        onError?.(error, "decline");
      }
    }
    // A group-upgrade ring has no server "reject" (mirror of `decline()`).
  }

  function dismiss(): void {
    clearPendingInviteTimeout();
    dispatch({ type: "reset" });
  }

  // ── server event intake ─────────────────────────────────────────────────

  function handleInvite(payload: CallInvitePayload): void {
    const surface: CallSurface =
      payload.target.kind === "dm"
        ? { kind: "dm", dmId: payload.target.dmId }
        : {
            kind: "group",
            groupId: payload.target.groupId,
            voiceChannelId: payload.target.voiceChannelId,
          };
    const before = state;
    dispatch({
      type: "invited",
      callId: payload.callId,
      media: payload.media,
      caller: payload.caller,
      surface,
      expiresAt: payload.expiresAt,
    });
    if (state === before) return; // duplicate / ignored while busy
    if (state.phase === "incoming" && state.callId === payload.callId) {
      // A FRESH inbound ring → arm the callee's independent give-up timer so it can
      // never ring forever if the caller's `call.ended` never arrives (see the
      // ring-timeout note above). Trails the deadline by CALLEE_RING_GRACE_MS.
      scheduleRingTimeout(payload.expiresAt, CALLEE_RING_GRACE_MS);
    } else if (state.pendingInvite?.callId === payload.callId) {
      // A SECOND invite PARKED while busy (not a fresh ring) → its own local drop
      // timer to its `expiresAt`, so the busy banner clears when it expires.
      schedulePendingInviteTimeout(payload.callId, payload.expiresAt);
    }
  }

  /**
   * The peer answered our outgoing call. THE frame this whole wave is about
   * (founder: "bazen karşıdaki kabul etse bile bağlantı sağlanamıyor").
   *
   * `call.accepted` is fan-out to whatever sockets are connected at that instant,
   * with no queue and no replay, and it can legitimately arrive BEFORE this client
   * has anything to place it against: `POST /dm-calls` publishes the invite and
   * then awaits a push round-trip, so the callee can accept while our own 201 — the
   * thing that puts the FSM into `outgoing` — is still in flight. The reducer
   * (correctly) ignores an out-of-phase accept; the bug was that NOTHING followed
   * up, so the caller rang into a timeout while the callee sat in a live room, the
   * row stayed `active`, and every retry was locked out until the sweeper.
   *
   * Now an ignored accept triggers a RESYNC against the authoritative
   * `GET /dm-calls/active` (K2.2), which adopts the call and brings media up.
   */
  function handleAccepted(payload: CallAcceptedPayload): void {
    const applied = dispatch({
      type: "accepted_by_peer",
      callId: payload.callId,
      callee: payload.callee,
    });
    if (applied) {
      // Only NOW is the ring over. Clearing unconditionally (as this used to) let a
      // stale/duplicate accepted frame for some other call kill a live ring timer
      // that was never re-armed — an unbounded ring (K2.6).
      clearRingTimeout();
      // The phase is right, but is the MEDIA? A caller whose LiveKit session died
      // during the ring (or whose join silently failed) would otherwise go `active`
      // over nothing at all — the founder's symptom without any error to show for
      // it. Repair through the same resync, which mints a fresh grant.
      if (state.roomName === null || !mediaLiveOn(state.roomName)) {
        void resyncActiveCall("accepted_out_of_phase");
      }
      return;
    }
    // Already active on this exact call → the frame is a duplicate, nothing to heal.
    if (state.callId === payload.callId && state.phase === "active") return;
    void resyncActiveCall("accepted_out_of_phase");
  }

  function handleEnded(payload: CallEndedPayload): void {
    // A terminal for the PARKED busy-banner invite (its caller gave up / it
    // expired server-side) → just drop the banner; the primary call is untouched.
    if (state.pendingInvite !== null && payload.callId === state.pendingInvite.callId) {
      clearPendingInvite(payload.callId);
      return;
    }
    if (payload.callId !== state.callId) return; // stale / other call
    // `upgraded` keeps media alive (it is normally delivered as `call.upgraded`,
    // never `call.ended`; guard defensively so a stray one never drops media).
    finishCall(payload.reason, { leave: payload.reason !== "upgraded" });
  }

  function handleUpgraded(payload: CallUpgradedPayload): void {
    const before = state;
    dispatch({
      type: "upgraded",
      callId: payload.callId,
      group: payload.group,
      voiceChannelId: payload.voiceChannelId,
    });
    // Announce occupancy for the group voice channel ONLY if the upgrade applied.
    // Media stays on the same LiveKit room — no engine.leave()/join() (§6).
    if (state !== before) signalVoiceJoin?.(payload.voiceChannelId);
  }

  function handleSessionReplaced(payload: VoiceSessionReplacedPayload): void {
    // Single-session (ADR 0012 §5): our media was taken over on another device.
    //
    // This used to be TERMINAL — the call landed on `ended: session_replaced`.
    // Under the seat model that is simply false (ADR 0023 §3): the call is very
    // much alive, we just answered it somewhere else. Telling the user "call
    // ended" the instant they pick it up on their phone is the opposite of the
    // handoff the founder asked for. Only the SEAT moved; the row is untouched,
    // and this device can take it back with `joinHere()`.
    //
    // No `engine.leave()`: the engine already evicted itself.
    if (!isCallLive(state)) return;
    if (state.roomName !== null && payload.roomId === state.roomName) {
      joinedRoomName = null;
      setSeat("elsewhere");
    }
  }

  function applyServerEvent(event: ServerToClientEvent): void {
    switch (event.type) {
      case "call.invite":
        handleInvite(event.payload);
        break;
      case "call.accepted":
        handleAccepted(event.payload);
        break;
      case "call.ended":
        handleEnded(event.payload);
        break;
      case "call.upgraded":
        handleUpgraded(event.payload);
        break;
      case "voice.session_replaced":
        handleSessionReplaced(event.payload);
        break;
      default:
        break; // not a call event — ignore
    }
  }

  function dispose(): void {
    disposed = true;
    clearRingTimeout();
    clearPendingInviteTimeout();
    listeners.clear();
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    startCall,
    accept,
    decline,
    cancel,
    hangup,
    leaveRoom,
    joinHere,
    upgrade,
    acceptPendingInvite,
    declinePendingInvite,
    dismiss,
    resyncActiveCall,
    reportMediaFailure,
    applyServerEvent,
    dispose,
  };
}
