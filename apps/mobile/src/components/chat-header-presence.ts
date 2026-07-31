/**
 * Pure presence logic behind the conversation headers (see ChatHeaderTitle.tsx).
 *
 * Kept in its own React-free module so the wording rules and the online fold are
 * unit-testable without a renderer — the components stay thin glue around these.
 */
import type { PresencePlatform, PresenceStatus, UserId } from "@demli/types";

/** The catalog keys this module resolves; the caller passes them to `t`. */
export type PresenceLabelKey =
  | "mobile:presence.online"
  | "mobile:presence.idle"
  | "mobile:presence.offline"
  | "mobile:presence.onlineOnMobile"
  | "mobile:presence.idleOnMobile";

/**
 * Which status string a peer's header line should show.
 *
 * A peer that is connected FROM MOBILE and not offline gets the platform-aware
 * wording ("Online on mobile") — the same signal the avatar's phone glyph shows
 * (task #47), so the two never disagree. Everything else (desktop, unknown
 * platform, or offline) reads as the plain status.
 */
export function presenceLabelKey(
  status: PresenceStatus,
  platform?: PresencePlatform,
): PresenceLabelKey {
  if (status !== "offline" && platform === "mobile") {
    return status === "idle" ? "mobile:presence.idleOnMobile" : "mobile:presence.onlineOnMobile";
  }
  if (status === "online") return "mobile:presence.online";
  if (status === "idle") return "mobile:presence.idle";
  return "mobile:presence.offline";
}

/** True when the header should render the phone glyph instead of the dot. */
export function showsMobileGlyph(status: PresenceStatus, platform?: PresencePlatform): boolean {
  return status !== "offline" && platform === "mobile";
}

/**
 * How many of `memberIds` are currently around (online OR idle — "idle" still
 * means the app is connected, matching the member-list convention).
 *
 * Folded over the presence map INSIDE the store selector so the subscription
 * yields a number: a presence tick that doesn't change the count re-renders
 * nothing (CLAUDE.md §27). Missing entries read as offline.
 */
export function countOnline(
  presence: Record<UserId, PresenceStatus>,
  memberIds: readonly UserId[],
): number {
  let online = 0;
  for (const id of memberIds) {
    if ((presence[id] ?? "offline") !== "offline") online += 1;
  }
  return online;
}
