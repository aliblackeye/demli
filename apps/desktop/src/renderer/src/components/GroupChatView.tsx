import { useEffect, useMemo, useState } from "react";
import {
  Link2,
  Loader2,
  LogOut,
  MoreHorizontal,
  Search,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
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
import { MessageList, type ChatIntro } from "@demli/app-ui";
import { ConnectionBanner, TypingIndicator } from "./ChatChrome";
import { ChatDataProvider } from "./ChatDataProvider";
import { ChannelSearchPanel } from "./ChannelSearchPanel";
import { useChannelSearchHotkey } from "./useChannelSearchHotkey";
import { PinnedMessagesButton } from "./PinnedMessagesPanel";
import { MessageComposer } from "./MessageComposer";
import { UpdateBadge } from "./UpdateBadge";

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

function EmptyHome(): JSX.Element {
  const { t } = useAppTranslation();
  return (
    <div className="flex min-w-0 flex-1 items-center justify-center bg-app">
      <div className="max-w-xs text-center">
        <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-raised">
          <Users className="size-7 text-fg-muted" />
        </div>
        <h2 className="mt-4 text-lg font-semibold text-fg">
          {t("desktop:groupChats.homeTitle")}
        </h2>
        <p className="mt-1 text-sm text-fg-muted">{t("desktop:groupChats.homeBody")}</p>
      </div>
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

  const { data, isPending, error, refetch } = useGroupChat(activeGroupChatId);
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
  // The empty thread opens on the group, not on a "#name" channel intro.
  const groupId = group?.id;
  const groupName = group?.name;
  const intro = useMemo<ChatIntro | undefined>(
    () => (groupId && groupName ? { kind: "groupChat", groupId, name: groupName } : undefined),
    [groupId, groupName],
  );

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
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center bg-app">
        <Loader2
          aria-label={t("desktop:groupChats.loadingOne")}
          className="size-6 animate-spin text-fg-faint"
        />
      </div>
    );
  }

  if (error || !group || !streamChannel) {
    return (
      <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-app px-4">
        <p className="text-sm text-fg-muted">{localizeError(error, t)}</p>
        <Button variant="secondary" size="sm" onClick={() => void refetch()}>
          {t("buttons.retry")}
        </Button>
      </div>
    );
  }

  const memberCount = data.members.length;

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-app">
      <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-stroke px-4">
        <span
          aria-hidden
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-[9px] font-bold text-white/90"
          style={{ backgroundColor: seedColor(group.id) }}
        >
          {groupInitials(group.name)}
        </span>
        <h1 className="shrink-0 truncate text-sm font-semibold text-fg">{group.name}</h1>
        <span aria-hidden className="h-4 w-px shrink-0 bg-stroke-strong" />
        <p className="min-w-0 truncate text-[13px] text-fg-muted">
          {t("desktop:groupChats.memberCount", { count: memberCount })}
        </p>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {/* A flat group chat has no role system, so any member may pin (M17). */}
          <PinnedMessagesButton channelId={streamChannel.id} />
          {/* Message search — same panel, same endpoint as a server channel. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("desktop:search.title")}
                aria-pressed={searchOpen}
                onClick={toggleChannelSearch}
                className={cn(searchOpen && "bg-white/[0.06] text-fg")}
              >
                <Search className="size-[18px]" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("desktop:search.tooltip")}</TooltipContent>
          </Tooltip>
          {isOwner && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("desktop:groupChats.addMember")}
                  onClick={() => setAddGroupMemberDialogOpen(true)}
                >
                  <UserPlus className="size-[18px]" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t("desktop:groupChats.addMember")}</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={
                  memberSidebarOpen
                    ? t("desktop:chat.hideMembers")
                    : t("desktop:chat.showMembers")
                }
                aria-pressed={memberSidebarOpen}
                onClick={toggleMemberSidebar}
                className={cn(memberSidebarOpen && "bg-white/[0.06] text-fg")}
              >
                <Users className="size-[18px]" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {memberSidebarOpen ? t("desktop:chat.hideMembers") : t("desktop:chat.showMembers")}
            </TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={t("desktop:groupChats.options")}>
                <MoreHorizontal className="size-[18px]" />
              </Button>
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
          <ChatDataProvider channel={streamChannel} intro={intro}>
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

      <Dialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("desktop:groupChats.deleteGroup")}</DialogTitle>
            <DialogDescription>{group.name}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <p className="text-sm leading-relaxed text-fg-muted">
              <Trans
                t={t}
                i18nKey="desktop:groupChats.deleteConfirmBody"
                values={{ group: group.name }}
                components={{ strong: <span className="font-medium text-fg" /> }}
              />
            </p>
            <div className="mt-5 flex gap-2">
              <Button variant="danger" disabled={busy} onClick={onDelete} className="flex-1">
                {deleteGroup.isPending && <Loader2 className="size-4 animate-spin" />}
                {t("desktop:groupChats.deleteGroup")}
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => setConfirmingDelete(false)}
                className="flex-1"
              >
                {t("buttons.cancel")}
              </Button>
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmingLeave} onOpenChange={setConfirmingLeave}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("desktop:groupChats.leaveGroup")}</DialogTitle>
            <DialogDescription>{group.name}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <p className="text-sm leading-relaxed text-fg-muted">
              <Trans
                t={t}
                i18nKey="desktop:groupChats.leaveConfirmBody"
                values={{ group: group.name }}
                components={{ strong: <span className="font-medium text-fg" /> }}
              />
            </p>
            <div className="mt-5 flex gap-2">
              <Button variant="danger" disabled={busy} onClick={onLeave} className="flex-1">
                {leaveMember.isPending && <Loader2 className="size-4 animate-spin" />}
                {t("desktop:groupChats.leaveGroup")}
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => setConfirmingLeave(false)}
                className="flex-1"
              >
                {t("buttons.cancel")}
              </Button>
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  );
}
