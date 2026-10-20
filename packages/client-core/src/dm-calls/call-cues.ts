/**
 * DM-call → UI sound cue policy (sfx-refresh). Pure and platform-free, so desktop
 * and mobile ring/cue the SAME way from the SAME rule — each platform only maps
 * the returned cue name onto its own sound manager.
 *
 * Two observers feed the call cues, and they are split on purpose:
 *
 * 1. The CALL FSM ({@link callTransitionCue}) owns the call's outcome: it
 *    connected, it ended, it failed. It cannot tell "I hung up" from "they hung
 *    up" — both arrive as `ended{hung_up}` — so it always says `call-ended`.
 * 2. The VOICE ROSTER (each platform's voice-sounds) owns presence inside the
 *    call room: the other side LEAVING is visible there as a remote participant
 *    dropping, which is `peer-left-call`. The platform sound manager then drops a
 *    `call-ended` that lands right after a `peer-left-call`, so a peer hang-up
 *    plays one cue, not two.
 *
 * Why the FSM and not the voice store decides `call-connected`: the CALLER joins
 * the LiveKit room at `start`, while the call is still ringing. The voice store
 * says "connected" seconds before anyone answered, so a voice-driven join cue
 * would celebrate an unanswered call. Inside a call room, voice-sounds therefore
 * stays silent for self join/leave and leaves those moments to this module.
 */

import type { CallState } from "./call-state.js";

/** Every cue this policy can ask for (a subset of each platform's UiSound). */
export type CallCue = "call-connected" | "call-ended" | "error";

/**
 * LiveKit room-name prefix of a DM call (`dmcall:<callId>`). Mirrors the server's
 * `DM_CALL_ROOM_PREFIX` (packages/db) — the room stays `dmcall:` even after a
 * seamless group upgrade (media never moves, ADR 0012 §6).
 */
export const CALL_ROOM_PREFIX = "dmcall:";

/** True when the voice engine's `roomId` is a DM call room (not a server channel). */
export function isCallRoomId(roomId: string | null | undefined): boolean {
  return typeof roomId === "string" && roomId.startsWith(CALL_ROOM_PREFIX);
}

/**
 * The cue for one call-state transition, or null for "stay quiet".
 *
 * - ringing → active, or active → active on a DIFFERENT call (accept-and-switch
 *   from the busy banner): `call-connected` — unless this device's seat is
 *   `elsewhere`, where the call went live on another device of the same account.
 * - active → ended: `error` for `failed`; nothing for `upgraded` (the two
 *   originals keep talking in the new group); nothing when the seat was
 *   `elsewhere` (that device plays it); otherwise `call-ended`.
 * - outgoing → ended (the call never connected): `error` for `failed`,
 *   `call-ended` for declined / busy / timeout / our own cancel.
 * - incoming → ended: `call-ended` only when WE declined; a missed call
 *   (`canceled` / `timeout`) is already signalled by the ring stopping.
 */
export function callTransitionCue(prev: CallState, next: CallState): CallCue | null {
  if (next.phase === "active") {
    const fromRinging = prev.phase === "outgoing" || prev.phase === "incoming";
    const switched = prev.phase === "active" && prev.callId !== next.callId;
    if ((fromRinging || switched) && next.seat !== "elsewhere") return "call-connected";
    return null;
  }

  if (next.phase !== "ended" || prev.phase === "ended") return null;
  const reason = next.endedReason;

  if (prev.phase === "active") {
    if (reason === "upgraded" || prev.seat === "elsewhere") return null;
    return reason === "failed" ? "error" : "call-ended";
  }
  if (prev.phase === "outgoing") {
    return reason === "failed" ? "error" : "call-ended";
  }
  if (prev.phase === "incoming") {
    if (reason === "failed") return "error";
    return reason === "declined" ? "call-ended" : null;
  }
  return null;
}
