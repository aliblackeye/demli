/**
 * Pure model of the notification-permission surfaces (field report 2026-10-20).
 * No react-native / expo imports, so it is vitest-testable.
 */

/** What the OS said last time we asked. `unknown` = not read yet (or the read failed). */
export type PermissionStatus = "unknown" | "granted" | "denied";

export interface PermissionSnapshot {
  status: PermissionStatus;
  /** Android/iOS still allow the in-app system prompt. False = only system settings can change it. */
  canAskAgain: boolean;
}

/**
 * The Home banner shows only when the answer is KNOWN to be "no" and the user
 * has not waved it off this session. Unknown never shows (no flash on launch,
 * and a failed read must not claim notifications are off).
 */
export function shouldShowPermissionBanner(
  snapshot: PermissionSnapshot,
  dismissedThisSession: boolean,
): boolean {
  return snapshot.status === "denied" && !dismissedThisSession;
}

/**
 * The banner's one action: ask in-app while the OS still allows it, otherwise
 * send the user to the app's system settings page (the only place a hard
 * denial can be reversed).
 */
export function permissionAction(snapshot: PermissionSnapshot): "request" | "settings" {
  return snapshot.canAskAgain ? "request" : "settings";
}

/** Minimum gap between two foreground token refreshes. */
export const TOKEN_REFRESH_MIN_INTERVAL_MS = 60_000;

/**
 * Re-register on foreground, but not on every flick between apps: at most once
 * per {@link TOKEN_REFRESH_MIN_INTERVAL_MS}. A permission that just flipped to
 * granted always registers.
 */
export function shouldRefreshToken(input: {
  now: number;
  lastRefreshAt: number | null;
  justGranted: boolean;
}): boolean {
  if (input.justGranted) return true;
  if (input.lastRefreshAt === null) return true;
  return input.now - input.lastRefreshAt >= TOKEN_REFRESH_MIN_INTERVAL_MS;
}
