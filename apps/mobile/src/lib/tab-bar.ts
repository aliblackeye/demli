/**
 * Bottom tab-bar geometry shared between the tabs layout and the floating global
 * bars (VoiceMiniBar). The mini bars live in the authed `_layout` and float over
 * EVERY screen; on the three tab screens they must clear the bottom tab bar
 * instead of covering it. Both consumers import the one height so they stay in
 * lockstep — change it here, both move together.
 */

/** Content height of the bottom tab bar, excluding the bottom safe-area inset. */
export const TAB_BAR_CONTENT_HEIGHT = 58;

/** Route paths (within the authed area) that render the bottom tab bar. */
const TAB_ROUTES = ["/groups", "/friends", "/you"] as const;

/** True when `pathname` is one of the three tab screens (so the tab bar is shown). */
export function isTabRoute(pathname: string): boolean {
  return (TAB_ROUTES as readonly string[]).includes(pathname);
}
