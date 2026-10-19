import { useMemo } from "react";
import type { MouseEvent, ReactElement, ReactNode } from "react";
import { Crown, MoreVertical } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger, UserAvatar, cn } from "@demli/ui";
import { useTranslation } from "@demli/i18n";
import type { GroupId, PresenceStatus, UserId } from "@demli/types";
import { useShellData, type ShellMember, type ShellMemberRole } from "../data/shell-data";
import { openActionMenuAt } from "./ActionMenu";
import { useActiveTimeouts } from "./memberTimeout";
import { RoleChip } from "./RoleChip";
import { RetryNotice } from "./EmptyState";
import { SectionHeading } from "./SectionHeading";
import { ShellListSkeleton } from "./ShellListSkeleton";
import { shellRowFocusClass } from "./shellRow";
import { TimeoutBadge } from "./TimeoutBadge";

const SECTION_ORDER: PresenceStatus[] = ["online", "idle", "dnd", "offline"];

const SECTION_KEY = {
  online: "desktop:members.online",
  idle: "desktop:members.idle",
  dnd: "desktop:members.dnd",
  offline: "desktop:members.offline",
  // "invisible" never reaches a peer (masked to offline server-side); kept only
  // so the map stays exhaustive.
  invisible: "desktop:members.offline",
} as const satisfies Record<PresenceStatus, string>;

/** Bucket a peer's status into a rendered section (invisible → offline defensively). */
function sectionStatusOf(status: PresenceStatus): PresenceStatus {
  return status === "invisible" ? "offline" : status;
}

/**
 * Wrap a member row's button in the surface's profile affordance. Desktop hands
 * back its ProfileCard popover; web (Phase 4) can return the children unwrapped.
 */
export type RenderMemberProfile = (
  userId: UserId,
  groupId: GroupId | null,
  children: ReactNode,
) => ReactNode;

/**
 * Wrap a member row in a surface-provided actions menu (desktop: a right-click
 * role-assignment context menu). Defaults to identity — a surface without role
 * management (web today, or a viewer without MANAGE_ROLES) renders no menu, so
 * there is never a dead/unauthorized control (§35).
 */
export type RenderMemberMenu = (member: ShellMember, children: ReactElement) => ReactNode;

export interface MemberSidebarProps {
  /** Wraps each row's button (desktop: ProfileCard popover). Defaults to identity. */
  renderMemberProfile?: RenderMemberProfile;
  /** Wraps each row in an actions menu (desktop: role assignment). Defaults to identity. */
  renderMemberMenu?: RenderMemberMenu;
}

/**
 * The member's roles as compact colored chips, on a second line under the name
 * (M18: "roller sağdaki üyelerde de gözüksün"). Single, horizontally-clipped row
 * so the fixed row height never grows with the role count — the full set stays in
 * the profile card. Renders nothing when the member holds no roles.
 */
function RoleChips({ roles }: { roles: ShellMemberRole[] }): JSX.Element | null {
  if (roles.length === 0) return null;
  return (
    <span className="mt-0.5 flex min-w-0 items-center gap-1 overflow-hidden">
      {roles.map((role) => (
        <RoleChip key={role.id} name={role.name} color={role.color} size="sm" />
      ))}
    </span>
  );
}

function MemberRow({
  member,
  groupId,
  renderProfile,
  renderMenu,
  hasMenu,
  timedOut,
}: {
  member: ShellMember;
  groupId: GroupId | null;
  renderProfile: RenderMemberProfile;
  renderMenu: RenderMemberMenu;
  /** A real actions menu is attached (viewer can manage this roster). Gates the
   *  visible kebab so an unauthorized viewer never sees a dead control (§35). */
  hasMenu: boolean;
  /** Their timeout is in force RIGHT NOW (the roster's single expiry timer decides). */
  timedOut: boolean;
}): JSX.Element {
  const { t } = useTranslation(["common", "desktop"]);
  const offline = member.status === "offline";
  const row = (
    <li
      className={cn(
        // `group` powers the hover-revealed kebab below. Hover is the shell's
        // one row gesture: the surface tone, 200ms, nothing moves.
        "group flex h-12 items-center gap-2.5 rounded-md px-2",
        "transition-[background-color,opacity] motion-hover hover:bg-hover has-[:active]:bg-raised-pressed",
        // Roster is NOT virtualized (a friend group's member count is small but
        // the rows are avatar-heavy) — skip layout/paint for off-screen rows.
        "content-visibility-row",
        // Offline members recede but stay readable; hovering one brings it back.
        offline && "opacity-55 hover:opacity-100",
      )}
    >
      {renderProfile(
        member.id,
        groupId,
        <button
          type="button"
          className={cn("flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-sm text-left", shellRowFocusClass)}
        >
          <UserAvatar
            src={member.avatarUrl ?? undefined}
            name={member.displayName}
            colorSeed={member.id}
            size="sm"
            presence={member.status}
            presencePlatform={member.platform}
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span
              className="min-w-0 truncate text-sm font-medium text-fg-muted transition-colors motion-hover group-hover:text-fg"
              style={{ color: member.color ?? undefined }}
            >
              {member.displayName}
            </span>
            {/* Custom status (M18) sits directly under the name.
                Rendered as PLAIN TEXT via a JSX child — never markdown or HTML
                (§28) — and truncated to one line so the row height is fixed. It
                takes the second line's slot; the role chips fall back to it only
                when there is no status, keeping the roster at 54px either way. */}
            {member.customStatus ? (
              <span
                className="mt-0.5 min-w-0 truncate text-2xs leading-snug text-fg-faint"
                title={member.customStatus}
              >
                {member.customStatus}
              </span>
            ) : (
              <RoleChips roles={member.roles} />
            )}
          </span>
        </button>,
      )}
      {/* Timed out (ADR 0019 §3) — a temporary, reversible state, so it reads as
          a small clock beside the owner crown rather than a colored pill. */}
      {timedOut && member.timedOutUntil && <TimeoutBadge timedOutUntil={member.timedOutUntil} />}
      {member.isOwner && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Crown
              aria-label={t("desktop:members.ownerBadge")}
              className="size-3.5 shrink-0 self-center text-idle"
            />
          </TooltipTrigger>
          <TooltipContent side="top">{t("desktop:members.ownerBadge")}</TooltipContent>
        </Tooltip>
      )}
      {/* Touch-reachable entry to the role menu (no right-click on mobile). Opens
          the SAME menu the surface wrapped this row with, by dispatching a bubbling
          `contextmenu` that reaches the row's ActionMenu trigger. Hidden + removed
          from layout on a fine pointer so wide-screen rows are unchanged (right-
          click still works there); shown only on a coarse pointer / narrow viewport. */}
      {hasMenu && (
        <button
          type="button"
          aria-label={t("a11y.moreActions")}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e: MouseEvent<HTMLButtonElement>) => {
            e.preventDefault();
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            openActionMenuAt(e.currentTarget, rect.left, rect.bottom);
          }}
          className={cn(
            "hidden size-7 shrink-0 items-center justify-center self-center rounded-sm text-fg-faint",
            "transition-colors motion-hover hover:bg-wash-strong hover:text-fg",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
            "pointer-coarse:inline-flex",
          )}
        >
          <MoreVertical className="size-4" aria-hidden />
        </button>
      )}
    </li>
  );
  return <>{renderMenu(member, row)}</>;
}

/**
 * Right-anchored roster column for the active server (CLAUDE.md §7), grouped by
 * presence (online / idle / offline) and sorted by display name within each
 * group. Reads its member list — already presence-tagged, role-colored and
 * owner-flagged — from {@link useShellData}; the profile popover is a slot.
 */
export function MemberSidebar({
  renderMemberProfile,
  renderMemberMenu,
}: MemberSidebarProps): JSX.Element {
  const { t } = useTranslation(["common", "desktop"]);
  const {
    members,
    activeGroupId,
    serverDetailsLoading = false,
    serverDetailsError = null,
    retryServerDetails,
  } = useShellData();
  // Nothing landed for this roster yet — loading or failed. Either way there is
  // no count to show: "Üyeler — 0" would be a lie.
  const rosterMissing = members.length === 0 && (serverDetailsLoading || serverDetailsError !== null);
  const renderProfile: RenderMemberProfile =
    renderMemberProfile ?? ((_userId, _groupId, children) => children);
  const renderMenu: RenderMemberMenu = renderMemberMenu ?? ((_member, children) => children);
  // Only render the visible kebab when a real menu is attached (a viewer who can
  // manage roles) — never a dead control for everyone else (§35).
  const hasMenu = renderMemberMenu != null;

  // ONE expiry timer for the whole roster (§27): the set drops an id the instant
  // that member's mute lapses, so the badge clears itself with no refetch and no
  // per-row timer. `members` is already a memoized array from the shell provider.
  const timedOutIds = useActiveTimeouts(members);

  const sections = useMemo(() => {
    const byStatus = new Map<PresenceStatus, ShellMember[]>(
      SECTION_ORDER.map((status) => [status, []]),
    );
    for (const member of members) {
      byStatus.get(sectionStatusOf(member.status))?.push(member);
    }
    for (const rows of byStatus.values()) {
      rows.sort((a, b) => a.displayName.localeCompare(b.displayName));
    }
    return SECTION_ORDER.map((status) => ({
      status,
      rows: byStatus.get(status) ?? [],
    })).filter((section) => section.rows.length > 0);
  }, [members]);

  const total = sections.reduce((sum, section) => sum + section.rows.length, 0);

  return (
    <aside
      aria-label={t("desktop:members.membersNav")}
      // Right-anchored panel: the hairline moved from `border-l` into
      // `shadow-panel-left`, which adds a wide, very soft lift so the roster
      // reads as floating over the conversation (Y-axis shadows are invisible
      // on a column you meet from the side).
      className="flex w-60 shrink-0 flex-col bg-sidebar"
    >
      <div className="flex h-16 shrink-0 items-center px-4">
        <h2 className="font-display text-base font-semibold text-fg-display">
          {/* No count until the roster has landed — "Üyeler — 0" would be a lie. */}
          {rosterMissing
            ? t("desktop:members.membersNav")
            : t("desktop:members.headerCount", { count: total })}
        </h2>
      </div>
      <div className="edge-fade-y min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {serverDetailsLoading && members.length === 0 && (
          <ShellListSkeleton label={t("desktop:members.loading")} variant="member" rows={7} />
        )}
        {!serverDetailsLoading && serverDetailsError !== null && members.length === 0 && (
          <RetryNotice
            variant="band"
            title={t("desktop:members.loadFailed")}
            message={serverDetailsError}
            retryLabel={t("common:buttons.retry")}
            onRetry={() => retryServerDetails?.()}
            className="mt-1"
          />
        )}
        {sections.map((section) => (
          <section
            key={section.status}
            aria-label={t("desktop:members.sectionMembers", {
              status: t(SECTION_KEY[section.status]),
            })}
          >
            <SectionHeading tone="muted">
              {t(SECTION_KEY[section.status])} — {section.rows.length}
            </SectionHeading>
            <ul className="space-y-px">
              {section.rows.map((row) => (
                <MemberRow
                  key={row.id}
                  member={row}
                  groupId={activeGroupId}
                  renderProfile={renderProfile}
                  renderMenu={renderMenu}
                  hasMenu={hasMenu}
                  timedOut={timedOutIds.has(row.id)}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </aside>
  );
}
