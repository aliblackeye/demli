/**
 * The VOICE↔CALL bridge (call-UX plan K2.3/K2.4/K2.8) — the platform-independent
 * half of the wiring that makes the connectivity fixes in {@link createCallController}
 * actually FIRE.
 *
 * The controller repairs a call whose media died or never came up, but it cannot
 * observe media itself: it only learns about it through the two seams below, and
 * both of those used to be hand-wired per platform. Desktop got them; mobile did
 * not — so the phone kept the old behavior (a peer could accept and the call still
 * never connect, with leaving the room as the only escape). The DECISIONS therefore
 * live here, once, and each platform passes only what is genuinely platform-shaped:
 * how to read and subscribe to its voice FSM.
 *
 * Two exports, matching the two directions of the bridge:
 *
 *  1. {@link createCallEngineAdapter} — call → media. Makes a JOIN legal from
 *     whatever status the engine is in (§11: JOIN ∈ {idle, error}), including
 *     WAITING OUT a `leaving` teardown (K2.8), and answers `isConnectedTo`
 *     honestly from the FSM instead of from a controller-side assumption (K2.3).
 *  2. {@link decideCallMediaOutcome} / {@link watchCallMedia} — media → call. The
 *     three distinct endings that arrive through the voice FSM rather than through
 *     a `call.*` event, and the two exceptions that must NOT end a call (K2.4).
 *
 * Framework-free and dependency-free by design (ADR 0002): the voice FSM is read
 * as a plain structural snapshot of strings, so this file never imports
 * `@demli/media` (which would drag `livekit-client` into the RN graph) and
 * stays unit-testable with fakes.
 */

import type { CallController, CallVoiceEngine } from "./call-controller.js";
import type { CallState } from "./call-state.js";

/**
 * The STRUCTURAL slice of `@demli/media`'s `VoiceState` this bridge reads.
 * Plain strings (not the `VoiceStatus`/`VoiceEndedReason` unions) so client-core
 * keeps its lean dependency graph; the real `VoiceState` satisfies it without a
 * cast, and both platforms pass their engine/store snapshot straight in.
 */
export interface VoiceSnapshot {
  /** `@demli/media`'s `VoiceStatus`. */
  status: string;
  /** The room the media layer is in (or moving into), `null` at idle. */
  roomId: string | null;
  /**
   * A CLEAN, already-attributed ending (`session_replaced`, `alone`, …), or null
   * for "the session just went away". The distinction is load-bearing — see
   * {@link decideCallMediaOutcome}.
   */
  endedReason: string | null;
}

/** A pre-minted LiveKit grant, mirroring `CallVoiceEngine.join`'s credential. */
interface JoinCredential {
  url: string;
  token: string;
}

type TimerHandle = ReturnType<typeof setTimeout>;

/** Statuses in which we are in — or moving into — a room. */
export function isVoiceLive(status: string): boolean {
  return status === "connected" || status === "joining" || status === "reconnecting";
}

/**
 * How long to wait for a `leaving` teardown before giving up and trying the join
 * anyway (so a wedged engine fails loudly instead of hanging a call forever).
 */
export const DEFAULT_LEAVING_WAIT_MS = 4_000;

export interface CallEngineAdapterDeps {
  /** Read the media FSM right now. */
  getVoiceState(): VoiceSnapshot;
  /** Subscribe to media FSM changes; returns an unsubscribe. */
  subscribeVoice(listener: (state: VoiceSnapshot) => void): () => void;
  /** The raw engine join (pre-minted credential — ADR 0012 §2). */
  join(roomName: string, credential?: JoinCredential): Promise<void>;
  /** The raw engine leave. Always reaches idle. */
  leave(): Promise<void>;
  /**
   * Platform pre-join setup, run once the engine is legal to join and before the
   * join itself (desktop: reset the per-channel bitrate; both: join muted under
   * push-to-talk). Optional — the ordering, not the content, is what is shared.
   */
  beforeJoin?(roomName: string): void | Promise<void>;
  /** Override the `leaving` wait window (tests). */
  leavingWaitMs?: number;
  /** Injected timers (tests). Default to the globals. */
  setTimer?: (callback: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

/**
 * Build the {@link CallVoiceEngine} the call controller drives, on top of a
 * platform's voice engine.
 *
 * WHY the status dance (founder P0s, K2.8): a call join (start / accept /
 * accept-and-switch) fires while the user is very often ALREADY in a voice
 * session, and JOIN is illegal from any live status. Calling straight through
 * throws `InvalidVoiceCommandError` and the call dies half-established — the row
 * is live server-side while this device has no media at all, i.e. exactly the
 * "kabul etti ama bağlanmadı" report. `leaving` is the nastier variant: LEAVE is
 * illegal there too, so the usual leave-first guard throws as well; the only
 * correct move is to wait the teardown out.
 */
export function createCallEngineAdapter(deps: CallEngineAdapterDeps): CallVoiceEngine {
  const setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle));
  const leavingWaitMs = deps.leavingWaitMs ?? DEFAULT_LEAVING_WAIT_MS;

  /**
   * Resolve once the media FSM's status satisfies `accept`, or after `timeoutMs`.
   * Resolves synchronously when the predicate already holds.
   */
  function waitForVoiceStatus(accept: (status: string) => boolean): Promise<void> {
    if (accept(deps.getVoiceState().status)) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      let unsubscribe: (() => void) | null = null;
      let timer: TimerHandle | null = null;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) {
          clearTimer(timer);
          timer = null;
        }
        unsubscribe?.();
        unsubscribe = null;
        resolve();
      };
      unsubscribe = deps.subscribeVoice((state) => {
        if (accept(state.status)) finish();
      });
      // A subscribe that emits the CURRENT state synchronously would have run
      // `finish` before `unsubscribe` was assigned — release it here instead of
      // leaking the listener for the app's lifetime.
      if (settled) {
        unsubscribe();
        unsubscribe = null;
        return;
      }
      timer = setTimer(finish, leavingWaitMs);
    });
  }

  return {
    async join(roomName, credential) {
      const { status } = deps.getVoiceState();
      if (isVoiceLive(status)) {
        await deps.leave();
      } else if (status === "leaving") {
        await waitForVoiceStatus((s) => s !== "leaving");
      }
      await deps.beforeJoin?.(roomName);
      await deps.join(roomName, credential);
    },
    leave() {
      return deps.leave();
    },
    /**
     * The platform's HONEST answer to "is media up on this room?" (K2.3). Read
     * from the voice FSM, so an eviction or a dead transport is visible: a call
     * FSM that says `active` over an engine that is `idle`/`error` is precisely
     * the state the resync path exists to repair.
     */
    isConnectedTo(roomName) {
      const { status, roomId } = deps.getVoiceState();
      if (roomId !== roomName) return false;
      return isVoiceLive(status);
    },
  };
}

/**
 * What the call FSM should do about the media FSM's latest snapshot.
 * - `none`            — nothing to attribute to the call.
 * - `dismiss`         — free the call slot WITHOUT a server terminal.
 * - `report_failure`  — the call's media died: retire it on both planes.
 */
export type CallMediaOutcome = "none" | "dismiss" | "report_failure";

export interface CallMediaDecisionInput {
  /** The call FSM's current state. */
  call: CallState;
  /** The media FSM's latest snapshot. */
  voice: VoiceSnapshot;
  /**
   * The media FSM's `roomId` as of the PREVIOUS snapshot — how we tell "we were in
   * the call's room and are not any more" from "we were never in it" (the latter
   * being the normal `outgoing` → join window, which must not retire the call).
   */
  previousRoomId: string | null;
}

/**
 * Keep the call FSM honest about MEDIA (call-UX plan K2.4) — the pure decision.
 *
 * Three distinct endings arrive through the voice FSM rather than through a
 * `call.*` event, and handling only the first leaves a phantom `active` call that
 * `isCallLive` then refuses every NEW call with (the founder's "çıkıp o kişiyi
 * tekrar aramak zorunda kalıyorum"):
 *
 *  1. A post-upgrade GROUP surface left through the normal voice UI (engine idle)
 *     → free the slot. Its call row already closed as `upgraded`, so there is no
 *     server terminal to send.
 *  2. Engine `error` on the CALL's own room (server unavailable, failed reconnect,
 *     dead transport) → end the call on both planes so the peer stops staring at a
 *     dead room.
 *  3. Engine back to `idle` after having been in the call's room with no `call.*`
 *     terminal (Leave pressed inside a DM call, an eviction we did not attribute).
 *
 * And the three endings that must NEVER end a call:
 *  - `pending` — a control action (accept, accept-and-switch) owns the outcome and
 *    its leave/join churn is EXPECTED; reacting here would kill a call in the
 *    middle of being established.
 *  - `endedReason !== null` — the media layer already attributed the ending:
 *    `session_replaced` (this device was evicted because the user joined voice
 *    elsewhere — the call is LIVE on that other device, so hanging up here would
 *    kill it) or `alone` (the server closed the room; its own `call.ended`
 *    follows). Both have owners; neither is a failure.
 *  - the SEAT is not `here` (ADR 0023) — see the guard below.
 */
export function decideCallMediaOutcome(input: CallMediaDecisionInput): CallMediaOutcome {
  const { call, voice, previousRoomId } = input;
  if (call.phase === "idle" || call.phase === "ended") return "none";
  if (call.pending) return "none";
  // Media this device does not hold cannot be this call's media failure
  // (ADR 0023 §1-2). Two states reach here routinely and mean opposite things
  // from what an idle engine used to imply:
  //   `vacant`    — the user pressed Leave. The call is deliberately still live
  //                 and re-joinable; reporting a failure would hang it up on the
  //                 peer, which is precisely the "leave = end" behavior the room
  //                 model removes.
  //   `elsewhere` — the account's media moved to another device. Ending here
  //                 would end the call the user is holding in their hand.
  // It also subsumes the old pre-join guard: an `outgoing` call whose engine has
  // not connected yet has no seat, so its join window is untouched.
  if (call.seat !== "here") return "none";

  if (voice.status === "error") {
    // A post-upgrade group surface is an ORDINARY voice session: its call row is
    // already closed, so there is nothing to tell the server — just free the slot.
    // The media error itself is surfaced by the voice UI (§26).
    if (call.surface?.kind === "group") return "dismiss";
    // Attribute the failure to THIS call only when the dead room is the call's own.
    const ourRoom =
      call.roomName !== null &&
      (voice.roomId === call.roomName || previousRoomId === call.roomName);
    return ourRoom ? "report_failure" : "none";
  }

  if (voice.status !== "idle") return "none";
  if (voice.endedReason !== null) return "none";
  if (call.surface?.kind === "group") return "dismiss";
  // A DM-surface call whose media we HAD and no longer have. Guarded on the
  // previous roomId so the pre-join window of an outgoing call is untouched.
  if (call.roomName !== null && previousRoomId === call.roomName) return "report_failure";
  return "none";
}

export interface CallMediaWatcherDeps {
  /** Subscribe to media FSM changes; returns an unsubscribe. */
  subscribeVoice(listener: (state: VoiceSnapshot) => void): () => void;
  /**
   * The CURRENT call controller, or null when signed out. Read per notification
   * (never captured) so a controller rebuilt for a new session is picked up
   * without re-subscribing.
   */
  getController(): CallController | null;
}

/**
 * Wire {@link decideCallMediaOutcome} to a live controller: subscribe to the
 * voice FSM, track the previous `roomId`, and apply the decision. Registered once
 * for the app lifetime; a no-op whenever no call is live. Returns an unsubscribe.
 */
export function watchCallMedia(deps: CallMediaWatcherDeps): () => void {
  let previousRoomId: string | null = null;
  return deps.subscribeVoice((voice) => {
    const lastRoomId = previousRoomId;
    previousRoomId = voice.roomId;
    const controller = deps.getController();
    const call = controller?.getState();
    if (!controller || !call) return;
    switch (decideCallMediaOutcome({ call, voice, previousRoomId: lastRoomId })) {
      case "dismiss":
        controller.dismiss();
        break;
      case "report_failure":
        controller.reportMediaFailure();
        break;
      default:
        break;
    }
  });
}
