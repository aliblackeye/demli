/**
 * The mobile binding for the SHARED notification rule
 * (`@demli/client-core` → notify-policy). This module owns the two
 * platform-specific facts; the decision itself lives in client-core so desktop
 * and mobile can never drift apart again.
 *
 * `focused` is `AppState.currentState === "active"` — the phone analog of
 * desktop's window focus. `hidden` is always false: RN has no separate "visible
 * but not the active tab" state, backgrounding already shows up in AppState.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CHAT SCREEN REGISTERS ITSELF INSTEAD OF US READING `activeChannelId`
 * ---------------------------------------------------------------------------
 * `chat-store.activeChannelId` answers "which thread is MOUNTED", which is not
 * the same question as "which thread is the user LOOKING AT". In an expo-router
 * stack, pushing the voice room / channel settings / a profile on top of a chat
 * does not unmount the thread — so the store kept claiming the conversation was
 * on screen, and every alert for it stayed suppressed while the user was looking
 * at something else entirely. That is the phone twin of the covering-overlay
 * case desktop already handles, and the same founder-visible failure: a message
 * you are never told about.
 *
 * So visibility is claimed on FOCUS and released on blur (see ChatThread's
 * `useFocusEffect`), and it is deliberately a separate value from
 * `activeChannelId`, which keeps its own job (unread suppression, read marking).
 */

import { AppState } from "react-native";
import type { VisibleContext } from "@demli/client-core";

/**
 * The conversation the user is actually looking at, or null. Written only by the
 * focused chat screen; module-level (not a store) because it is read from
 * non-React callers — the realtime dispatcher and the OS push handler.
 */
let visibleStreamId: string | null = null;

/** Claim visibility for a conversation — called when its screen gains focus. */
export function setVisibleStream(streamId: string): void {
  visibleStreamId = streamId;
}

/**
 * Release visibility. Takes the stream that is letting go so a late blur from a
 * screen the user already navigated AWAY from cannot clear the claim of the one
 * they navigated TO (focus/blur can interleave during a fast push).
 */
export function clearVisibleStream(streamId: string): void {
  if (visibleStreamId === streamId) visibleStreamId = null;
}

/** Drop any claim — used on logout / realtime teardown. */
export function resetVisibleStream(): void {
  visibleStreamId = null;
}

/** The current stream claim, for tests and diagnostics. */
export function getVisibleStream(): string | null {
  return visibleStreamId;
}

/** Snapshot of what the phone is showing, in the shared rule's shape. */
export function visibleContext(): VisibleContext {
  return {
    focused: AppState.currentState === "active",
    hidden: false,
    streamId: visibleStreamId,
    // Mobile does not track non-conversation surfaces (no Friends/RecentCalls
    // alert targets are produced here), so nothing can ever match a surface.
    surface: null,
  };
}
