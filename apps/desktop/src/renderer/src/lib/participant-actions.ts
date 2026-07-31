/**
 * Pure decision logic for the voice-participant action menu (right-click) — WHICH
 * items a viewer may see for a given target. Kept framework-free so the permission
 * gate (§35: kick/ban/disconnect only for the authorized; never on self or the
 * owner) is unit-testable without a DOM harness (the renderer test suite is
 * node-only). The React menu ({@link ParticipantActionItems}) is a thin renderer
 * over this — every visibility rule lives here so the test is the contract.
 *
 * COSMETIC gate only: the API re-checks every permission on the mutation (§28).
 */

import type { ProfileFriendshipStatus } from "@demli/types";

/** The relationship-appropriate social action (mirrors ProfileCard's button). */
export type ParticipantSocialAction = "message" | "addFriend" | "cancelRequest" | "acceptRequest";
/** Server-moderation actions — gated behind owner ∨ KICK_MEMBERS. */
export type ParticipantModerationAction = "disconnect" | "kick" | "ban";
export type ParticipantMenuAction = ParticipantSocialAction | "invite" | ParticipantModerationAction;

export interface ParticipantMenuContext {
  /** The target is the signed-in user — no self-directed actions of any kind. */
  isSelf: boolean;
  /** The target owns this server — never moderatable, by anyone (§35, mirrors the API guard). */
  isOwner: boolean;
  /** Viewer is the owner OR holds KICK_MEMBERS on this server. */
  canModerate: boolean;
  /** Target is currently connected to a voice channel (so "disconnect" is meaningful). */
  inVoice: boolean;
  /**
   * Friendship as loaded from the profile card query; `"unknown"` while that
   * request is still pending, so we render no (possibly wrong) social action yet.
   */
  friendship: ProfileFriendshipStatus | "unknown";
}

/**
 * The single social action that fits a friendship state — the same mapping the
 * ProfileCard uses for its primary button. `null` while the friendship is still
 * unknown (query pending): showing "Add friend" to an existing friend, or a
 * "Message" that the API would reject, is worse than showing nothing for a beat.
 */
export function socialActionFor(
  friendship: ProfileFriendshipStatus | "unknown",
): ParticipantSocialAction | null {
  switch (friendship) {
    case "friends":
      return "message";
    case "none":
      return "addFriend";
    case "outgoing":
      return "cancelRequest";
    case "incoming":
      return "acceptRequest";
    case "unknown":
      return null;
    default:
      return null;
  }
}

/**
 * The ordered list of menu actions a viewer may see for a target. Order matches
 * the rendered menu: social → invite → moderation. The moderation trio only
 * appears for an authorized viewer targeting someone who is neither themselves
 * nor the server owner — an unauthorized viewer's menu is social + invite only.
 */
export function visibleParticipantActions(ctx: ParticipantMenuContext): ParticipantMenuAction[] {
  // You never act on yourself from this menu (message/friend/moderation all N/A).
  if (ctx.isSelf) return [];

  const actions: ParticipantMenuAction[] = [];

  const social = socialActionFor(ctx.friendship);
  if (social) actions.push(social);

  // Sharing an invite link is a member-level courtesy, shown to everyone.
  actions.push("invite");

  // Moderation: authorized viewer only, and never against the owner (§35).
  if (ctx.canModerate && !ctx.isOwner) {
    if (ctx.inVoice) actions.push("disconnect");
    actions.push("kick");
    actions.push("ban");
  }

  return actions;
}

/** Whether the menu would show ANY moderation control for this context. */
export function hasModerationActions(ctx: ParticipantMenuContext): boolean {
  return visibleParticipantActions(ctx).some(
    (a) => a === "disconnect" || a === "kick" || a === "ban",
  );
}
