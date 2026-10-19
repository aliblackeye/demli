/**
 * Bottom-chrome geometry — the ONE place that knows what floats along the bottom
 * edge of an authed screen and how high it reaches.
 *
 * Two things can float there, both `position: absolute`, so neither takes layout
 * space and the screen under them runs to the very bottom:
 *
 *  1. the floating tab pill (only on the three tab routes), and
 *  2. the global VoiceMiniBar (while a voice-CHANNEL session is live; never on the
 *     voice room itself, never for a DM call — that one has its own top bar).
 *
 * The bar is stacked ABOVE the tab pill. Anything else that floats or scrolls to
 * the bottom of a tab screen — the new-DM button, the optional update pill, the
 * last row of every list — must stay above both, or the voice bar covers it
 * during a call (a tap then opens the room instead of the thing you aimed at).
 *
 * Pure (no React, no React Native) so the geometry is pinned by unit tests: the
 * VoiceMiniBar positions itself with {@link voiceMiniBarBottom}, and every consumer
 * clears it with {@link bottomChromeClearance}, so the two cannot drift apart.
 */
import type { VoiceState } from "@demli/media";
import { isDmCallRoom } from "./call-room";
import { TAB_BAR_CONTENT_HEIGHT } from "./tab-bar";
import { space } from "../theme/theme";

/**
 * Rendered height of the floating voice bar (paddingVertical 8×2 + the 44pt
 * control row + 1px borders, rounded up). Kept generous so a slightly taller bar
 * is still cleared.
 */
export const VOICE_MINI_BAR_HEIGHT = 64;

/** Gap between the voice bar and whatever it sits on (the tab pill or the safe area). */
export const VOICE_MINI_BAR_GAP = space.sm;

/**
 * True on the voice room route, where the bar is deliberately NOT shown — that
 * screen carries the full controls itself.
 */
export function isVoiceRoomRoute(pathname: string): boolean {
  return pathname.startsWith("/voice/");
}

/** Statuses in which a session is live and the bar should be shown. */
export function isLiveStatus(status: VoiceState["status"]): boolean {
  return (
    status === "joining" ||
    status === "connected" ||
    status === "reconnecting" ||
    status === "error"
  );
}

/**
 * True while a voice-channel session is live, regardless of route. A DM call runs
 * on the same engine but owns its own UI (ADR 0012), so it never raises the bar.
 */
export function hasLiveVoiceBarSession(
  roomId: string | null,
  status: VoiceState["status"],
): boolean {
  return !!roomId && isLiveStatus(status) && !isDmCallRoom(roomId);
}

/** True when the VoiceMiniBar is on screen for this route. */
export function isVoiceMiniBarShown(
  roomId: string | null,
  status: VoiceState["status"],
  pathname: string,
): boolean {
  return hasLiveVoiceBarSession(roomId, status) && !isVoiceRoomRoute(pathname);
}

/** Distance of the voice bar's BOTTOM edge from the screen bottom. */
export function voiceMiniBarBottom(insetsBottom: number, onTabRoute: boolean): number {
  return insetsBottom + VOICE_MINI_BAR_GAP + (onTabRoute ? TAB_BAR_CONTENT_HEIGHT : 0);
}

/**
 * Distance from the screen bottom that floating content must stay ABOVE, and the
 * minimum bottom padding a scroll view needs so its last row can be scrolled
 * clear of the chrome: the safe area, the tab pill (tab routes), and the voice
 * bar plus its gap (while it is shown). Callers add their own breathing room.
 */
export function bottomChromeClearance({
  insetsBottom,
  onTabRoute,
  voiceBarShown,
}: {
  insetsBottom: number;
  onTabRoute: boolean;
  voiceBarShown: boolean;
}): number {
  const base = insetsBottom + (onTabRoute ? TAB_BAR_CONTENT_HEIGHT : 0);
  if (!voiceBarShown) return base;
  return voiceMiniBarBottom(insetsBottom, onTabRoute) + VOICE_MINI_BAR_HEIGHT;
}

/** Breathing room between the chrome and a surface floating above it. */
export const FLOATING_GAP = space.md;

/**
 * `bottom` offset for a surface that floats above the chrome (the new-DM button,
 * the update pill), given {@link bottomChromeClearance}.
 */
export function floatingBottom(clearance: number): number {
  return clearance + FLOATING_GAP;
}
