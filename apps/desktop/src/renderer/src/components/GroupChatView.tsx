import { useEffect, useMemo, useState } from "react";
import { m } from "framer-motion";
import {
  Link2,
  LogOut,
  MoreHorizontal,
  Search,
  Trash2,
  TriangleAlert,
  UserPlus,
  Users,
} from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Skeleton,
  seedColor,
} from "@demli/ui";
import { Trans } from "@demli/i18n";
import type { Channel, Group } from "@demli/types";
import { localizeError } from "../lib/errors";
import { useAppTranslation } from "../lib/i18n";
import {
  useDeleteGroupChat,
  useGroupChat,
  useRemoveGroupChatMember,
} from "../queries/chat-queries";
import { resubscribeRealtime } from "../realtime/connection";
import { useAuthStore } from "../stores/auth-store";
import { useChatStore } from "../stores/chat-store";
import { useUiStore } from "../stores/ui-store";
import { FormErrorAlert, MessageList, springs } from "@demli/app-ui";
import { ConnectionBanner, TypingIndicator } from "./ChatChrome";
import { ChatDataProvider } from "./ChatDataProvider";
import { ChannelSearchPanel } from "./ChannelSearchPanel";
import { useChannelSearchHotkey } from "./useChannelSearchHotkey";
import { PinnedMessagesButton } from "./PinnedMessagesPanel";
import { MessageComposer } from "./MessageComposer";
import { UpdateBadge } from "./UpdateBadge";
import { HeaderAction } from "./HeaderAction";
import { ConfirmDialog } from "./settings-kit";

function groupInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.charAt(0) ?? "?";
  const second = words.length > 1 ? (words[words.length - 1]?.charAt(0) ?? "") : "";
  return (first + second).toUpperCase();
}

/** A group's hidden stream is a normal text channel — reuse the message pipeline. */
function streamChannelOf(group: Group): Channel {
  return {
    id: group.streamId,
    groupId: group.id,
    kind: "text",
    name: group.name,
    position: 0,
    createdAt: group.createdAt,
  };
}

function EmptyPane({
  icon,
  title,
  body,
}: {
  icon: JSX.Element;
  title: string;
  body: string;
}): JSX.Element {
  return (
    <div className="flex min-w-0 flex-1 items-center justify-center bg-app px-6">
      <m.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0, transition: springs.position }}
        className="relative max-w-xs text-center"
      >
        {/* The single warm light of the empty table. */}
        <span
          aria-hidden
          className="pointer-events-none absolute -top-10 left-1/2 size-32 -translate-x-1/2 rounded-full bg-accent-glow blur-3xl"
        />
        <div className="relative mx-auto flex size-14 items-center justify-center rounded-2xl bg-surface text-fg-muted">
          {icon}
        </div>
        <h2 className="relative mt-5 font-display text-xl font-medium text-fg-display">{title}</h2>
        <p className="relative mt-1.5 text-sm leading-relaxed text-fg-muted">{body}</p>
      </m.div>
    </div>
  );
}

function EmptyHome(): JSX.Element {
  const { t } = useAppTranslation();
  return (
    <EmptyPane
      icon={<Users className="size-7" />}
      title={t("desktop:groupChats.homeTitle")}
      body={t("desktop:groupChats.homeBody")}
    />
  );
}

/** Loading: the header and a few message rows in place, not a spinner. */
function GroupChatSkeleton({ label }: { label: string }): JSX.Element {
  const widths = ["w-64", "w-48", "w-80", "w-40"];
  return (
    <div role="status" aria-label={label} className="flex min-w-0 flex-1 flex-col bg-app">
      <div className="flex h-16 shrink-0 items-center gap-2.5 border-b border-stroke px-4">
        <Skeleton shape="rect" width={28} height={28} className="rounded-lg" />
        <Skeleton shape="line" height={14} className="w-36" />
        <Skeleton shape="line" height={12} className="w-14" />
      </div>
      <div className="flex flex-1 flex-col justify-end gap-5 px-4 pb-24">
        {widths.map((width, index) => (
          <div key={index} className="flex items-start gap-3">
            <Skeleton shape="circle" width={40} />
            <div className="flex-1 space-y-2 pt-1">
              <Skeleton shape="line" height={12} className="w-24" />
              <Skeleton shape="line" height={14} className={width} />
            </div>
          </div>
        ))}
      </div>
      <span className="sr-only">{label}</span>
    </div>
  );
}

/**
 * Home-surface conversation: a flat group chat (ADR 0005). Reuses the message
 * pipeline (MessageList / MessageComposer / chat chrome) keyed by the group's
 * `streamId`; the group has no channel list.
 */
export function GroupChatView(): JSX.Element {
  const { t } = useAppTranslation();
  const activeGroupChatId = useChatStore((s) => s.activeGroupChatId);
  const setActiveStream = useChatStore((s) => s.setActiveStream);
  const clearActiveGroupChat = useChatStore((s) => s.clearActiveGroupChat);
  const memberSidebarOpen = useChatStore((s) => s.memberSidebarOpen);
  const toggleMemberSidebar = useChatStore((s) => s.toggleMemberSidebar);
  const currentUserId = useAuthStore((s) => s.user?.id);
  const setAddGroupMemberDialogOpen = useUiStore((s) => s.setAddGroupMemberDialogOpen);
  const setGroupChatInviteId = useUiStore((s) => s.setGroupChatInviteId);
  const searchOpen = useUiStore((s) => s.channelSearchOpen);
  const toggleChannelSearch = useUiStore((s) => s.toggleChannelSearch);

  // Ctrl/Cmd+F — the shared rule, so it works here exactly as in a server channel.
  useChannelSearchHotkey();

  const { data, isPending, error, refetch, isFetching } = useGroupChat(activeGroupChatId);
  const group = data?.group;
  const isOwner = group !== undefined && group.ownerId === currentUserId;
  const streamId = group?.streamId;

  const leaveMember = useRemoveGroupChatMember(activeGroupChatId);
  const deleteGroup = useDeleteGroupChat();
  const busy = leaveMember.isPending || deleteGroup.isPending;
  // Deleting removes the group for EVERYONE — always confirmed (mobile confirms
  // via Alert; this dialog is the desktop counterpart).
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Leaving is destructive too (you lose access to the group) — confirm it like
  // delete rather than firing on a single menu click (task #3).
  const [confirmingLeave, setConfirmingLeave] = useState(false);

  // Route the message pipeline at this group's stream while it is open.
  useEffect(() => {
    if (streamId) setActiveStream(streamId);
  }, [streamId, setActiveStream]);

  const streamChannel = useMemo(() => (group ? streamChannelOf(group) : null), [group]);

  // Non-owner self-removal. On success the home surface drops back to its empty
  // state; the gateway re-handshake drops the (now-inaccessible) stream channel.
  const onLeave = (): void => {
    if (!currentUserId || busy) return;
    leaveMember.mutate(currentUserId, {
      onSuccess: () => {
        setConfirmingLeave(false);
        clearActiveGroupChat();
        resubscribeRealtime();
      },
    });
  };

  // Owner-only: delete the whole group (owner has no "leave" — deleting removes
  // it for everyone; the server broadcasts group.deleted so members drop it live).
  const onDelete = (): void => {
    if (!activeGroupChatId || busy) return;
    deleteGroup.mutate(activeGroupChatId, {
      onSuccess: () => {
        setConfirmingDelete(false);
        clearActiveGroupChat();
        resubscribeRealtime();
      },
    });
  };

  if (activeGroupChatId === null) return <EmptyHome />;

  if (isPending) {
    return <GroupChatSkeleton label={t("desktop:groupChats.loadingOne")} />;
  }

  if (error || !group || !streamChannel) {
    return (
      <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-app px-4 text-center">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-danger-surface text-danger">
          <TriangleAlert aria-hidden className="size-6" />
        </span>
        <h2 className="font-display text-lg font-medium text-fg-display">
          {t("desktop:settingsUi.groupLoadFailedTitle")}
        </h2>
        <p role="alert" className="max-w-sm text-sm text-fg-muted">
          {localizeError(error, t)}
        </p>
        <Button variant="secondary" size="sm" loading={isFetching} onClick={() => void refetch()}>
          {t("buttons.retry")}
        </Button>
      </div>
    );
  }

  const memberCount = data.members.length;

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-app">
      <header className="flex h-16 shrink-0 items-center gap-2.5 border-b border-stroke px-4">
        <span
          aria-hidden
          className="flex size-7 shrink-0 items-center justify-center rounded-lg text-2xs font-bold text-fg-display"
          style={{ backgroundColor: seedColor(group.id) }}
        >
          {groupInitials(group.name)}
        </span>
        <h1 className="min-w-0 shrink truncate font-display text-base font-medium text-fg-display">{group.name}</h1>
        <span aria-hidden className="h-5 w-px shrink-0 bg-stroke-strong" />
        <p className="shrink-0 truncate text-label text-fg-muted">
          {t("desktop:groupChats.memberCount", { count: memberCount })}
        </p>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {/* A flat group chat has no role system, so any member may pin (M17). */}
          <PinnedMessagesButton channelId={streamChannel.id} />
          {/* Message search — same panel, same endpoint as a server channel. */}
          <HeaderAction
            label={t("desktop:search.title")}
            tooltip={t("desktop:search.tooltip")}
            pressed={searchOpen}
            onClick={toggleChannelSearch}
          >
            <Search />
          </HeaderAction>
          {isOwner && (
            <HeaderAction label={t("desktop:groupChats.addMember")} onClick={() => setAddGroupMemberDialogOpen(true)}>
              <UserPlus />
            </HeaderAction>
          )}
          <HeaderAction
            label={memberSidebarOpen ? t("desktop:chat.hideMembers") : t("desktop:chat.showMembers")}
            pressed={memberSidebarOpen}
            onClick={toggleMemberSidebar}
          >
            <Users />
          </HeaderAction>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <HeaderAction label={t("desktop:groupChats.options")}>
                <MoreHorizontal />
              </HeaderAction>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {isOwner && (
                <DropdownMenuItem onSelect={() => setAddGroupMemberDialogOpen(true)}>
                  <UserPlus className="size-4" />
                  {t("desktop:groupChats.addMember")}
                </DropdownMenuItem>
              )}
              {/* Invite link (M18). Open to ANY member — a flat chat has no roles
                  and no invite policy — while revoking stays owner-only inside the
                  dialog, mirroring the API's split authority. */}
              <DropdownMenuItem onSelect={() => setGroupChatInviteId(group.id)}>
                <Link2 className="size-4" />
                {t("desktop:groupChatInvite.menuItem")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {isOwner ? (
                // Owners delete the group (removes it for everyone) rather than
                // leave it — no non-functional "leave" that the server rejects.
                <DropdownMenuItem
                  danger
                  disabled={busy}
                  onSelect={() => setConfirmingDelete(true)}
                >
                  <Trash2 className="size-4" />
                  {t("desktop:groupChats.deleteGroup")}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  danger
                  disabled={busy}
                  onSelect={() => setConfirmingLeave(true)}
                >
                  <LogOut className="size-4" />
                  {t("desktop:groupChats.leaveGroup")}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          {/* Desktop app-update badge — the top-right corner on every surface. */}
          <UpdateBadge />
        </div>
      </header>

      <ConnectionBanner />

      {/* Body row: conversation column + search panel, matching the shared
          ChatView so search is the same surface everywhere. */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {/* key resets scroll/stick state cleanly when switching groups */}
          <ChatDataProvider channel={streamChannel}>
            <MessageList key={streamChannel.id} />
          </ChatDataProvider>
          <TypingIndicator channelId={streamChannel.id} />
          <MessageComposer channel={streamChannel} />
        </div>
        {searchOpen && (
          <ChannelSearchPanel
            key={streamChannel.id}
            channel={streamChannel}
            label={group.name}
          />
        )}
      </div>

      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={t("desktop:groupChats.deleteGroup")}
        description={group.name}
        confirmLabel={t("desktop:groupChats.deleteGroup")}
        cancelLabel={t("buttons.cancel")}
        closeLabel={t("buttons.close")}
        onConfirm={onDelete}
        pending={deleteGroup.isPending}
        error={deleteGroup.isError ? <FormErrorAlert>{localizeError(deleteGroup.error, t)}</FormErrorAlert> : undefined}
      >
        <p className="text-sm leading-relaxed text-fg-muted">
          <Trans
            t={t}
            i18nKey="desktop:groupChats.deleteConfirmBody"
            values={{ group: group.name }}
            components={{ strong: <span className="font-medium text-fg" /> }}
          />
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmingLeave}
        onOpenChange={setConfirmingLeave}
        title={t("desktop:groupChats.leaveGroup")}
        description={group.name}
        confirmLabel={t("desktop:groupChats.leaveGroup")}
        cancelLabel={t("buttons.cancel")}
        closeLabel={t("buttons.close")}
        onConfirm={onLeave}
        pending={leaveMember.isPending}
        error={leaveMember.isError ? <FormErrorAlert>{localizeError(leaveMember.error, t)}</FormErrorAlert> : undefined}
      >
        <p className="text-sm leading-relaxed text-fg-muted">
          <Trans
            t={t}
            i18nKey="desktop:groupChats.leaveConfirmBody"
            values={{ group: group.name }}
            components={{ strong: <span className="font-medium text-fg" /> }}
          />
        </p>
      </ConfirmDialog>
    </div>
  );
}
