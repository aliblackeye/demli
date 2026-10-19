import type { ReactNode } from "react";
import { BellOff, PhoneCall, Plus, Users, X } from "lucide-react";
import { Button, IconButton, UserAvatar, cn, seedColor } from "@demli/ui";
import { useTranslation } from "@demli/i18n";
import {
  useShellData,
  type HomeRowUnread,
  type ShellDmRow,
  type ShellGroupChatRow,
} from "../data/shell-data";
import { SectionHeading } from "./SectionHeading";
import { ShellListSkeleton } from "./ShellListSkeleton";
import { UnreadCountBadge } from "./UnreadCountBadge";
import { shellRowClass, shellRowIconButtonClass, shellUnreadPipClass } from "./shellRow";

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

/**
 * A top-level destination row (Friends, Recent calls): an icon in its own small
 * surface box + the label, painted with the shared row language so "selected"
 * reads exactly like a selected channel.
 */
function DestinationButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={cn(shellRowClass({ selected: active }), "h-10 gap-2.5 px-2")}
    >
      <span
        aria-hidden
        className={cn(
          "grid size-7 shrink-0 place-items-center rounded-sm transition-colors motion-hover [&_svg]:size-4",
          active ? "bg-accent-surface text-accent" : "bg-surface text-fg-muted",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
    </button>
  );
}

/** Trailing unread badge + muted bell for a home row. Renders nothing when idle. */
function RowStatus({
  showUnread,
  muted,
  countBadge,
}: {
  showUnread: boolean;
  muted: boolean;
  countBadge: string | null;
}): JSX.Element | null {
  const { t } = useTranslation(["common", "desktop"]);
  // A real number shows as the coral count (a DM or group chat is always about
  // YOU); without one the row's left-edge pip carries the unread on its own.
  const showNumberBadge = showUnread && !!countBadge && countBadge !== "1+";
  if (!showNumberBadge && !muted) return null;
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1.5">
      {muted && (
        <BellOff aria-label={t("desktop:mute.mutedA11y")} className="size-3 text-fg-faint" />
      )}
      {showNumberBadge && (
        <UnreadCountBadge
          key={countBadge}
          text={countBadge!}
          aria-label={t("desktop:channel.unread")}
        />
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
  const hasNumber = highlightUnread && !!countBadge && countBadge !== "1+";
  return (
    // group/dm: hovering the row reveals the close-✕ over the status area.
    <div className="group/dm relative">
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? "true" : undefined}
        className={cn(
          shellRowClass({ selected: active, unread: highlightUnread, muted }),
          "h-11 gap-2.5 px-2 pr-9",
          // A long DM list is not virtualized — skip off-screen rows (§27).
          "content-visibility-row",
        )}
      >
        {highlightUnread && !hasNumber && (
          <span
            aria-label={t("desktop:channel.unread")}
            className={shellUnreadPipClass(showMentionBadge, "inset")}
          />
        )}
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
        <span className="ml-auto flex shrink-0 items-center transition-opacity motion-hover group-hover/dm:opacity-0 group-focus-within/dm:opacity-0">
          <RowStatus
            showUnread={highlightUnread}
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
          shellRowIconButtonClass,
          "absolute right-2 top-1/2 -translate-y-1/2 opacity-0",
          "group-hover/dm:opacity-100 pointer-coarse:opacity-100",
        )}
      >
        <X className="size-3.5" aria-hidden />
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
  const { t } = useTranslation(["common", "desktop"]);
  const { muted, showUnread, showMentionBadge, countBadge }: HomeRowUnread = group.unread;
  const highlightUnread = showUnread && !active;
  const hasNumber = highlightUnread && !!countBadge && countBadge !== "1+";
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active ? "true" : undefined}
      className={cn(
        shellRowClass({ selected: active, unread: highlightUnread, muted }),
        "h-11 gap-2.5 px-2",
        "content-visibility-row",
      )}
    >
      {highlightUnread && !hasNumber && (
        <span
          aria-label={t("desktop:channel.unread")}
          className={shellUnreadPipClass(showMentionBadge, "inset")}
        />
      )}
      <span
        aria-hidden
        className="flex size-8 shrink-0 items-center justify-center rounded-lg text-2xs font-semibold text-fg-display"
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
 *
 * Every row speaks the shared row language (`shellRow`): coral wash when
 * selected, surface tone on hover, a white left-edge pip + bold name when
 * unread, a coral count when there is a number.
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
      <div className="flex h-16 shrink-0 items-center px-4">
        <span className="font-display text-base font-semibold text-fg-display">
          {t("desktop:social.homeNav")}
        </span>
      </div>

      <nav
        aria-label={t("desktop:social.homeNav")}
        // edge-fade-y: DM/group rows dissolve under the "Home" header and above
        // the call dock rather than being cut mid-row.
        className="edge-fade-y min-h-0 flex-1 overflow-y-auto px-2 pb-2"
      >
        <div className="space-y-px">
          <DestinationButton
            active={friendsActive}
            onClick={() => openFriends()}
            icon={<Users />}
            label={t("desktop:social.friends")}
          />
          {showRecentCalls && (
            <DestinationButton
              active={recentCallsActive}
              onClick={() => openRecentCalls()}
              icon={<PhoneCall />}
              label={t("desktop:recentCalls.navLabel")}
            />
          )}
        </div>

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
          <div className="mx-1 rounded-lg bg-wash px-3 py-2.5">
            <p className="text-label font-medium text-fg-muted">{t("desktop:social.noDmsTitle")}</p>
            <p className="mt-0.5 text-2xs leading-snug text-fg-faint">{t("desktop:social.noDmsBody")}</p>
          </div>
        )}

        {/* Flat group chats (ADR 0005) */}
        <div className="flex items-center justify-between pr-1">
          <SectionHeading className="min-w-0 flex-1">{t("desktop:groupChats.heading")}</SectionHeading>
          {showCreateGroupChat && (
            <IconButton
              variant="ghost"
              size="sm"
              label={t("desktop:groupChats.newGroup")}
              tooltipSide="bottom"
              onClick={() => openCreateGroupChat()}
              className="mt-3 size-6 rounded-sm [&_svg]:size-4"
            >
              <Plus aria-hidden />
            </IconButton>
          )}
        </div>

        {groupChatsStatus === "pending" ? (
          <ShellListSkeleton label={t("desktop:groupChats.loading")} variant="member" rows={3} />
        ) : groupChatsStatus === "error" ? (
          <div role="alert" className="mx-1 flex flex-col items-start gap-2 rounded-lg bg-danger-surface px-3 py-2.5">
            <p className="text-label text-danger">{groupChatsErrorMessage}</p>
            <Button variant="ghost" size="sm" className="-ml-2" onClick={() => retryGroupChats()}>
              {t("buttons.retry")}
            </Button>
          </div>
        ) : groupChats.length > 0 ? (
          <div className="space-y-px">
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
            className={cn(
              shellRowClass({}),
              "mx-1 w-[calc(100%-0.5rem)] flex-col items-start gap-0.5 bg-wash px-3 py-2.5",
            )}
          >
            <span className="text-label font-medium text-fg-muted">{t("desktop:groupChats.emptyTitle")}</span>
            <span className="text-2xs leading-snug text-fg-faint">{t("desktop:groupChats.emptyBody")}</span>
          </button>
        ) : (
          <div className="mx-1 rounded-lg bg-wash px-3 py-2.5">
            <p className="text-label font-medium text-fg-muted">{t("desktop:groupChats.emptyTitle")}</p>
            <p className="mt-0.5 text-2xs leading-snug text-fg-faint">{t("desktop:groupChats.emptyBody")}</p>
          </div>
        )}
      </nav>

      {/* Bottom-left DM-call control dock (task #104): shows above the user bar
          while this DM's call is on screen. Self-hides otherwise. */}
      {callDock}
      {userFooter}
    </div>
  );
}
