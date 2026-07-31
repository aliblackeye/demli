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
 * It is PURELY presentational — a layout frame with named slots and NO data,
 * store, query, i18n or platform dependency. Every surface decides WHAT to put
 * in each slot from its own state and passes it in; the frame only positions the
 * columns and paints the shared chrome (rail background + the content-edge seam
 * on the conversation column). Root-level overlays (dialogs, command menu,
 * settings) render as siblings via the `overlays` slot so a surface can keep its
 * dialogs mounted at the shell root exactly as before.
 *
 * Phase-1 note: the desktop passes its rich product components (GroupRail,
 * ChannelSidebar, ChatView, the VideoStage-vs-ChatView center, MemberSidebar,
 * and its dialog stack) into these slots, so the desktop DOM/appearance is
 * byte-identical to the hand-written shell it replaces. The web wide view will
 * pass the same shared components once they are ported; the Phase-2 desktop-only
 * arms (video stage, voice panel, call surfaces) stay in the desktop's slot
 * fillers and never enter this frame.
 *
 * The layout classes here (`bg-rail`, `text-fg`, `shadow-content-edge`) are the
 * exact ones the previous desktop AppShell used; they resolve through the shared
 * `--tc-*` tokens on both surfaces. The consuming app's Tailwind build must scan
 * this package's source for those classes to be generated (`@source` on desktop,
 * a content glob on web).
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
  /**
   * Main conversation column — the text-channel chat, or (desktop Phase-2) the
   * voice-room video stage. Rendered inside the content-edge seam wrapper so the
   * hairline between the navigation chrome and the content sheet is identical to
   * the previous shell.
   */
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
   * they never participate in the column layout, matching the previous shell.
   */
  overlays?: ReactNode;
}

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
      <div className="flex h-screen bg-rail text-fg">
        {groupRail}
        {sidebar}
        {/* The conversation column is the "content sheet" of the app: a hairline
            along its top-left seam separates it from the navigation chrome
            without spending a border's worth of layout width. Purely a
            box-shadow, so the flex sizing is untouched. */}
        <div className="flex min-w-0 flex-1 shadow-content-edge">{center}</div>
        {memberSidebar}
      </div>
      {overlays}
    </>
  );
}
