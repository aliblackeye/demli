/**
 * Desktop server-channel chat surface — the thin wrapper around the SINGLE-SOURCE
 * @demli/app-ui <ChatView>. It keeps all the desktop-specific wiring (the
 * active group/channel selection, the member-color derivation, the Ctrl/Cmd+F
 * shortcut, the search/invite/members header state) and feeds the shared frame:
 *   - the open `channel` + pre-derived header controls via <ChatDataProvider>
 *     (the ChatData seam the shared header + list read through useChatData), and
 *   - the mutation/desktop-coupled pieces (composer, typing indicator, connection
 *     banner, pin board button, channel-search panel) as composition slots.
 * So the rendered DOM stays byte-identical to the hand-written surface it
 * replaces while the header + list layout live in the shared package.
 */
import { useCallback, useMemo } from "react";
import { ChatView as AppChatView, type ChatHeaderControls } from "@demli/app-ui";
import { useGroupDetails, useRoles } from "../queries/chat-queries";
import { useMe } from "../queries/social-queries";
import { buildMemberColorMap } from "../lib/permissions";
import { useAppTranslation } from "../lib/i18n";
import { useChatStore } from "../stores/chat-store";
import { useUiStore } from "../stores/ui-store";
import { useNsfwGateStore } from "../stores/nsfw-gate-store";
import { ConnectionBanner, TypingIndicator } from "./ChatChrome";
import { ChannelSearchPanel } from "./ChannelSearchPanel";
import { useChannelSearchHotkey } from "./useChannelSearchHotkey";
import { ChatDataProvider } from "./ChatDataProvider";
import { CustomEmojiProvider } from "./CustomEmojiContext";
import { PinnedMessagesButton } from "./PinnedMessagesPanel";
import { UpdateBadge } from "./UpdateBadge";
import { MessageComposer } from "./MessageComposer";
import { NsfwChannelGate } from "./NsfwChannelGate";
import { VoiceChannelHeaderControls } from "./VoiceChannelHeaderControls";

export function ChatView(): JSX.Element {
  const { t } = useAppTranslation();
  const activeGroupId = useChatStore((s) => s.activeGroupId);
  const activeChannelId = useChatStore((s) => s.activeChannelId);
  const memberSidebarOpen = useChatStore((s) => s.memberSidebarOpen);
  const toggleMemberSidebar = useChatStore((s) => s.toggleMemberSidebar);
  const setInviteDialogOpen = useUiStore((s) => s.setInviteDialogOpen);
  const searchOpen = useUiStore((s) => s.channelSearchOpen);
  const toggleChannelSearch = useUiStore((s) => s.toggleChannelSearch);
  const { data: details } = useGroupDetails(activeGroupId);
  const { data: roles } = useRoles(activeGroupId);
  // Age gate inputs (M18). `useMe` carries the caller's own `isAdult` AND whether
  // a (set-once) date of birth exists — the gate needs both to tell "you haven't
  // told us yet" apart from "you told us, and you're a minor". Read
  // unconditionally (hook rules); the gate is decided after the `!channel` guard.
  const me = useMe();
  const activeChannel = details?.channels.find((c) => c.id === activeChannelId);
  const nsfwConfirmed = useNsfwGateStore((s) =>
    activeChannel ? (s.confirmedByChannel[activeChannel.id] ?? false) : false,
  );

  const channel = activeChannel;

  // Ctrl/Cmd+F opens (or toggles) the search panel. Shared with DmView and
  // GroupChatView so the shortcut behaves identically on every conversation.
  useChannelSearchHotkey();

  // Member-name colors (highest colored role) for message authors. Stable per
  // members/roles change — recomputes only when either query updates, never on
  // presence ticks, so the virtualized list is not re-rendered by presence.
  const authorColors = useMemo(
    () => buildMemberColorMap(details?.members, roles),
    [details?.members, roles],
  );

  const openInvite = useCallback(() => setInviteDialogOpen(true), [setInviteDialogOpen]);
  // Memoized so a search / member toggle repaints only the shared header chrome
  // and never churns the ChatData value the list consumes (§27). The action
  // callbacks are stable store refs; only the two pressed-state booleans move it.
  const header = useMemo<ChatHeaderControls>(
    () => ({
      searchOpen,
      toggleSearch: toggleChannelSearch,
      openInvite,
      memberSidebarOpen,
      toggleMemberSidebar,
    }),
    [searchOpen, toggleChannelSearch, openInvite, memberSidebarOpen, toggleMemberSidebar],
  );

  if (!channel) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center bg-app">
        <p className="text-sm text-fg-muted">{t("desktop:chat.selectChannel")}</p>
      </div>
    );
  }

  // NSFW gate (M18): hide content for a minor / un-birthdated user, and show a
  // one-time confirm to an adult who has not yet acknowledged this channel. When
  // gated we render neither the message list nor the composer, so there is no way
  // to read or post in the channel until the gate clears.
  if (channel.nsfw) {
    const isAdult = me.data?.isAdult === true;
    if (!isAdult || !nsfwConfirmed) {
      return (
        <NsfwChannelGate
          channel={channel}
          isAdult={isAdult}
          birthdateSet={Boolean(me.data?.birthdate)}
        />
      );
    }
  }

  return (
    <CustomEmojiProvider groupId={channel.groupId}>
      <ChatDataProvider
        channel={channel}
        authorColors={authorColors}
        profileGroupId={channel.groupId}
        header={header}
      >
        <AppChatView
          connectionBanner={<ConnectionBanner />}
          typingIndicator={<TypingIndicator channelId={channel.id} />}
          composer={<MessageComposer channel={channel} />}
          pinnedButton={
            <PinnedMessagesButton channelId={channel.id} groupId={channel.groupId} />
          }
          headerActionsLead={
            // M20: a voice channel's chat is THIS surface, unchanged — the only
            // difference is the room control leading the header actions (join /
            // return to the stage / disconnect). Renders nothing on a text
            // channel, so both kinds share one component tree.
            <VoiceChannelHeaderControls
              channel={channel}
              groupName={details?.group.name ?? null}
            />
          }
          headerExtra={<UpdateBadge />}
          searchPanel={
            searchOpen ? <ChannelSearchPanel key={channel.id} channel={channel} /> : null
          }
        />
      </ChatDataProvider>
    </CustomEmojiProvider>
  );
}
