import { useEffect, useRef, useState } from "react";
import { Menu, Users } from "lucide-react";
import { cn } from "@demli/ui";
import { useAppTranslation } from "../lib/i18n";
import { useGroups } from "../queries/chat-queries";
import { useChatStore } from "../stores/chat-store";
import { GroupRail } from "./GroupRail";
import { ChannelSidebar } from "./ChannelSidebar";
import { HomeSidebar } from "./HomeSidebar";
import { MemberSidebar } from "./MemberSidebar";
import { GroupChatMemberSidebar } from "./GroupChatMemberSidebar";
import { AppCenter } from "./AppCenter";
import { MobileDrawer } from "./MobileDrawer";

/**
 * Top-bar context title: the active server's name on the server surface, or
 * "Home" on the direct surface. Sits ABOVE each surface's own header (which
 * still shows the precise #channel / DM name), giving a two-level hierarchy —
 * "which server" here, "which channel" below — without duplicating either.
 */
function MobileTitle(): JSX.Element {
  const { t } = useAppTranslation();
  const isHome = useChatStore((s) => s.activeView === "home");
  const activeGroupId = useChatStore((s) => s.activeGroupId);
  const { data: groups } = useGroups();
  if (isHome) return <>{t("desktop:social.homeNav")}</>;
  const name = groups?.find((g) => g.id === activeGroupId)?.name;
  return <>{name ?? t("desktop:sidebar.serverFallback")}</>;
}

/**
 * Mobile single-column shell — the narrow-viewport
 * counterpart to the desktop four-column {@link AppShell}. It renders the SAME
 * center ({@link AppCenter}) full-screen, and moves the two navigation columns
 * into drawers:
 *
 *   - a LEFT drawer (hamburger / swipe target) holding the group rail + the
 *     channel-or-home sidebar (so server/channel/DM selection AND the voice
 *     panel stay reachable — no dead ends), and
 *   - a RIGHT drawer holding the member roster, opened from the top bar's
 *     members button (only on surfaces that actually have members).
 *
 * The panels are the exact same product components the desktop shell uses; only
 * the frame around them changes. Selecting a conversation slides the left drawer
 * away to reveal it.
 */
export function MobileShell(): JSX.Element {
  const { t } = useAppTranslation();
  const isHome = useChatStore((s) => s.activeView === "home");
  const homeView = useChatStore((s) => s.homeView);
  const activeGroupChatId = useChatStore((s) => s.activeGroupChatId);
  const memberSidebarOpen = useChatStore((s) => s.memberSidebarOpen);
  const toggleMemberSidebar = useChatStore((s) => s.toggleMemberSidebar);

  const [navOpen, setNavOpen] = useState(false);

  // Members panel defaults OPEN on desktop (the persistent 4th column); on mobile
  // it is a drawer that must start hidden so the chat is full-screen on load.
  // Force it closed once on entry into the mobile shell.
  useEffect(() => {
    useChatStore.setState({ memberSidebarOpen: false });
  }, []);

  // Only the server-channel surface and a flat group chat carry a roster; the
  // Friends table and 1:1 DMs do not (same rule the desktop shell uses).
  const showGroupChatMembers = isHome && homeView === "groupChat" && activeGroupChatId !== null;
  const hasMembers = !isHome || showGroupChatMembers;

  // If the surface loses its roster while the drawer is open (e.g. leaving a
  // group chat for Friends), close it so it can't strand over a roster-less view.
  useEffect(() => {
    if (!hasMembers && memberSidebarOpen) {
      useChatStore.setState({ memberSidebarOpen: false });
    }
  }, [hasMembers, memberSidebarOpen]);

  // Close the nav drawer whenever the active CONVERSATION changes — picking a
  // channel / DM / group chat / friends / recent-calls destination slides the
  // nav away to reveal it. Opening the Home surface (unchanged
  // homeView) or the drawer itself does not move this key, so browsing the rail
  // keeps the drawer open until an actual destination is chosen.
  const leafKey = useChatStore((s) =>
    s.activeView === "server"
      ? `server:${s.activeGroupId ?? ""}:${s.activeChannelId ?? ""}`
      : `home:${s.homeView}:${s.activeDmId ?? ""}:${s.activeGroupChatId ?? ""}`,
  );
  const prevLeaf = useRef(leafKey);
  useEffect(() => {
    if (leafKey !== prevLeaf.current) {
      prevLeaf.current = leafKey;
      setNavOpen(false);
    }
  }, [leafKey]);

  const membersDrawerOpen = hasMembers && memberSidebarOpen;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-app text-fg">
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-stroke bg-sidebar px-2">
        <button
          type="button"
          onClick={() => setNavOpen(true)}
          aria-label={t("desktop:mobileNav.openNav")}
          aria-expanded={navOpen}
          className={cn(
            "flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-fg-muted",
            "transition-colors motion-instant hover:bg-white/[0.06] hover:text-fg",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
          )}
        >
          <Menu className="size-5" />
        </button>
        <h1 className="min-w-0 flex-1 truncate px-1 text-sm font-semibold text-fg">
          <MobileTitle />
        </h1>
        {hasMembers && (
          <button
            type="button"
            onClick={toggleMemberSidebar}
            aria-label={
              memberSidebarOpen ? t("desktop:chat.hideMembers") : t("desktop:chat.showMembers")
            }
            aria-pressed={memberSidebarOpen}
            className={cn(
              "flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-fg-muted",
              "transition-colors motion-instant hover:bg-white/[0.06] hover:text-fg",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
              memberSidebarOpen && "bg-white/[0.06] text-fg",
            )}
          >
            <Users className="size-5" />
          </button>
        )}
      </header>

      {/* Full-screen center — same component the desktop shell centers. */}
      <div className="flex min-h-0 flex-1 flex-col">
        <AppCenter />
      </div>

      {/* Left navigation drawer: group rail + channel/home sidebar (carries the
          voice panel + user footer, so voice stays reachable on mobile). */}
      <MobileDrawer
        side="left"
        open={navOpen}
        onClose={() => setNavOpen(false)}
        label={t("desktop:mobileNav.navLabel")}
      >
        <div className="flex h-full">
          <GroupRail />
          {isHome ? <HomeSidebar /> : <ChannelSidebar />}
        </div>
      </MobileDrawer>

      {/* Right member-roster drawer (only on surfaces that have members). */}
      <MobileDrawer
        side="right"
        open={membersDrawerOpen}
        onClose={() => useChatStore.setState({ memberSidebarOpen: false })}
        label={t("desktop:members.membersNav")}
      >
        {showGroupChatMembers ? (
          <GroupChatMemberSidebar />
        ) : !isHome ? (
          <MemberSidebar />
        ) : null}
      </MobileDrawer>
    </div>
  );
}
