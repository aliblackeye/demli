/**
 * Voice-channel chat — the pure rules behind "a voice channel is a room with a
 * conversation attached" (M20).
 *
 * Since the M20 backend wave every voice channel carries its own text chat, and
 * the access rule is plain VISIBILITY (ADR 0007): whoever can SEE the channel
 * reads and writes it, whether or not they are sitting in the room. So there are
 * two genuinely different things a user can want from a voice channel:
 *
 *   - JOIN its room     → connect, and land in that room's conversation.
 *   - READ its chat     → open the conversation WITHOUT connecting to anything.
 *
 * Founder decision: the PRIMARY gesture is join. A single tap/click on the row
 * connects you and opens the room's chat: in a voice channel the action the
 * user came for is to JOIN, not to read. Reading without joining is real and
 * stays reachable — it is simply the secondary control (the row's chat target
 * and its context/long-press menu entry), not the default.
 *
 * The one case the primary gesture must NOT treat as a join is the room you are
 * already in: activating it opens its chat and nothing else. Re-running a join
 * against the live room would put the voice FSM through a needless transition
 * for what the user experiences as "show me the messages".
 *
 * These functions are framework-free and store-free on purpose — the renderers
 * (desktop/web components, the React Native screens) render them and read their
 * own stores at the call site. That keeps the decision testable in a plain node
 * environment and, more importantly, keeps DESKTOP AND MOBILE ON ONE COPY: this
 * module lives in client-core precisely because a second, hand-written mobile
 * copy is how the two surfaces silently drift apart on the founder's most-used
 * voice gesture. Same reason `member-menu.ts` lives here.
 */

import type { ChannelId } from "@demli/types";

/**
 * The voice-engine status this module cares about. Structurally a subset of the
 * media FSM's status union (`idle | joining | connected | reconnecting | error`)
 * — kept as a string alias rather than importing `@demli/media` so the pure
 * rules carry no media dependency, and any status other than `"idle"` counts as
 * "we are in (or heading into) that room".
 */
export type VoiceEngineStatus = string;

/** Live voice-session facts these rules read, as they exist at activation time. */
export interface VoiceSessionFacts {
  /** The room the voice engine is in / heading into, or null when idle. */
  voiceRoomId: ChannelId | null;
  /** The engine's FSM status; `"idle"` means no session at all (§11). */
  voiceStatus: VoiceEngineStatus;
}

/**
 * True when the voice engine's session belongs to THIS channel — connected,
 * connecting or reconnecting. A session in another room, or none at all, is
 * false, so the row of a channel we are not in always offers "join".
 */
export function isVoiceSessionFor(channelId: ChannelId, facts: VoiceSessionFacts): boolean {
  return facts.voiceStatus !== "idle" && facts.voiceRoomId === channelId;
}

/**
 * What activating a voice channel ROW does — the primary gesture (click on
 * desktop/web, tap on mobile).
 *
 * `"join"` everywhere except the room the engine is already in, where it is
 * `"open-chat"`. That exception is the whole subtlety: activating your current
 * room means "show me what was said", not "connect me again", and routing it
 * through the join path would move the voice FSM for a request that was purely
 * about the view. It also means the primary gesture never switches you out of a
 * room and back into the same one.
 *
 * Note what this is NOT: it never returns `"leave"`. Disconnecting from the row
 * would sit next to the thing you tap to open the chat, which is a misclick that
 * ends a call. Leaving lives on the deliberate surfaces — the context/long-press
 * menu, the voice panel, the chat header and the stage bar.
 */
export type VoiceRowClickAction = "join" | "open-chat";

export function voiceRowClickAction(
  channelId: ChannelId,
  facts: VoiceSessionFacts,
): VoiceRowClickAction {
  return isVoiceSessionFor(channelId, facts) ? "open-chat" : "join";
}

/**
 * Which of the two room entries a voice channel's CONTEXT MENU (desktop
 * right-click, mobile long-press) offers.
 *
 * Both are always meaningful — a control that is sometimes a no-op is worse than
 * an absent one (§35). "Return to the stage" deliberately does NOT live here: it
 * is already the voice panel's / chat header's job, and it would be dead
 * whenever the room has no video to return to.
 */
export type VoiceMenuRoomAction = "join" | "leave";

export function voiceMenuRoomAction(
  channelId: ChannelId,
  facts: VoiceSessionFacts,
): VoiceMenuRoomAction {
  return isVoiceSessionFor(channelId, facts) ? "leave" : "join";
}

/** Header/stage facts on top of the session, for the chat-header controls. */
export interface VoiceChatHeaderFacts extends VoiceSessionFacts {
  /**
   * True while the connected room actually has a stage worth showing.
   *
   * On desktop/web that means live video (cameras/shares): with none, the center
   * stays chat no matter what the stage intent says, so "return to the stage"
   * would be a button that does nothing. On mobile the room screen IS the stage
   * — participant tiles plus the mic/deafen/camera/leave controls — so it is
   * true for the whole session there.
   */
  hasStageVideo: boolean;
  /** The center's current intent: the stage (`true`) or the chat (`false`). */
  stageFocused: boolean;
}

/**
 * The controls a VOICE channel's chat header offers, in render order.
 *
 * - Not in this room                        → ["join"]
 * - In it, with a stage we are not looking at → ["return-to-stage", "leave"]
 * - In it, otherwise                        → ["leave"]
 *
 * "return-to-stage" appears only when there is something to return TO (see
 * {@link VoiceChatHeaderFacts.hasStageVideo}). Reading a voice channel's chat
 * while sitting in a DIFFERENT room still shows only "join" — joining is what
 * the button would do.
 */
export type VoiceChatHeaderAction = "join" | "return-to-stage" | "leave";

export function voiceChatHeaderActions(
  channelId: ChannelId,
  facts: VoiceChatHeaderFacts,
): VoiceChatHeaderAction[] {
  if (!isVoiceSessionFor(channelId, facts)) return ["join"];
  if (facts.hasStageVideo && !facts.stageFocused) return ["return-to-stage", "leave"];
  return ["leave"];
}
