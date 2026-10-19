import { useMemo } from "react";
import { Crown, Loader2, UserPlus, X } from "lucide-react";
import { IconButton, Tooltip, TooltipContent, TooltipTrigger, UserAvatar, cn } from "@demli/ui";
import {
  SectionHeading,
  ShellListSkeleton,
  shellRowFocusClass,
  shellRowIconButtonClass,
} from "@demli/app-ui";
import type { PresencePlatform, PresenceStatus, User } from "@demli/types";
import { useGroupChat, useRemoveGroupChatMember } from "../queries/chat-queries";
import { useAppTranslation } from "../lib/i18n";
import { useAuthStore } from "../stores/auth-store";
import { useChatStore } from "../stores/chat-store";
import { useUiStore } from "../stores/ui-store";
import { ProfileCard } from "./ProfileCard";

interface MemberRowData {
  user: User;
  status: PresenceStatus;
  platform?: PresencePlatform;
  isOwner: boolean;
}

const SECTION_ORDER: PresenceStatus[] = ["online", "idle", "dnd", "offline"];
const SECTION_KEY = {
  online: "desktop:members.online",
  idle: "desktop:members.idle",
  dnd: "desktop:members.dnd",
  offline: "desktop:members.offline",
  // "invisible" never reaches a peer (masked to offline server-side); it is not a
  // rendered section, but the map stays exhaustive so the type can't drift.
  invisible: "desktop:members.offline",
} as const satisfies Record<PresenceStatus, string>;

/** Bucket a peer's status into a rendered section (invisible → offline defensively). */
function sectionStatusOf(status: PresenceStatus): PresenceStatus {
  return status === "invisible" ? "offline" : status;
}

function MemberRow({
  member,
  canRemove,
  removing,
  onRemove,
}: {
  member: MemberRowData;
  canRemove: boolean;
  removing: boolean;
  onRemove: () => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const offline = member.status === "offline";
  return (
    <li
      className={cn(
        // Same roster row as the server member list: 48px, surface-tone hover.
        "group flex h-12 items-center gap-2.5 rounded-md px-2",
        "transition-[background-color,opacity] motion-hover hover:bg-hover",
        // Not virtualized — skip layout/paint for rows scrolled out of view (§27).
        "content-visibility-row",
        offline && "opacity-55 hover:opacity-100",
      )}
    >
      <ProfileCard userId={member.user.id}>
        <button
          type="button"
          className={cn("flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-sm text-left", shellRowFocusClass)}
        >
          <UserAvatar
            name={member.user.displayName}
            colorSeed={member.user.id}
            src={member.user.avatarUrl}
            size="sm"
            presence={member.status}
            presencePlatform={member.platform}
          />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg-muted transition-colors motion-hover group-hover:text-fg">
            {member.user.displayName}
          </span>
        </button>
      </ProfileCard>
      {member.isOwner && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Crown
              aria-label={t("desktop:members.ownerBadge")}
              className="size-3.5 shrink-0 text-idle"
            />
          </TooltipTrigger>
          <TooltipContent side="top">{t("desktop:members.ownerBadge")}</TooltipContent>
        </Tooltip>
      )}
      {canRemove && (
        <button
          type="button"
          aria-label={t("desktop:members.removeMember", { name: member.user.displayName })}
          disabled={removing}
          onClick={onRemove}
          className={cn(
            shellRowIconButtonClass,
            "opacity-0 hover:bg-danger-surface hover:text-danger",
            "group-hover:opacity-100 pointer-coarse:opacity-100",
            removing && "opacity-100",
          )}
        >
          {removing ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
        </button>
      )}
    </li>
  );
}

/** Home-surface right column: members of the active flat group chat. */
export function GroupChatMemberSidebar(): JSX.Element {
  const { t } = useAppTranslation();
  const activeGroupChatId = useChatStore((s) => s.activeGroupChatId);
  const presence = useChatStore((s) => s.presence);
  const presencePlatforms = useChatStore((s) => s.presencePlatforms);
  const currentUserId = useAuthStore((s) => s.user?.id);
  const setAddGroupMemberDialogOpen = useUiStore((s) => s.setAddGroupMemberDialogOpen);
  const { data, isPending } = useGroupChat(activeGroupChatId);
  const removeMember = useRemoveGroupChatMember(activeGroupChatId);

  const ownerId = data?.group.ownerId;
  const isOwner = ownerId !== undefined && ownerId === currentUserId;

  const sections = useMemo(() => {
    const byStatus = new Map<PresenceStatus, MemberRowData[]>(
      SECTION_ORDER.map((status) => [status, []]),
    );
    for (const member of data?.members ?? []) {
      const status = sectionStatusOf(presence[member.userId] ?? "offline");
      byStatus.get(status)?.push({
        user: member.user,
        status,
        platform: presencePlatforms[member.userId],
        isOwner: member.userId === ownerId,
      });
    }
    for (const rows of byStatus.values()) {
      rows.sort((a, b) => a.user.displayName.localeCompare(b.user.displayName));
    }
    return SECTION_ORDER.map((status) => ({
      status,
      rows: byStatus.get(status) ?? [],
    })).filter((section) => section.rows.length > 0);
  }, [data, presence, presencePlatforms, ownerId]);

  const total = sections.reduce((sum, section) => sum + section.rows.length, 0);
  const pendingRemovalId = removeMember.isPending ? removeMember.variables : undefined;

  return (
    <aside
      aria-label={t("desktop:members.groupMembersNav")}
      // Right-anchored panel — hairline + soft lift via `shadow-panel-left`.
      className="flex w-60 shrink-0 flex-col bg-sidebar"
    >
      <div className="flex h-16 shrink-0 items-center justify-between pl-4 pr-3">
        <h2 className="font-display text-base font-semibold text-fg-display">
          {t("desktop:members.headerCount", { count: total })}
        </h2>
        {isOwner && (
          <IconButton
            variant="ghost"
            size="sm"
            label={t("desktop:groupChats.addMember")}
            tooltipSide="bottom"
            onClick={() => setAddGroupMemberDialogOpen(true)}
          >
            <UserPlus aria-hidden />
          </IconButton>
        )}
      </div>
      <div className="edge-fade-y min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {isPending && activeGroupChatId !== null && (
          <ShellListSkeleton label={t("desktop:members.loading")} variant="member" rows={4} />
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
                  key={row.user.id}
                  member={row}
                  canRemove={isOwner && !row.isOwner && row.user.id !== currentUserId}
                  removing={pendingRemovalId === row.user.id}
                  onRemove={() => removeMember.mutate(row.user.id)}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </aside>
  );
}
