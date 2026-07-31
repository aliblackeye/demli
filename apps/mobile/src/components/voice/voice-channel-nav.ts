/**
 * Mobile navigation glue for the M20 voice-channel chat — the phone's answer to
 * "a voice channel is a room WITH a conversation attached".
 *
 * The DECISION is not made here. `voiceRowClickAction` in `@demli/client-core`
 * owns it for every surface (desktop, web, mobile); this module only translates
 * its two outcomes into what the `/voice/[channelId]` route needs to know:
 *
 *   join      → connect on mount, open on the STAGE.
 *   open-chat → do not touch the voice engine, open on the CHAT.
 *
 * Why a route intent instead of two routes: a voice channel is ONE place on
 * mobile with two views, exactly as the desktop center swaps between the video
 * stage and the channel's chat. Two routes would let the user stack the same
 * channel on itself (chat → room → chat) and would need a second answer to
 * "which one does the mini bar return to".
 *
 * Kept pure (no expo-router, no stores) so the repo's node-environment vitest
 * can lock the gesture: the tap joins, the tap on the room you are already in
 * does not, and the read control never joins at all.
 */

import { voiceRowClickAction, type VoiceSessionFacts } from "@demli/client-core";
import type { ChannelId } from "@demli/types";

/**
 * What the voice route was opened FOR.
 *
 * - `"join"` — connect me to this room (the primary row tap, the mini bar, a
 *   push notification, the command palette). The historical behaviour, and the
 *   default for any caller that says nothing.
 * - `"chat"` — show me this channel's conversation and connect me to NOTHING.
 *   Reading is a real capability here (visibility is the whole access rule, ADR
 *   0007 — being in the room is deliberately not required), so it needs a way in
 *   that cannot be mistaken for a join.
 */
export type VoiceScreenIntent = "join" | "chat";

/** The two views the voice screen swaps between. */
export type VoiceScreenView = "stage" | "chat";

/**
 * The intent behind a TAP on a voice channel row — the primary gesture.
 *
 * Joins, except for the room the engine is already in, where the tap means "show
 * me what was said" and must not re-run a join against the live session (no
 * reconnect, no room switch, no FSM transition).
 */
export function voiceRowTapIntent(
  channelId: ChannelId,
  facts: VoiceSessionFacts,
): VoiceScreenIntent {
  return voiceRowClickAction(channelId, facts) === "join" ? "join" : "chat";
}

/**
 * The intent behind the row's SEPARATE read target (the chat icon) and the
 * long-press menu's "open chat without joining".
 *
 * Unconditional: this control exists precisely so a user who is in no room — or
 * in a DIFFERENT room — can read without being connected to anything. Deriving
 * it from the session would make it join sometimes, which is the one thing it
 * promises never to do.
 */
export const VOICE_READ_INTENT: VoiceScreenIntent = "chat";

/**
 * Parse the route's `intent` param. Anything unrecognized — including the param
 * being absent — is `"join"`, so every pre-existing caller (mini bar, push deep
 * link, command palette) keeps connecting exactly as before.
 */
export function parseVoiceScreenIntent(raw: string | string[] | undefined): VoiceScreenIntent {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "chat" ? "chat" : "join";
}

/**
 * Whether mounting the voice screen should connect to the room.
 *
 * False for a read intent — that is the entire promise of the read path. (The
 * engine's own `join` is a no-op for the room it is already in, but relying on
 * that would mean the read control's correctness depended on the media layer
 * instead of on this decision.)
 */
export function shouldAutoJoinOnMount(intent: VoiceScreenIntent): boolean {
  return intent === "join";
}

/** Which view the screen opens on for a given intent. */
export function initialVoiceView(intent: VoiceScreenIntent): VoiceScreenView {
  return intent === "chat" ? "chat" : "stage";
}
