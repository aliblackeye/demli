import { useMemo } from "react";
import { Crown, Loader2, UserPlus, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger, UserAvatar, cn } from "@demli/ui";
import { SectionHeading } from "@demli/app-ui";
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
        "group flex h-10 items-center gap-2.5 rounded-md px-2 transition-colors motion-instant hover:bg-white/[0.04]",
        // Not virtualized — skip layout/paint for rows scrolled out of view (§27).
        "content-visibility-row",
        offline && "opacity-55",
      )}
    >
      <ProfileCard userId={member.user.id}>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
        >
          <UserAvatar
            name={member.user.displayName}
            colorSeed={member.user.id}
            src={member.user.avatarUrl}
            size="sm"
            presence={member.status}
            presencePlatform={member.platform}
          />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg-muted">
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
            "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-fg-faint",
            "opacity-0 transition-opacity motion-instant hover:bg-danger/15 hover:text-danger",
            "group-hover:opacity-100 focus-visible:opacity-100",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
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
  const { data } = useGroupChat(activeGroupChatId);
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
      className="flex w-60 shrink-0 flex-col bg-sidebar shadow-panel-left"
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-stroke pl-4 pr-2">
        <h2 className="text-[13px] font-semibold text-fg-muted">
          {t("desktop:members.headerCount", { count: total })}
        </h2>
        {isOwner && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t("desktop:groupChats.addMember")}
                onClick={() => setAddGroupMemberDialogOpen(true)}
                className={cn(
                  "flex size-7 cursor-pointer items-center justify-center rounded-md text-fg-muted",
                  "transition-colors motion-instant hover:bg-white/[0.06] hover:text-fg",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                )}
              >
                <UserPlus className="size-[18px]" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("desktop:groupChats.addMember")}</TooltipContent>
          </Tooltip>
        )}
      </div>
      <div className="edge-fade-y min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {sections.map((section) => (
          <section
            key={section.status}
            aria-label={t("desktop:members.sectionMembers", {
              status: t(SECTION_KEY[section.status]),
            })}
          >
            <SectionHeading>
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
