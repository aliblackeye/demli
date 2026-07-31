/**
 * WHICH trailing controls a channel row renders, and HOW each of them is
 * revealed. Framework-free so the rules are testable without a DOM harness —
 * they are the rules, the component only spreads them.
 *
 * Two decisions live here, and both are ones that go wrong silently:
 *
 *  1. WHICH controls exist. A viewer the server would refuse an invite must see
 *     no invite control at all (§35) — not a disabled one, not a greyed one.
 *     That has to be decided in one place, because the same answer drives the
 *     icon, the menu entry AND the row's right-hand padding.
 *
 *  2. HOW they are revealed. "Hover to reveal" is not a behaviour on a touch
 *     screen or a narrow web viewport: there is no hover, so a hover-only
 *     control does not exist for those users. Every secondary row control
 *     therefore reveals three ways — hover on a fine pointer, always on a coarse
 *     pointer, always under 900px — plus keyboard focus. Written out as string
 *     constants because that is what a test can actually assert about; a
 *     hand-inlined variant that quietly dropped `pointer-coarse:` would look
 *     perfect in review and be invisible on the founder's phone.
 */

/** Always present: the control is pinned on regardless of pointer or hover. */
export const ALWAYS_VISIBLE_CLASS = "opacity-100";

/**
 * Hidden until hovered on a FINE pointer; always present and clickable when the
 * pointer CANNOT hover, and under keyboard focus. `group/actionmenu` is the
 * wrapper ActionMenu puts around a row + its controls.
 *
 * WIDTH IS NOT A PROXY FOR TOUCH. This list used to carry
 * `max-[899px]:opacity-100` as well, on the theory that a narrow viewport is
 * probably a phone. It is not: a desktop window dragged narrow — or snapped to
 * half a screen — still has a mouse, so every one of these controls became
 * permanently visible and the sidebar read as though everything were stuck in a
 * hover state. That is the founder's report of 2026-07-28 ("direkt hoverlanmış
 * şekilde geliyor"), from a 2560px display running the app in a ~590px window.
 *
 * `pointer-coarse:` already answers the real question — "can this pointer hover
 * at all?" — and covers every touch device including a narrow one. A narrow
 * window with a mouse keeps hover-to-reveal, which is what a mouse user expects.
 */
export const HOVER_REVEAL_CLASSES = [
  "opacity-0",
  "pointer-events-none",
  "group-hover/actionmenu:pointer-events-auto",
  "group-hover/actionmenu:opacity-100",
  "pointer-coarse:pointer-events-auto",
  "pointer-coarse:opacity-100",
].join(" ");

export interface ChannelRowControlsInput {
  /** A voice row carries the "open chat without joining" control (M20). */
  isVoice: boolean;
  /** The viewer may create invites for this server (`invite_policy` gate). */
  canInvite: boolean;
  /** This row is the selected channel — the invite icon stays visible on it. */
  selected: boolean;
}

export interface ChannelRowControlsPlan {
  showChatControl: boolean;
  showInviteControl: boolean;
  /** Reveal classes for the invite icon (pinned on while the row is selected). */
  inviteRevealClasses: string;
  /** Reveal classes for the voice chat icon (always hover-secondary). */
  chatRevealClasses: string;
  /** How many trailing slots the row must reserve room for. */
  slots: number;
  /** The row's right-hand padding classes, or null when nothing is reserved. */
  paddingClasses: string | null;
}

/**
 * Right-hand padding for `slots` trailing controls.
 *
 * Reserved on EVERY pointer even though the icons are hover-only on a fine one:
 * reserving on hover instead would shove the unread count sideways the instant
 * the pointer crosses the row. The coarse/narrow figures add the always-on
 * kebab, which the fine-pointer row does not show.
 */
export function trailingPaddingClasses(slots: number): string | null {
  if (slots >= 2) return "pr-16 pointer-coarse:pr-24 max-[899px]:pr-24";
  if (slots === 1) return "pr-9 pointer-coarse:pr-16 max-[899px]:pr-16";
  return null;
}

export function planChannelRowControls(
  input: ChannelRowControlsInput,
): ChannelRowControlsPlan {
  const { isVoice, canInvite, selected } = input;
  const showChatControl = isVoice;
  const showInviteControl = canInvite;
  const slots = (showChatControl ? 1 : 0) + (showInviteControl ? 1 : 0);

  return {
    showChatControl,
    showInviteControl,
    // The founder's rule: "hover edince VEYA seçili olunca". On the row you are
    // already on, the control is simply there.
    inviteRevealClasses: selected ? ALWAYS_VISIBLE_CLASS : HOVER_REVEAL_CLASSES,
    chatRevealClasses: HOVER_REVEAL_CLASSES,
    slots,
    paddingClasses: trailingPaddingClasses(slots),
  };
}
