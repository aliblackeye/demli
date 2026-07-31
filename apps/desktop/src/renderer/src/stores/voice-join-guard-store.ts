/**
 * Voice-join CONFIRMATION guard (founder UX #6).
 *
 * The app allows a single voice/media session at a time (§11), so moving into a
 * NEW voice channel is destructive to whatever the user is currently doing:
 *
 *   - a live SCREEN SHARE is torn down,
 *   - a live DM / group CALL ends,
 *   - the OTHER voice channel you are sitting in is left.
 *
 * Switching straight through used to silently kill the founder's broadcast / call
 * with no warning. This tiny store gates any interrupting join behind a
 * confirmation dialog ({@link VoiceJoinGuardDialog}, mounted once at the app root).
 *
 * A NON-interrupting join — the very first join from an idle state, or refocusing
 * the room we are already in — proceeds immediately with no nag.
 * The decision reads the live voice store + call FSM at click time; the actual
 * join always runs through the same `useVoiceStore.join`, so §11 stays the single
 * source of truth — this layer NEVER touches the FSM / engine, it only asks first.
 */

import { create } from "zustand";
import type { ChannelId } from "@demli/types";
import { getCallController } from "../lib/call-controller";
import { decideVoiceJoin, type VoiceJoinConsequences } from "./voice-join-decision";
import { useVoiceStore, type VoiceRoomLabel } from "./voice-store";

export type { VoiceJoinConsequences } from "./voice-join-decision";

interface JoinOptions {
  audioBitrateKbps?: number | null;
  label?: VoiceRoomLabel | null;
}

interface PendingJoin {
  channelId: ChannelId;
  /** The target channel name, for the confirmation copy. */
  channelName: string;
  options: JoinOptions;
  consequences: VoiceJoinConsequences;
}

interface VoiceJoinGuardStore {
  /** The join awaiting confirmation, or null when nothing is pending. */
  pending: PendingJoin | null;
  /** Dismiss the dialog WITHOUT joining (the current share/call/room keeps running). */
  cancel: () => void;
  /** Confirm: run the stashed join (which leaves the current room / stops the share). */
  confirm: () => void;
}

export const useVoiceJoinGuard = create<VoiceJoinGuardStore>((set, get) => ({
  pending: null,
  cancel: () => set({ pending: null }),
  confirm: () => {
    const pending = get().pending;
    if (!pending) return;
    set({ pending: null });
    useVoiceStore.getState().join(pending.channelId, pending.options);
  },
}));

/**
 * Join a voice channel, first CONFIRMING any interrupting transition. Use this from
 * every voice-join entry point (channel row, command menu) instead of calling
 * `useVoiceStore.join` directly, so a live screen share, DM call, or the voice room
 * we are already in is never silently dropped. A fresh join or a refocus of the
 * current room proceeds immediately.
 */
export function requestVoiceJoin(
  channelId: ChannelId,
  channelName: string,
  options: JoinOptions,
): void {
  const voice = useVoiceStore.getState();
  const call = getCallController()?.getState();

  const consequences = decideVoiceJoin({
    targetChannelId: channelId,
    voiceStatus: voice.status,
    voiceRoomId: voice.roomId,
    screenShareEnabled: voice.screenShareEnabled,
    callPhase: call?.phase ?? null,
  });

  // Non-interrupting (fresh join from idle, or refocus) → straight through, no nag.
  if (!consequences) {
    voice.join(channelId, options);
    return;
  }

  useVoiceJoinGuard.setState({ pending: { channelId, channelName, options, consequences } });
}
