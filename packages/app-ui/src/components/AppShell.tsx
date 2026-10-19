/**
 * AppShell — the SINGLE-SOURCE four-column layout shell shared by the desktop
 * renderer and the web app (CLAUDE.md §7):
 *
 *   ┌──────────┬───────────┬─────────────────────────┬──────────┐
 *   │ groupRail│  sidebar  │         center          │ member-  │
 *   │ (rail)   │ (channels │  (chat / video stage)   │ sidebar  │
 *   │          │  or home) │                         │ (roster) │
 *   └──────────┴───────────┴─────────────────────────┴──────────┘
 *
 * Koyu Masa "ada" (island) frame — the landing's app preview, taken literally:
 * the window is pure black (`bg-rail`), the rail sits directly on it, and every
 * other column is its own rounded island (`rounded-card`, 24px) of the base tone,
 * separated from its neighbours by 8px of black instead of a border or a
 * shadow. Depth is surface tone, nothing else.
 *
 * It is PURELY presentational — a layout frame with named slots and NO data,
 * store, query, i18n or platform dependency. Every surface decides WHAT to put
 * in each slot from its own state and passes it in; the frame only positions the
 * columns and clips each one to its island. The columns paint their own base
 * tone, so the same components drop unchanged into the mobile drawer.
 *
 * The roster island fades in when it is toggled on (opacity only — the center's
 * width snaps rather than animating, because a width animation would relayout
 * the virtualized message list on every frame, §27).
 */
import type { ReactNode } from "react";

export interface AppShellProps {
  /** Left-most vertical rail: group/server avatars + the home button. */
  groupRail: ReactNode;
  /**
   * Second column: the server surface's channel list, or the home surface's
   * sidebar (friends / DMs / flat group chats). The caller picks which.
   */
  sidebar: ReactNode;
  /** Main conversation column — the text-channel chat, or the voice-room stage. */
  center: ReactNode;
  /**
   * Right-most roster column. Pass a falsy value (`false` / `null`) to omit it
   * entirely — e.g. when the member sidebar is toggled off, or the active home
   * sub-surface has no roster.
   */
  memberSidebar?: ReactNode;
  /**
   * Root-level overlays rendered as SIBLINGS of the column row (command menu,
   * dialogs, settings shell, headless listeners). Kept outside the flex row so
   * they never participate in the column layout.
   */
  overlays?: ReactNode;
}

/** One island: clips its column to the card radius. No fill of its own. */
const ISLAND = "flex min-h-0 shrink-0 overflow-hidden rounded-card";

/**
 * The shared four-column app frame. Renders the column row plus any root-level
 * overlays as siblings, inside a fragment so the caller can wrap it in its own
 * context providers (e.g. a `<TooltipProvider>`) without an extra DOM node.
 */
export function AppShell({
  groupRail,
  sidebar,
  center,
  memberSidebar,
  overlays,
}: AppShellProps): ReactNode {
  return (
    <>
      <div data-shell="desktop" className="flex h-screen gap-2 bg-rail py-2 pr-2 text-fg">
        {groupRail}
        <div className={ISLAND}>{sidebar}</div>
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-card bg-app">
          {center}
        </div>
        {memberSidebar ? (
          <div className={`${ISLAND} animate-fade-in`}>{memberSidebar}</div>
        ) : null}
      </div>
      {overlays}
    </>
  );
}
