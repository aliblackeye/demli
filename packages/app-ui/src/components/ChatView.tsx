/**
 * ChatView — the SINGLE-SOURCE server-channel conversation surface (CLAUDE.md §7,
 * §8) shared by the desktop renderer and (Phase 4) the web app.
 *
 * It owns ONLY the channel header (# name + topic + search/invite/members
 * controls) and the chat column layout that hosts the virtualized
 * {@link MessageList}. Everything data-shaped comes from {@link useChatData}
 * (the open `channel` + the pre-derived {@link ChatHeaderControls} `header`), so
 * this component reads no store/query/window global directly and its rendered DOM
 * is byte-identical to the hand-written desktop ChatView it replaces. The
 * mutation/desktop-coupled pieces — the message rows (via the list's
 * `renderMessage` slot), the composer, the typing indicator, the connection
 * banner, the pin board button and the channel-search panel — are passed in as
 * composition slots by the surface's thin wrapper.
 *
 * Only the server-channel surface mounts this; the flat-group-chat and DM
 * surfaces render their own header and reuse {@link MessageList} directly.
 */
import { Hash, Search, UserPlus, Users, Volume2 } from "lucide-react";
import { useTranslation } from "@demli/i18n";
import { Button, Tooltip, TooltipContent, TooltipTrigger, cn } from "@demli/ui";
import type { ReactNode } from "react";
import { useChatData } from "../data/chat-data";
import { MessageList } from "./MessageList";

export interface ChatViewProps {
  /** Reconnect/offline chrome rendered directly under the header (desktop slot). */
  connectionBanner?: ReactNode;
  /** The "N people are typing…" line above the composer (desktop slot). */
  typingIndicator?: ReactNode;
  /** The message composer — the mutation-coupled input (required slot). */
  composer: ReactNode;
  /** The pinned-messages board trigger for the header actions (desktop slot). */
  pinnedButton?: ReactNode;
  /**
   * Chrome pinned to the FRONT of the header action group — the voice-channel
   * room controls (join / return to the stage / disconnect) that a voice
   * channel's chat header carries (M20). It leads the group because it is the
   * one PRIMARY action in that header; search/invite/members are secondary
   * chrome and keep their order after it. Empty on a text channel.
   */
  headerActionsLead?: ReactNode;
  /**
   * Extra chrome pinned to the FAR RIGHT of the header actions — the desktop
   * app-update badge. Rendered last so it owns the top-right corner; empty on
   * surfaces/platforms that have nothing to put there.
   */
  headerExtra?: ReactNode;
  /**
   * The channel-search side panel, or a falsy value when closed. The surface
   * decides visibility (it holds the search state that also drives the header
   * toggle's pressed styling via {@link ChatHeaderControls.searchOpen}).
   */
  searchPanel?: ReactNode;
}

export function ChatView({
  connectionBanner,
  typingIndicator,
  composer,
  pinnedButton,
  headerActionsLead,
  headerExtra,
  searchPanel,
}: ChatViewProps): JSX.Element {
  const { t } = useTranslation(["common", "desktop"]);
  const { channel, header } = useChatData();
  if (!header) {
    throw new Error(
      "<ChatView> requires ChatData.header — the server-channel surface must feed its " +
        "ChatDataProvider the search/invite/members header controls.",
    );
  }

  const topic = channel.description?.trim();
  // A voice channel's chat is the SAME surface, so it gets the same header —
  // only the glyph changes, so the user can tell at a glance which channel's
  // conversation they are reading (M20).
  const ChannelGlyph = channel.kind === "voice" ? Volume2 : Hash;

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-app">
      {/* Safari 12 has no flex `gap`; `space-x-2` reproduces the header gutter. The
          action group keeps its right-alignment with `!ml-auto` so the space-x
          margin does not override the `auto` margin (Safari-12 space-x/ml-auto
          trap). */}
      <header className="flex h-16 shrink-0 items-center space-x-2 border-b border-stroke px-4">
        <ChannelGlyph className="size-5 shrink-0 text-fg-subtle" aria-hidden />
        <h1 className="shrink-0 font-display text-[15px] font-semibold tracking-[-0.01em] text-fg-display">
          {channel.name}
        </h1>
        {topic && (
          <>
            <span aria-hidden className="h-4 w-px shrink-0 bg-stroke-strong" />
            <p className="min-w-0 truncate text-label text-fg-muted" title={topic}>
              {topic}
            </p>
          </>
        )}
        <div className="!ml-auto flex shrink-0 items-center space-x-1">
          {headerActionsLead}
          {pinnedButton}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("desktop:search.title")}
                aria-pressed={header.searchOpen}
                onClick={header.toggleSearch}
                className={cn(header.searchOpen && "bg-wash text-fg")}
              >
                <Search className="size-[18px]" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("desktop:search.tooltip")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("desktop:chat.invitePeople")}
                onClick={header.openInvite}
              >
                <UserPlus className="size-[18px]" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("desktop:chat.invitePeople")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={
                  header.memberSidebarOpen
                    ? t("desktop:chat.hideMembers")
                    : t("desktop:chat.showMembers")
                }
                aria-pressed={header.memberSidebarOpen}
                onClick={header.toggleMemberSidebar}
                className={cn(header.memberSidebarOpen && "bg-wash text-fg")}
              >
                <Users className="size-[18px]" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {header.memberSidebarOpen
                ? t("desktop:chat.hideMembers")
                : t("desktop:chat.showMembers")}
            </TooltipContent>
          </Tooltip>
          {headerExtra}
        </div>
      </header>

      {connectionBanner}

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {/* The single-source virtualized list reads its data from the surface's
              ChatDataProvider; key resets scroll/stick/divider state cleanly on
              channel switch (kept on the list, which owns those refs). */}
          <MessageList key={channel.id} />
          {/* The typing line lives INSIDE the composer's bottom padding (its
              pb-5 strip) instead of in the flow above it: someone starting or
              stopping typing must never resize the thread — a virtualized list
              pinned to the bottom would jump by a line each time. */}
          <div className="relative shrink-0">
            {composer}
            <div className="pointer-events-none absolute inset-x-0 bottom-0">{typingIndicator}</div>
          </div>
        </div>
        {searchPanel}
      </div>
    </div>
  );
}
