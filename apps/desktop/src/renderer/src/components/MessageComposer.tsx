/**
 * Desktop → shared composer data bridge (Phase 1 step 3d, tek-kaynak UI).
 *
 * The message composer now lives in @demli/app-ui; this file is the thin
 * desktop adapter. It assembles the desktop's stores / draft store / realtime
 * client / desktop-only sub-UI into the single {@link ComposerServices} contract
 * the shared <MessageComposer> reads via useComposerServices(), then provides it
 * around the shared component. So the rendered DOM stays byte-identical to the
 * hand-written composer it replaces while the composer itself is single-sourced.
 *
 * The services object is a MODULE CONSTANT — every member is a store-getState
 * call, a module function or a stable slot component, so there is nothing
 * render-scoped to memoize and one stable reference serves every mounted composer.
 * The emoji slot resolves its own {@link useCustomEmojiContext} at the composer's
 * tree position, so a DM (no CustomEmojiProvider) simply has no "Group" tab.
 */
import type { ReactNode } from "react";
import {
  MessageComposer as AppMessageComposer,
  ComposerServicesProvider,
  type ComposerSendBlock,
  type ComposerServices,
} from "@demli/app-ui";
import type { Channel, ChannelId } from "@demli/types";
import { useBlocks, useCachedDms } from "../queries/social-queries";
import {
  notifyComposerIdle,
  notifyComposerTyping,
  sendChatMessage,
} from "../realtime/connection";
import { useAuthStore } from "../stores/auth-store";
import { useChatStore } from "../stores/chat-store";
import { useUiStore } from "../stores/ui-store";
import { useDraftStore } from "../stores/draft-store";
import { getDraftText } from "../stores/draft-model";
import {
  ATTACHMENT_ACCEPT,
  useAttachmentDrafts,
  type AttachmentDraft,
} from "../hooks/useAttachmentDrafts";
import { AttachmentPreviewStrip } from "./AttachmentPreviewStrip";
import { useCustomEmojiContext } from "./CustomEmojiContext";
import { EmojiPicker } from "./EmojiPicker";
import { VoiceRecorder } from "./VoiceRecorder";
import { GifPicker } from "./GifPicker";

/**
 * Emoji-picker slot. A component (not a plain closure) because it reads the
 * surface's custom-emoji group from context AT the composer's tree position —
 * null outside a server surface, so a DM simply gets no custom-emoji category.
 */
function EmojiPickerSlot({
  onSelect,
  align,
  side,
  children,
}: {
  onSelect: (text: string) => void;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  children: ReactNode;
}): JSX.Element {
  const { groupId } = useCustomEmojiContext();
  return (
    <EmojiPicker groupId={groupId} onSelect={onSelect} align={align} side={side}>
      {children}
    </EmojiPicker>
  );
}

/**
 * "You blocked this person" — known before a send, so the composer can say it
 * instead of letting every message bounce off the server's `BLOCKED` refusal.
 *
 * Only a DM can be blocked, and a DM stream is recognised from the DM list the
 * shell already keeps in the cache — read WITHOUT fetching (a disabled observer
 * carrying the real query fn, never `skipToken`: that would strip the shared
 * query's fn and break every later DM-list invalidation), so a server-channel
 * composer adds no request. The block list itself is fetched
 * only once a DM is open, and the realtime block event invalidates it, so the
 * composer opens/closes live. Only the viewer's OWN blocks are knowable, which
 * is the point: nothing here can reveal that the other person blocked you.
 *
 * "Unblock" opens the ONE unblock confirmation (the shared block dialog), never
 * the mutation directly — same single-flow rule as the profile card.
 */
function useSendBlock(channelId: ChannelId): ComposerSendBlock | null {
  const { data: dms } = useCachedDms();
  const peer = dms?.find((dm) => dm.streamId === channelId)?.participant ?? null;
  const { data: blocks } = useBlocks(peer !== null);
  if (!peer || !(blocks ?? []).some((entry) => entry.user.id === peer.id)) return null;
  return {
    kind: "blocked",
    name: peer.displayName,
    unblock: () =>
      useUiStore
        .getState()
        .setBlockDialog({ userId: peer.id, displayName: peer.displayName, blocked: true }),
  };
}

/** The desktop's binding of the shared composer's data/action/slot contract. */
const composerServices: ComposerServices = {
  useMeId: () => useAuthStore((s) => s.user?.id),
  useUsers: () => useChatStore((s) => s.users),
  useReplyTarget: (channelId) => useChatStore((s) => s.replyTargets[channelId]),
  useReplyAuthorName: (channelId) =>
    useChatStore((s) => {
      const target = s.replyTargets[channelId];
      return target ? (s.users[target.authorId]?.displayName ?? null) : null;
    }),
  useAllowBroadcast: () =>
    useChatStore((s) => s.activeView === "server" || s.homeView === "groupChat"),
  useAttachmentsDisabled: () => useUiStore((s) => s.attachmentsDisabled),
  useAttachmentDrafts: (channelId) => useAttachmentDrafts(channelId),
  useSlowmodeCooldownUntil: (channelId) =>
    useChatStore((s) => s.slowmodeCooldownUntil[channelId] ?? 0),
  useSendBlock,

  getReplyTarget: (channelId) => useChatStore.getState().replyTargets[channelId],
  clearReplyTarget: (channelId) => useChatStore.getState().clearReplyTarget(channelId),
  clearSlowmodeCooldown: (channelId) => useChatStore.getState().clearSlowmodeCooldown(channelId),
  getDraft: (channelId) => getDraftText(useDraftStore.getState().drafts, channelId),
  setDraft: (channelId, text) => useDraftStore.getState().setDraft(channelId, text),
  clearDraft: (channelId) => useDraftStore.getState().clearDraft(channelId),
  flushDrafts: () => useDraftStore.getState().flush(),
  notifyTyping: notifyComposerTyping,
  notifyIdle: notifyComposerIdle,
  sendMessage: (channelId, text, media, reply) => sendChatMessage(channelId, text, media, reply),
  attachmentAccept: ATTACHMENT_ACCEPT,

  renderEmojiPicker: ({ onSelect, align, side, children }) => (
    <EmojiPickerSlot onSelect={onSelect} align={align} side={side}>
      {children}
    </EmojiPickerSlot>
  ),
  renderAttachmentPreview: ({ drafts, onRemove, onRetry }) => (
    // The runtime drafts ARE full AttachmentDrafts (from useAttachmentDrafts); the
    // seam only narrows the TYPE, so this cast at the desktop boundary is safe.
    <AttachmentPreviewStrip
      drafts={drafts as AttachmentDraft[]}
      onRemove={onRemove}
      onRetry={onRetry}
    />
  ),
  renderVoiceRecorder: ({ channelId, disabled }) => (
    <VoiceRecorder channelId={channelId} disabled={disabled} />
  ),
  renderGifPicker: ({ channelId, disabled }) => (
    <GifPicker channelId={channelId} disabled={disabled} />
  ),
};

export function MessageComposer({ channel }: { channel: Channel }): JSX.Element {
  return (
    <ComposerServicesProvider value={composerServices}>
      <AppMessageComposer channel={channel} />
    </ComposerServicesProvider>
  );
}
