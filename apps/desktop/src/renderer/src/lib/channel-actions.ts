/**
 * The channel gestures, each with exactly one implementation.
 *
 * M20 gave voice channels a text chat, which means there are now two things a
 * user can want from one (see ./voice-channel-chat for the rules):
 *
 *   {@link openChannelChat}      — select a channel; its conversation fills the
 *                                  center. Works for BOTH kinds and touches no
 *                                  media state whatsoever. The read path.
 *   {@link joinVoiceChannel}     — connect to a voice room. Never selects
 *                                  blindly: it also opens that room's chat, so
 *                                  leaving the stage lands you in the right
 *                                  conversation.
 *   {@link activateVoiceChannel} — the PRIMARY row gesture, which picks between
 *                                  those two. Join, except for the room you are
 *                                  already in, where it just opens the chat.
 *
 * Every entry point (sidebar row, its context menu, the command menu, the chat
 * header, the video stage) calls these rather than poking the three stores in
 * its own order. The failure mode that motivates it is silent: a caller that
 * sets the active channel but forgets `showChannelChat()` leaves the user
 * staring at the video stage wondering why their click did nothing; a caller
 * that joins without selecting drops them into a stale channel's chat when the
 * call ends; and a caller that skips the already-in-this-room check re-runs a
 * join against the live session for what the user meant as "show me the chat".
 *
 * Privileged/media work stays where it belongs: joining runs through
 * `requestVoiceJoin` (the confirmation guard) which drives the single
 * `@demli/media` FSM (§11). This module owns no lifecycle of its own.
 */

import type { Channel } from "@demli/types";
import { useChatStore } from "../stores/chat-store";
import { useUiStore } from "../stores/ui-store";
import { useVoiceStore } from "../stores/voice-store";
import { requestVoiceJoin } from "../stores/voice-join-guard-store";
import { voiceRowClickAction } from "./voice-channel-chat";

/**
 * Open a channel's conversation in the center — the plain "I clicked a channel"
 * gesture, for a text channel and a voice channel alike.
 *
 * `showChannelChat()` is what lets this escape the video stage mid-call: the
 * center shows the stage only while the stage intent is set, so reading a
 * channel never requires hanging up, and voice/video keep running behind it.
 */
export function openChannelChat(channel: Channel): void {
  useUiStore.getState().showChannelChat();
  useChatStore.getState().setActiveChannel(channel);
}

/**
 * Join a voice channel's ROOM (the explicit, separate action) and open that
 * channel's chat underneath the stage.
 *
 * The stage intent is set so a room with live video takes the center; with no
 * video the center is the channel's chat, which is now a real place to be
 * rather than an empty panel. `groupName` is recorded on the join purely for the
 * voice panel's label.
 */
export function joinVoiceChannel(channel: Channel, groupName: string | null): void {
  useChatStore.getState().setActiveChannel(channel);
  useUiStore.getState().showVoiceStage();
  // Route through the join guard: a live screen share / DM call / other room is
  // confirmed before it is torn down (founder UX #6).
  requestVoiceJoin(channel.id, channel.name, {
    audioBitrateKbps: channel.audioBitrateKbps ?? null,
    label: { channelName: channel.name, groupName },
  });
}

/**
 * The PRIMARY gesture on a voice channel row: a single click connects you to the
 * room and opens its chat: in a voice channel the action the user came for is
 * to JOIN, not to read.
 *
 * The one exception is the room you are already in, where the click means "show
 * me the messages" and does exactly that: no rejoin, no room switch, no voice
 * FSM transition at all. The decision is `voiceRowClickAction`'s, read against
 * the live engine at click time, so the row does not have to hold its own copy
 * of "am I in this one".
 */
export function activateVoiceChannel(channel: Channel, groupName: string | null): void {
  const voice = useVoiceStore.getState();
  const action = voiceRowClickAction(channel.id, {
    voiceRoomId: voice.roomId,
    voiceStatus: voice.status,
  });
  if (action === "open-chat") openChannelChat(channel);
  else joinVoiceChannel(channel, groupName);
}

/** Leave the current voice room. Selection and the center are left alone. */
export function leaveVoiceRoom(): void {
  useVoiceStore.getState().leave();
}

/** Bring the connected room's video stage back to the center. */
export function returnToVoiceStage(): void {
  useUiStore.getState().showVoiceStage();
}
