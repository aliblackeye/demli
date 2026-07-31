/**
 * Pure decision for the voice-join confirmation guard (founder UX #6).
 *
 * Kept in its own SIDE-EFFECT-FREE module (type-only imports) so the rule can be
 * unit-tested without pulling in the voice store — which builds the LiveKit engine
 * at import time. {@link requestVoiceJoin} in `voice-join-guard-store` reads the
 * live voice + call state and delegates the "ask or not?" call here.
 */

import type { CallState } from "@demli/client-core";
import type { VoiceState } from "@demli/media";
import type { ChannelId } from "@demli/types";

/**
 * What the pending join will interrupt. Any true flag means the dialog is shown;
 * all false means the join is non-interrupting and runs straight through. Flags
 * are additive — a screen share torn down mid-call sets both {@link stopsScreenShare}
 * and {@link leavesCall}, and the dialog lists every consequence that applies.
 */
export interface VoiceJoinConsequences {
  /** A live local screen share will stop. */
  stopsScreenShare: boolean;
  /** A live DM / group call will end. */
  leavesCall: boolean;
  /** A different server voice channel (no call behind it) will be left. */
  leavesChannel: boolean;
}

export interface VoiceJoinDecisionInput {
  targetChannelId: ChannelId;
  voiceStatus: VoiceState["status"];
  voiceRoomId: string | null;
  screenShareEnabled: boolean;
  /** The DM-call FSM phase, or null when no controller / not signed in. */
  callPhase: CallState["phase"] | null;
}

/**
 * Given the live voice + call state, return the consequences of joining
 * `targetChannelId`, or `null` when the join is non-interrupting (a fresh join
 * from idle, or a refocus of the room we are already in) and should proceed
 * silently — no nag on the empty-state first join.
 */
export function decideVoiceJoin(input: VoiceJoinDecisionInput): VoiceJoinConsequences | null {
  const inLiveVoice =
    input.voiceStatus === "connected" ||
    input.voiceStatus === "reconnecting" ||
    input.voiceStatus === "joining";

  // Refocusing the room we are already in (or joining) → never interrupt.
  if (inLiveVoice && input.voiceRoomId === input.targetChannelId) return null;

  // A call counts as an interrupting session only once we are actually in it —
  // dialing out or connected. A mere *incoming* ring is not a session we leave,
  // and "you'll leave your current call" would be false copy for it.
  const callLive = input.callPhase === "active" || input.callPhase === "outgoing";

  const stopsScreenShare = input.screenShareEnabled;
  const leavesCall = callLive;
  // A plain voice→voice switch: in a live voice room, no call behind it, and the
  // target is a different room. (A call's media also lives in the engine, so we
  // exclude callLive here to keep the "call" and "channel" framings distinct.)
  const leavesChannel =
    inLiveVoice &&
    !callLive &&
    input.voiceRoomId != null &&
    input.voiceRoomId !== input.targetChannelId;

  if (!stopsScreenShare && !leavesCall && !leavesChannel) return null;
  return { stopsScreenShare, leavesCall, leavesChannel };
}
