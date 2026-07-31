/**
 * WHAT is on screen right now — the ground truth the notify policy asks.
 *
 * Deliberately a registry the RENDERING component publishes into, not a
 * derivation over the stores. "Which conversation is the user reading?" is not
 * answerable from `chatStore.activeChannelId` alone:
 *
 *   - `openFriends()` / `openRecentCalls()` leave `activeChannelId` pointing at
 *     the last DM. Derived from the store, a message in that DM would look
 *     "already visible" while the user is staring at the friends table.
 *   - On a server surface the center swaps to the VIDEO STAGE when there is live
 *     camera/screen video and the stage is focused (AppCenter.ServerCenter).
 *     `activeChannelId` is unchanged, but no message list is painted.
 *   - Settings is a full overlay over the whole shell.
 *
 * Reproducing those three conditions here would mean a second copy of the
 * center-column logic that silently rots the first time the layout changes. So
 * the component that decides what to paint states what it painted, and this
 * module just remembers it.
 *
 * Module-level mutable state on purpose (CLAUDE.md §23's "intentional stores"):
 * writing it must never re-render anything, and the notification manager reads
 * it imperatively from outside React.
 */

import { useEffect } from "react";
import type { ChannelId } from "@demli/types";
import type { VisibleContext, VisibleSurface } from "./notify-policy";

let visibleStreamId: ChannelId | null = null;
let visibleSurface: VisibleSurface | null = null;
/** Set while a full-screen overlay (Settings) covers the shell. */
let overlayCovering = false;

/**
 * Publish the conversation stream the center column is painting, or null when it
 * is painting something that is not a conversation (friends, recent calls, the
 * video stage).
 */
export function setVisibleConversation(streamId: ChannelId | null): void {
  visibleStreamId = streamId;
}

/** Publish the non-conversation screen the center column is painting, or null. */
export function setVisibleSurface(surface: VisibleSurface | null): void {
  visibleSurface = surface;
}

/**
 * Publish whether a full-screen overlay covers the shell. While one does, NOTHING
 * counts as visible — the user cannot read a message list behind Settings.
 */
export function setOverlayCovering(covering: boolean): void {
  overlayCovering = covering;
}

/**
 * Snapshot for the policy. Reads live DOM focus/visibility every call (they are
 * cheap and must never be cached — the whole question is "right now").
 *
 * Guarded for a non-DOM environment so importing this module from a unit test
 * cannot throw.
 */
export function visibleContext(): VisibleContext {
  const hasDocument = typeof document !== "undefined";
  return {
    focused: hasDocument ? document.hasFocus() : false,
    hidden: hasDocument ? document.hidden : true,
    streamId: overlayCovering ? null : visibleStreamId,
    surface: overlayCovering ? null : visibleSurface,
  };
}

/** Reset on logout / teardown so a stale id can never suppress a fresh session. */
export function resetVisibleConversation(): void {
  visibleStreamId = null;
  visibleSurface = null;
  overlayCovering = false;
}

/**
 * Declare, from a rendering component, what the center column is showing.
 * Clears on unmount so an unmounted view never keeps claiming the screen.
 *
 * Writes module state only — no store, no state setter, so this costs exactly
 * one effect per surface switch and re-renders nothing (§27).
 */
export function useVisibleConversation(
  streamId: ChannelId | null,
  surface: VisibleSurface | null = null,
): void {
  useEffect(() => {
    setVisibleConversation(streamId);
    setVisibleSurface(surface);
    return () => {
      setVisibleConversation(null);
      setVisibleSurface(null);
    };
  }, [streamId, surface]);
}

/** Declare that a full-screen overlay is covering the shell while mounted. */
export function useOverlayCovering(covering: boolean): void {
  useEffect(() => {
    setOverlayCovering(covering);
    return () => setOverlayCovering(false);
  }, [covering]);
}
