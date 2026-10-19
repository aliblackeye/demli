/**
 * Desktop → shared-shell data bridge (Phase 1, tek-kaynak UI).
 *
 * Assembles the desktop's ui-store / chat-store / TanStack Query state into the
 * single {@link ShellData} contract that the shared @demli/app-ui shell-edge
 * components (GroupRail / ChannelSidebar / HomeSidebar / MemberSidebar) read via
 * useShellData(). Every platform-coupled derivation — per-server unread (reads
 * the query cache), mute mode, member role color, presence status, error
 * localization — is resolved HERE, so the shared components stay presentational
 * and their output is byte-identical to the desktop components they replace.
 *
 * Re-render boundary: this provider subscribes to the busy slices (presence,
 * unread maps, rosters). It is deliberately given `children` as a STABLE element
 * from the AppShell wrapper, so when a presence/unread tick re-renders THIS
 * component, React skips re-rendering the passed-through subtree (the chat/video
 * center included) and only the context CONSUMERS — the four sidebars — update.
 * That keeps the message center off the presence re-render path (§27).
 */
import type { ReactNode } from "react";
import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AppDataProvider, type ShellData } from "@demli/app-ui";
import { canCreateServerInvite, unreadBadgeText } from "@demli/client-core";
import { PERMISSIONS } from "@demli/types";
import type { ChannelCategory, ChannelId } from "@demli/types";
import type { GroupDetails } from "../lib/api-client";
import { openDownloadUrl } from "../lib/download-links";
import { railDownloadAction } from "../lib/download-surface";
import { queryKeys } from "../lib/query-client";
import {
  deriveStreamsUnread,
  type StreamsUnread,
  type UnreadMaps,
} from "../lib/server-unread";
import { indexRoles, memberColor } from "../lib/permissions";
import { localizeError } from "../lib/errors";
import { listStatus } from "../lib/shell-list-status";
import { useAppTranslation } from "../lib/i18n";
import { useNameOverrides } from "../lib/use-name-overrides";
import {
  useCategories,
  useGroupChats,
  useGroups,
  useGroupDetails,
  useReorderChannels,
  useRoles,
  useServerPermissions,
} from "../queries/chat-queries";
import { useDms, useHideDm } from "../queries/social-queries";
import {
  channelMuteModeFor,
  muteModeFor,
  useChatStore,
} from "../stores/chat-store";
import { useUiStore } from "../stores/ui-store";
import { useAuthStore } from "../stores/auth-store";
import { useVoiceStore } from "../stores/voice-store";

/** Home-row unread display state — mirrors HomeSidebar's former `useHomeStreamUnread`. */
function deriveHomeRowUnread(maps: UnreadMaps, streamId: string): ShellData["dms"][number]["unread"] {
  const isUnread = Boolean(maps.unreadChannelIds[streamId]);
  const isMentionUnread = Boolean(maps.mentionUnreadChannelIds[streamId]);
  const unreadCount = maps.unreadCounts[streamId] ?? 0;
  const muteMode = channelMuteModeFor(maps.notificationMutes, streamId, null);
  const showMentionBadge = muteMode === "mentions" && isMentionUnread;
  const showUnread = isUnread && (muteMode === null || showMentionBadge);
  // A mentions-muted stream's raw count includes muted noise → keep the pip.
  const countBadge =
    showUnread && muteMode !== "mentions" ? unreadBadgeText(unreadCount, true) : null;
  return { muted: muteMode !== null, showMentionBadge, showUnread, countBadge };
}

/** Assemble the {@link ShellData} value from desktop stores + queries. */
function useDesktopShellData(): ShellData {
  const { t } = useAppTranslation();
  const queryClient = useQueryClient();

  // ── routing (chat-store) ────────────────────────────────────────────────
  const activeView = useChatStore((s) => s.activeView);
  const homeView = useChatStore((s) => s.homeView);
  const activeGroupId = useChatStore((s) => s.activeGroupId);
  const activeChannelId = useChatStore((s) => s.activeChannelId);
  const activeGroupChatId = useChatStore((s) => s.activeGroupChatId);
  const activeDmId = useChatStore((s) => s.activeDmId);

  // ── unread / mute / presence maps (chat-store) ──────────────────────────
  const unreadChannelIds = useChatStore((s) => s.unreadChannelIds);
  const mentionUnreadChannelIds = useChatStore((s) => s.mentionUnreadChannelIds);
  const unreadCounts = useChatStore((s) => s.unreadCounts);
  const notificationMutes = useChatStore((s) => s.notificationMutes);
  const presence = useChatStore((s) => s.presence);
  const presencePlatforms = useChatStore((s) => s.presencePlatforms);
  const customStatuses = useChatStore((s) => s.customStatuses);

  // ── server state (queries) ──────────────────────────────────────────────
  const { data: groups } = useGroups();
  const dmsQuery = useDms();
  const dms = dmsQuery.data;
  const groupChatsQuery = useGroupChats();
  const detailsQuery = useGroupDetails(activeGroupId);
  const details = detailsQuery.data;
  const { data: categories } = useCategories(activeGroupId);
  const { data: roles } = useRoles(activeGroupId);
  const { isOwner, can } = useServerPermissions(activeGroupId);
  // Nickname overrides for this server, built once (ADR 0019 §2) and applied to
  // the roster below — never per row.
  const nameOverrides = useNameOverrides(activeGroupId);
  const currentUserId = useAuthStore((s) => s.user?.id);
  // Narrow selector: `roomId` changes only on join/leave, so the busy speaking /
  // participant ticks of a live call never reach this provider (§27).
  const connectedVoiceChannelId = useVoiceStore((s) =>
    s.status === "idle" ? null : s.roomId,
  );
  const hideDm = useHideDm();
  const reorderChannels = useReorderChannels(activeGroupId);
  const { mutateAsync: mutateReorder } = reorderChannels;

  // ── actions (stores — stable references) ────────────────────────────────
  const openServer = useChatStore((s) => s.openServer);
  const openHome = useChatStore((s) => s.openHome);
  const openFriends = useChatStore((s) => s.openFriends);
  const openRecentCalls = useChatStore((s) => s.openRecentCalls);
  const openDm = useChatStore((s) => s.openDm);
  const openGroupChat = useChatStore((s) => s.openGroupChat);
  const openAddServer = useUiStore((s) => s.openAddServer);
  const setDownloadDialogOpen = useUiStore((s) => s.setDownloadDialogOpen);
  const setCreateGroupChatDialogOpen = useUiStore((s) => s.setCreateGroupChatDialogOpen);
  const openLeaveServer = useUiStore((s) => s.openLeaveServer);
  const setInviteDialogOpen = useUiStore((s) => s.setInviteDialogOpen);
  const setChannelInviteChannelId = useUiStore((s) => s.setChannelInviteChannelId);
  const setCreateChannelDialogOpen = useUiStore((s) => s.setCreateChannelDialogOpen);
  const setServerSettingsOpen = useUiStore((s) => s.setServerSettingsOpen);
  const setCategoryDialog = useUiStore((s) => s.setCategoryDialog);

  const maps: UnreadMaps = useMemo(
    () => ({ unreadChannelIds, mentionUnreadChannelIds, unreadCounts, notificationMutes }),
    [unreadChannelIds, mentionUnreadChannelIds, unreadCounts, notificationMutes],
  );

  // ── group rail: per-server unread (mute-aware, from the cached channel ids)
  // + mute + owner flag. Cache reads are not a memo dep (channel lists are
  // near-static); a new server's badge settles on the next unread/mute change.
  const railGroups = useMemo(
    () =>
      (groups ?? []).map((g) => {
        const cached = queryClient.getQueryData<GroupDetails>(queryKeys.groupDetails(g.id));
        const channelIds = (cached?.channels ?? []).map((c) => c.id);
        const unread: StreamsUnread = deriveStreamsUnread(maps, channelIds, g.id);
        return {
          id: g.id,
          name: g.name,
          iconUrl: g.iconUrl ?? null,
          isOwner: g.ownerId === currentUserId,
          muted: muteModeFor(notificationMutes, "group", g.id) !== null,
          unread,
        };
      }),
    [groups, maps, notificationMutes, currentUserId, queryClient],
  );

  // ── group rail: aggregate unread across the whole home surface (DMs + flat
  // group chats), channel-scope mute only (groupId = null).
  const homeUnread = useMemo(() => {
    const ids = [
      ...(dms ?? []).map((d) => d.streamId),
      ...(groupChatsQuery.data ?? []).map((g) => g.streamId),
    ];
    return deriveStreamsUnread(maps, ids, null);
  }, [dms, groupChatsQuery.data, maps]);

  // ── channel sidebar ─────────────────────────────────────────────────────
  const activeGroupName = useMemo(
    () => (groups ?? []).find((g) => g.id === activeGroupId)?.name ?? null,
    [groups, activeGroupId],
  );
  const activeGroupBannerUrl = useMemo(
    () => (groups ?? []).find((g) => g.id === activeGroupId)?.bannerUrl ?? null,
    [groups, activeGroupId],
  );
  const channels = useMemo(() => details?.channels ?? [], [details]);
  const canManageChannels = isOwner || can(PERMISSIONS.MANAGE_CHANNELS);
  // The invite gate, decided ONCE here by the shared rule so the sidebar, the row
  // icons and the row menus cannot disagree — and so mobile reads the same
  // function rather than a second hand-written copy of the policy.
  const canCreateInvite = canCreateServerInvite({
    invitePolicy: details?.group.invitePolicy,
    membershipRole: details?.members.find((m) => m.userId === currentUserId)?.role,
    isOwner,
    hasCreateInvitePermission: can(PERMISSIONS.CREATE_INVITE),
  });
  // Channels muted INDIVIDUALLY (channel scope only — a server-scope mute must
  // not empty the whole sidebar when "hide muted" is on). Derived from the mute
  // mirror here because it is store-internal; the sidebar receives plain data.
  const mutedChannelIds = useMemo(() => {
    const ids = new Set<ChannelId>();
    for (const channel of channels) {
      if (channelMuteModeFor(notificationMutes, channel.id, null) !== null) ids.add(channel.id);
    }
    return ids;
  }, [channels, notificationMutes]);
  const canOpenServerSettings =
    isOwner ||
    can(PERMISSIONS.MANAGE_ROLES) ||
    can(PERMISSIONS.MANAGE_CHANNELS) ||
    can(PERMISSIONS.KICK_MEMBERS);

  // ── home sidebar: DM + group-chat rows with presence + pre-derived unread ─
  const dmRows = useMemo(
    () =>
      (dms ?? []).map((dm) => ({
        id: dm.id,
        streamId: dm.streamId,
        participantId: dm.participant.id,
        participantName: dm.participant.displayName,
        participantAvatarUrl: dm.participant.avatarUrl,
        status: presence[dm.participant.id] ?? "offline",
        platform: presencePlatforms[dm.participant.id],
        unread: deriveHomeRowUnread(maps, dm.streamId),
      })),
    [dms, presence, presencePlatforms, maps],
  );
  const groupChatRows = useMemo(
    () =>
      (groupChatsQuery.data ?? []).map((g) => ({
        id: g.id,
        streamId: g.streamId,
        name: g.name,
        unread: deriveHomeRowUnread(maps, g.streamId),
      })),
    [groupChatsQuery.data, maps],
  );
  const groupChatsStatus = listStatus(groupChatsQuery);
  const groupChatsErrorMessage =
    groupChatsStatus === "error" ? localizeError(groupChatsQuery.error, t) : null;
  const dmsStatus = listStatus(dmsQuery);
  const dmsErrorMessage = dmsStatus === "error" ? localizeError(dmsQuery.error, t) : null;

  // Active server's details: the same rule, scoped to "a server is open".
  const serverDetailsStatus = activeGroupId === null ? "ready" : listStatus(detailsQuery);
  const serverDetailsError =
    serverDetailsStatus === "error" ? localizeError(detailsQuery.error, t) : null;

  // ── member sidebar: flat roster with presence + role color + owner flag ───
  // Roles are pre-resolved to plain display chips here (highest-position first),
  // so the shared roster paints them without importing the permission helpers or
  // the roles query (M18 — "roller sağdaki üyelerde de gözüksün").
  const members = useMemo(() => {
    const rolesById = indexRoles(roles);
    const ownerId = details?.group.ownerId;
    return (details?.members ?? []).map((m) => {
      const memberRoles = (m.roleIds ?? [])
        .map((id) => rolesById.get(id))
        .filter((r): r is NonNullable<typeof r> => r !== undefined)
        .sort((a, b) => b.position - a.position)
        .map((r) => ({ id: r.id, name: r.name, color: r.color }));
      return {
        id: m.user.id,
        // Nickname-resolved ONCE here (ADR 0019 §2): private nickname → server
        // nickname → displayName. Every roster consumer then reads a plain
        // string, so no row re-implements the precedence.
        displayName: nameOverrides[m.user.id] ?? m.user.displayName,
        // Carry the photo through to the roster — without it every member renders
        // as initials no matter how fresh the data is.
        avatarUrl: m.user.avatarUrl,
        status: presence[m.userId] ?? "offline",
        platform: presencePlatforms[m.userId],
        isOwner: m.userId === ownerId,
        // Live custom status (M18) rides the presence map, not the member row —
        // the roster repaints on a status change without refetching the roster.
        customStatus: customStatuses[m.userId] ?? null,
        color: memberColor(m.roleIds, rolesById),
        roles: memberRoles,
        isGuest: m.role === "guest",
        // Raw instant (ADR 0019 §3) — the roster decides whether it is still in
        // force, so a mute that lapses while the app is open clears its own badge.
        timedOutUntil: m.timedOutUntil ?? null,
      };
    });
  }, [details, roles, presence, presencePlatforms, customStatuses, nameOverrides]);

  return {
    activeView,
    homeView,
    activeGroupId,
    activeChannelId,
    activeGroupChatId,
    activeDmId,

    groups: railGroups,
    homeUnread,

    activeGroupName,
    activeGroupBannerUrl,
    channels,
    categories: categories ?? EMPTY_CATEGORIES,
    canManageChannels,
    canOpenServerSettings,
    connectedVoiceChannelId,
    mutedChannelIds,
    canCreateInvite,
    // No cached data yet for the active server (first fetch, or a retry in
    // flight): drives the channel-column and roster skeletons. A first fetch
    // that FAILED drives their retry bands instead — never the empty states.
    serverDetailsLoading: serverDetailsStatus === "pending",
    serverDetailsError,
    retryServerDetails: () => void detailsQuery.refetch(),

    dms: dmRows,
    dmsStatus,
    dmsErrorMessage,
    retryDms: () => void dmsQuery.refetch(),
    groupChats: groupChatRows,
    groupChatsStatus,
    groupChatsErrorMessage,

    members,

    openServer,
    openHome,
    openFriends,
    openRecentCalls,
    openDm,
    openGroupChat,
    hideDm: (dmId) => hideDm.mutate(dmId),

    openCreateGroup: () => openAddServer(),
    // On a phone there is exactly one artifact worth offering, so the button IS
    // the download — routing through a one-row picker would be a step that
    // decides nothing (CLAUDE.md §35). Desktop browsers still get the picker.
    // The `hidden` case never reaches here: the rail does not render the button.
    openDownloadApp: () => {
      const action = railDownloadAction();
      if (action.kind === "direct") openDownloadUrl(action.url);
      else if (action.kind === "dialog") setDownloadDialogOpen(true);
    },
    openCreateGroupChat: () => setCreateGroupChatDialogOpen(true),
    openLeaveServer,
    openInvite: () => setInviteDialogOpen(true),
    openChannelInvite: (channelId) => setChannelInviteChannelId(channelId),
    openCreateChannel: (categoryId) => setCreateChannelDialogOpen(true, categoryId ?? null),
    openServerSettings: () => setServerSettingsOpen(true),
    retryGroupChats: () => void groupChatsQuery.refetch(),

    openCreateCategory: () => setCategoryDialog({ mode: "create" }),
    openRenameCategory: (categoryId, name) =>
      setCategoryDialog({ mode: "rename", categoryId, name }),
    openDeleteCategory: (categoryId, name) =>
      setCategoryDialog({ mode: "delete", categoryId, name }),
    // `mutateAsync` (not `mutate`): the sidebar awaits the result so a rejected
    // reorder can roll its optimistic order back instead of leaving a lie on
    // screen. The mutation's own onSettled re-reads the server either way.
    reorderSidebar: async (input) => {
      await mutateReorder(input);
    },
  };
}

/** Stable empty list so a server with no categories never churns the memo deps. */
const EMPTY_CATEGORIES: ChannelCategory[] = [];

/**
 * Wraps the shell subtree with the assembled {@link ShellData}. Pass the shell
 * frame as `children` from a parent that does NOT re-render on presence/unread,
 * so those ticks update only the sidebars (see the re-render boundary note).
 */
export function DesktopShellDataProvider({ children }: { children: ReactNode }): JSX.Element {
  const value = useDesktopShellData();
  return <AppDataProvider value={value}>{children}</AppDataProvider>;
}
