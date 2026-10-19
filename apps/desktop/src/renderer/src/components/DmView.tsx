import { useEffect, useMemo } from "react";
import { m } from "framer-motion";
import { MessagesSquare, Search, X } from "lucide-react";
import { UserAvatar } from "@demli/ui";
import type { Channel, Dm } from "@demli/types";
import { useAppTranslation } from "../lib/i18n";
import { useDms, useHideDm } from "../queries/social-queries";
import { useChatStore } from "../stores/chat-store";
import { useUiStore } from "../stores/ui-store";
import { MessageList, springs } from "@demli/app-ui";
import { ConnectionBanner, TypingIndicator } from "./ChatChrome";
import { ChatDataProvider } from "./ChatDataProvider";
import { ChannelSearchPanel } from "./ChannelSearchPanel";
import { useChannelSearchHotkey } from "./useChannelSearchHotkey";
import { MessageComposer } from "./MessageComposer";
import { MemberContextMenu } from "./MemberContextMenu";
import { ProfileCard } from "./ProfileCard";
import { CallButtons } from "./CallButtons";
import { PinnedMessagesButton } from "./PinnedMessagesPanel";
import { EmbeddedCallStage } from "./EmbeddedCallStage";
import { UpdateBadge } from "./UpdateBadge";
import { HeaderAction } from "./HeaderAction";

/** A DM's hidden stream is a normal text channel — reuse the message pipeline. */
function streamChannelOf(dm: Dm): Channel {
  return {
    id: dm.streamId,
    groupId: dm.id,
    kind: "text",
    name: dm.participant.displayName,
    position: 0,
    createdAt: dm.createdAt,
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

function EmptyDm(): JSX.Element {
  const { t } = useAppTranslation();
  return (
    <EmptyPane
      icon={<MessagesSquare className="size-7" />}
      title={t("desktop:social.dmEmptyTitle")}
      body={t("desktop:social.dmEmptyBody")}
    />
  );
}

/**
 * Home-surface DM conversation (ADR 0010 §1). A DM reuses the channel-scoped
 * message pipeline unchanged, keyed by the DM's `streamId` — identical to the
 * flat group-chat view, but its identity is the other person, not a name/icon.
 */
export function DmView(): JSX.Element {
  const { t } = useAppTranslation();
  const activeDmId = useChatStore((s) => s.activeDmId);
  const setActiveStream = useChatStore((s) => s.setActiveStream);
  const { data: dms } = useDms();
  const hideDm = useHideDm();
  const searchOpen = useUiStore((s) => s.channelSearchOpen);
  const toggleChannelSearch = useUiStore((s) => s.toggleChannelSearch);

  // Ctrl/Cmd+F — the shared rule, so it works here exactly as in a server channel.
  useChannelSearchHotkey();

  const dm = useMemo(() => (dms ?? []).find((d) => d.id === activeDmId) ?? null, [dms, activeDmId]);
  const streamId = dm?.streamId;
  const participantId = dm?.participant.id ?? null;

  // Route the message pipeline at this DM's stream while it is open.
  useEffect(() => {
    if (streamId) setActiveStream(streamId);
  }, [streamId, setActiveStream]);

  const streamChannel = useMemo(() => (dm ? streamChannelOf(dm) : null), [dm]);

  // Subscribe to only THIS participant's presence, not the whole presence map,
  // so an unrelated presence tick never rerenders the DM view (§27).
  const status = useChatStore((s) =>
    participantId ? (s.presence[participantId] ?? "offline") : "offline",
  );
  const platform = useChatStore((s) =>
    participantId ? s.presencePlatforms[participantId] : undefined,
  );

  if (activeDmId === null || !dm || !streamChannel) return <EmptyDm />;

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-app">
      <header className="flex h-16 shrink-0 items-center gap-2.5 border-b border-stroke px-4">
        {/* The DM header's avatar/name carries the SAME user menu as the roster
            (right-click / long-press) — one component, one set of rules. */}
        <MemberContextMenu
          target={{
            userId: dm.participant.id,
            displayName: dm.participant.displayName,
            username: dm.participant.username,
          }}
          groupId={null}
        >
          <span className="contents">
            <ProfileCard userId={dm.participant.id}>
              <button
                type="button"
                className="-ml-1.5 flex min-w-0 cursor-pointer items-center gap-2.5 rounded-lg py-1 pl-1.5 pr-2.5 text-left transition-colors motion-hover hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <UserAvatar
                  name={dm.participant.displayName}
                  colorSeed={dm.participant.id}
                  src={dm.participant.avatarUrl}
                  size="sm"
                  presence={status}
                  presencePlatform={platform}
                />
                <span className="min-w-0">
                  <span className="block truncate font-display text-base font-medium text-fg-display">
                    {dm.participant.displayName}
                  </span>
                  <span className="block truncate text-label text-fg-faint">@{dm.participant.username}</span>
                </span>
              </button>
            </ProfileCard>
          </span>
        </MemberContextMenu>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <CallButtons dmId={dm.id} peerId={dm.participant.id} />
          {/* A DM has no role system, so every participant may pin (M17). */}
          <PinnedMessagesButton channelId={streamChannel.id} />
          {/* Message search — the same panel the server channels use, on the same
              channel-scoped endpoint. A DM's stream IS a text channel, so this
              needed an entry point, not a feature. */}
          <HeaderAction
            label={t("desktop:search.title")}
            tooltip={t("desktop:search.tooltip")}
            pressed={searchOpen}
            onClick={toggleChannelSearch}
          >
            <Search />
          </HeaderAction>
          <HeaderAction
            label={t("desktop:social.closeDm")}
            disabled={hideDm.isPending}
            onClick={() => hideDm.mutate(dm.id)}
          >
            <X />
          </HeaderAction>
          {/* Desktop app-update badge — the top-right corner on every surface. */}
          <UpdateBadge />
        </div>
      </header>

      {/* Embedded 1-1 call stage (task #104): when this DM has a live call it mounts
          a bounded-height, resizable call stage here at the top; the messages below
          keep their absolute-fill virtualized viewport untouched (§27). Self-hides
          when there is no call on this DM. */}
      <EmbeddedCallStage />

      <ConnectionBanner />

      {/* Body row: the conversation column, with the search panel beside it —
          the same arrangement the shared ChatView uses, so search looks and
          behaves identically on a DM and on a server channel. */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {/* key resets scroll/stick state cleanly when switching DMs */}
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
            label={dm.participant.displayName}
          />
        )}
      </div>
    </div>
  );
}
