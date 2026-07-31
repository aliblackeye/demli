import type { ReactNode } from "react";
import { BellOff, Loader2, PhoneCall, Plus, Users, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger, UserAvatar, cn, seedColor } from "@demli/ui";
import { useTranslation } from "@demli/i18n";
import {
  useShellData,
  type HomeRowUnread,
  type ShellDmRow,
  type ShellGroupChatRow,
} from "../data/shell-data";
import { SectionHeading } from "./SectionHeading";
import { UnreadCountBadge } from "./UnreadCountBadge";

export interface HomeSidebarProps {
  /** DM-call control dock above the user bar (desktop CallDock). */
  callDock?: ReactNode;
  /** User footer slot at the column bottom (desktop UserFooter). */
  userFooter?: ReactNode;
  /**
   * Show the "Recent calls" entry. Default true (desktop). A surface without a
   * call-history view (web, Phase 4) passes false so it is not a dead row (§35).
   */
  showRecentCalls?: boolean;
  /**
   * Show the "new group chat" affordances (the "+" header button and the
   * empty-state create prompt). Default true (desktop). A surface without a
   * create-group-chat flow (web, Phase 4) passes false; the empty state falls
   * back to a plain caption instead of a dead button (§35).
   */
  showCreateGroupChat?: boolean;
}

function groupInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.charAt(0) ?? "?";
  const second = words.length > 1 ? (words[words.length - 1]?.charAt(0) ?? "") : "";
  return (first + second).toUpperCase();
}

/** Top entry: opens the Friends table (Online / All / Pending / Add). */
function FriendsButton({ active, onClick }: { active: boolean; onClick: () => void }): JSX.Element {
  const { t } = useTranslation(["common", "desktop"]);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex h-10 w-full cursor-pointer items-center space-x-2.5 rounded-md px-2.5 text-left",
        "transition-colors motion-instant",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
        active ? "bg-white/[0.06] text-fg" : "text-fg-muted hover:bg-white/[0.04] hover:text-fg",
      )}
    >
      <Users className="size-[18px] shrink-0" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">
        {t("desktop:social.friends")}
      </span>
    </button>
  );
}

/** Entry below Friends: opens the cross-DM call history (Voice-UX #2). */
function RecentCallsButton({
  active,
  onClick,
}: {
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  const { t } = useTranslation(["common", "desktop"]);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex h-10 w-full cursor-pointer items-center space-x-2.5 rounded-md px-2.5 text-left",
        "transition-colors motion-instant",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
        active ? "bg-white/[0.06] text-fg" : "text-fg-muted hover:bg-white/[0.04] hover:text-fg",
      )}
    >
      <PhoneCall className="size-[18px] shrink-0" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">
        {t("desktop:recentCalls.navLabel")}
      </span>
    </button>
  );
}

/** Trailing unread badge/pip + muted bell for a home row. Renders nothing when idle. */
function RowStatus({
  showUnread,
  showMentionBadge,
  muted,
  countBadge,
}: {
  showUnread: boolean;
  showMentionBadge: boolean;
  muted: boolean;
  countBadge: string | null;
}): JSX.Element | null {
  const { t } = useTranslation(["common", "desktop"]);
  if (!showUnread && !muted) return null;
  // A real number replaces the pip; "1+"/absent keeps the pip (§ "sayı yoksa pip kalsın").
  const showNumberBadge = !!countBadge && countBadge !== "1+";
  return (
    <span className="ml-auto flex shrink-0 items-center space-x-1.5">
      {showUnread &&
        (showNumberBadge ? (
          <UnreadCountBadge text={countBadge!} aria-label={t("desktop:channel.unread")} />
        ) : (
          <span
            aria-label={t("desktop:channel.unread")}
            className={cn("size-2 rounded-full", showMentionBadge ? "bg-accent" : "bg-fg")}
          />
        ))}
      {muted && (
        <BellOff aria-label={t("desktop:mute.mutedA11y")} className="size-3 text-fg-faint" />
      )}
    </span>
  );
}

function DmRow({
  dm,
  active,
  onOpen,
  onHide,
}: {
  dm: ShellDmRow;
  active: boolean;
  onOpen: () => void;
  /** Close (hide-for-self) this DM — history is preserved and returns on reopen. */
  onHide: () => void;
}): JSX.Element {
  const { t } = useTranslation(["common", "desktop"]);
  const { muted, showUnread, showMentionBadge, countBadge }: HomeRowUnread = dm.unread;
  const highlightUnread = showUnread && !active;
  return (
    // group/dm: hovering the row reveals the close-✕ and dims the unread badge.
    <div className="group/dm relative">
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? "true" : undefined}
        className={cn(
          "flex h-11 w-full cursor-pointer items-center space-x-2.5 rounded-md px-2 text-left",
          "transition-colors motion-instant",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
          // A long DM list is not virtualized — skip off-screen rows (§27).
          "content-visibility-row",
          active
            ? "bg-white/[0.06] text-fg"
            : highlightUnread
              ? "text-fg hover:bg-white/[0.04]"
              : "text-fg-muted hover:bg-white/[0.04] hover:text-fg",
          // Muted rows read quieter unless active or carrying a live badge.
          muted && !active && !showUnread && "opacity-55",
        )}
      >
        <UserAvatar
          name={dm.participantName}
          colorSeed={dm.participantId}
          src={dm.participantAvatarUrl}
          size="sm"
          presence={dm.status}
          presencePlatform={dm.platform}
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm font-medium",
            highlightUnread && "font-semibold text-fg",
          )}
        >
          {dm.participantName}
        </span>
        {/* Unread/mute status fades under the close-✕ while the row is hovered. */}
        <span className="ml-auto flex shrink-0 items-center transition-opacity motion-instant group-hover/dm:opacity-0">
          <RowStatus
            showUnread={highlightUnread}
            showMentionBadge={showMentionBadge}
            muted={muted}
            countBadge={countBadge}
          />
        </span>
      </button>
      {/* Close DM: reveals on hover/focus, sits over the status area. A sibling of
          the row button (not nested) so the markup stays valid. */}
      <button
        type="button"
        aria-label={t("desktop:social.closeDm")}
        title={t("desktop:social.closeDm")}
        onClick={onHide}
        className={cn(
          "absolute right-1.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md",
          "text-fg-faint opacity-0 transition-opacity motion-instant",
          "hover:bg-white/[0.08] hover:text-fg",
          "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
          "group-hover/dm:opacity-100",
        )}
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

function GroupChatRow({
  group,
  active,
  onOpen,
}: {
  group: ShellGroupChatRow;
  active: boolean;
  onOpen: () => void;
}): JSX.Element {
  const { muted, showUnread, showMentionBadge, countBadge }: HomeRowUnread = group.unread;
  const highlightUnread = showUnread && !active;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex h-11 w-full cursor-pointer items-center space-x-2.5 rounded-md px-2 text-left",
        "transition-colors motion-instant",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
        "content-visibility-row",
        active
          ? "bg-white/[0.06] text-fg"
          : highlightUnread
            ? "text-fg hover:bg-white/[0.04]"
            : "text-fg-muted hover:bg-white/[0.04] hover:text-fg",
        muted && !active && !showUnread && "opacity-55",
      )}
    >
      <span
        aria-hidden
        className="flex size-8 shrink-0 items-center justify-center rounded-lg text-2xs font-bold text-white/90"
        style={{ backgroundColor: seedColor(group.id) }}
      >
        {groupInitials(group.name)}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-sm font-medium",
          highlightUnread && "font-semibold text-fg",
        )}
      >
        {group.name}
      </span>
      <RowStatus
        showUnread={highlightUnread}
        showMentionBadge={showMentionBadge}
        muted={muted}
        countBadge={countBadge}
      />
    </button>
  );
}

/**
 * Home-surface second column (ADR 0010 §5): a Friends entry, the call history,
 * the caller's DM list and their flat group chats. Selecting any row routes the
 * center pane via the shell's home routing. Reads its lists — already
 * presence-tagged and unread-derived — from {@link useShellData}; the DM-call
 * dock and the user footer are slots.
 */
export function HomeSidebar({
  callDock,
  userFooter,
  showRecentCalls = true,
  showCreateGroupChat = true,
}: HomeSidebarProps): JSX.Element {
  const { t } = useTranslation(["common", "desktop"]);
  const {
    homeView,
    activeView,
    activeDmId,
    activeGroupChatId,
    dms,
    groupChats,
    groupChatsStatus,
    groupChatsErrorMessage,
    openFriends,
    openRecentCalls,
    openDm,
    openGroupChat,
    hideDm,
    openCreateGroupChat,
    retryGroupChats,
  } = useShellData();

  const isHome = activeView === "home";
  const friendsActive = isHome && homeView === "friends";
  const recentCallsActive = isHome && homeView === "recentCalls";

  return (
    <div className="flex w-60 shrink-0 flex-col bg-sidebar">
      <div className="flex h-16 shrink-0 items-center border-b border-stroke px-3.5">
        <span className="text-sm font-semibold text-fg">{t("desktop:social.homeNav")}</span>
      </div>

      <nav
        aria-label={t("desktop:social.homeNav")}
        // edge-fade-y: DM/group rows dissolve under the "Home" header and above
        // the call dock rather than being cut mid-row.
        className="edge-fade-y min-h-0 flex-1 overflow-y-auto px-2 py-2"
      >
        <FriendsButton active={friendsActive} onClick={() => openFriends()} />
        {showRecentCalls && (
          <RecentCallsButton active={recentCallsActive} onClick={() => openRecentCalls()} />
        )}

        {/* Direct messages */}
        <SectionHeading>{t("desktop:social.dmsHeading")}</SectionHeading>
        {dms.length > 0 ? (
          <div className="space-y-px">
            {dms.map((dm) => (
              <DmRow
                key={dm.id}
                dm={dm}
                active={homeView === "dm" && activeDmId === dm.id}
                onOpen={() => openDm({ id: dm.id, streamId: dm.streamId })}
                onHide={() => hideDm(dm.id)}
              />
            ))}
          </div>
        ) : (
          <p className="px-2 py-1 text-xs text-fg-faint">{t("desktop:social.noDmsTitle")}</p>
        )}

        {/* Flat group chats (ADR 0005) */}
        <div className="mt-2 flex items-center justify-between pl-2 pr-1 pt-2">
          <span className="text-2xs font-semibold uppercase tracking-wider text-fg-faint">
            {t("desktop:groupChats.heading")}
          </span>
          {showCreateGroupChat && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={t("desktop:groupChats.newGroup")}
                  onClick={() => openCreateGroupChat()}
                  className={cn(
                    "flex size-6 cursor-pointer items-center justify-center rounded-md text-fg-muted",
                    "transition-colors motion-instant hover:bg-white/[0.06] hover:text-fg",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                  )}
                >
                  <Plus className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t("desktop:groupChats.newGroup")}</TooltipContent>
            </Tooltip>
          )}
        </div>

        {groupChatsStatus === "pending" ? (
          <div
            role="status"
            className="flex items-center justify-center space-x-2 py-6 text-xs text-fg-faint"
          >
            <Loader2 className="size-4 animate-spin" />
            {t("desktop:groupChats.loading")}
          </div>
        ) : groupChatsStatus === "error" ? (
          <div className="flex flex-col items-center space-y-2 px-3 py-6 text-center">
            <p className="text-xs text-fg-muted">{groupChatsErrorMessage}</p>
            <button
              type="button"
              onClick={() => retryGroupChats()}
              className="cursor-pointer text-xs font-medium text-accent hover:underline"
            >
              {t("buttons.retry")}
            </button>
          </div>
        ) : groupChats.length > 0 ? (
          <div className="mt-1 space-y-px">
            {groupChats.map((group) => (
              <GroupChatRow
                key={group.id}
                group={group}
                active={homeView === "groupChat" && activeGroupChatId === group.id}
                onOpen={() => openGroupChat({ id: group.id, streamId: group.streamId })}
              />
            ))}
          </div>
        ) : showCreateGroupChat ? (
          <button
            type="button"
            onClick={() => openCreateGroupChat()}
            className="mt-1 w-full px-2 py-1 text-left text-xs text-fg-faint hover:text-accent"
          >
            {t("desktop:groupChats.emptyBody")}
          </button>
        ) : (
          <p className="mt-1 w-full px-2 py-1 text-left text-xs text-fg-faint">
            {t("desktop:groupChats.emptyBody")}
          </p>
        )}
      </nav>

      {/* Bottom-left DM-call control dock (task #104): shows above the user bar
          while this DM's call is on screen. Self-hides otherwise. */}
      {callDock}
      {userFooter}
    </div>
  );
}
