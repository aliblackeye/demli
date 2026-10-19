/**
 * Message-row services seam (Phase 1 step 3d, tek-kaynak UI).
 *
 * The single typed surface the shared {@link "../components/MessageRow".MessageRow}
 * reads its store subscriptions, mutations and desktop-coupled sub-pieces from,
 * instead of touching a Zustand store, the REST client or a desktop-only
 * component (ProfileCard / AttachmentGrid / …) directly. Same design as
 * {@link ./chat-data}:
 *   - REACTIVE members are exposed as HOOKS ({@link useDisplayName},
 *     {@link useCurrentUserId}) so each row subscribes to exactly the store slice
 *     it needs, with the same re-render granularity as the desktop original (§27).
 *   - NON-reactive members are plain callbacks/slots resolved by the surface.
 *   - The mutation-coupled sub-UI (profile card, attachment grid, embeds, reaction
 *     picker) is NOT data — it is a composition SLOT the surface supplies.
 *
 * The provider is mounted ONCE around the list (the desktop ChatDataProvider) so
 * the services object is a single stable reference — it never appears in
 * MessageRow's prop list, so the row's `memo` is untouched and a data/outbox tick
 * still re-renders only the rows whose props actually changed.
 */
import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type { Attachment, AttachmentId, MessageEmbed } from "@demli/types";
import type { ChatMessageView } from "./chat-data";

/** The ambient services the shared {@link "../components/MessageRow".MessageRow} reads. */
export interface MessageRowServices {
  /* ── Reactive (hooks — called during a row's render) ─────────────────────── */
  /** Subscribe to a user's display name (null when unknown). */
  useDisplayName: (userId: string) => string | null;
  /**
   * Subscribe to a user's profile photo URL (null when unknown or unset → the
   * initials fallback). Reactive like {@link useDisplayName}, so a `user.updated`
   * event that refreshes the user directory repaints message avatars live.
   */
  useAvatarUrl: (userId: string) => string | null;
  /** Subscribe to the signed-in user's id. */
  useCurrentUserId: () => string | undefined;

  /* ── Non-reactive lookups ────────────────────────────────────────────────── */
  /** Resolve a mentioned user id to a display name for the in-place editor. */
  resolveMentionName: (userId: string) => string | null;

  /* ── Actions ─────────────────────────────────────────────────────────────── */
  /** Set this channel's reply target (the composer banner + optimistic quote). */
  startReply: (message: ChatMessageView) => void;
  /** Toggle my reaction on a message (optimistic; reconciles over the socket). */
  toggleReaction: (channelId: string, messageId: string, emoji: string, reactedByMe: boolean) => void;
  /** Commit an edit (PATCH); resolves on success so the row leaves edit mode. */
  editMessage: (messageId: string, content: string) => Promise<unknown>;
  /** Pin a message (REST); the authoritative flip arrives over the socket. */
  pinMessage: (channelId: string, messageId: string) => Promise<unknown>;
  /** Unpin a message (REST). */
  unpinMessage: (channelId: string, messageId: string) => Promise<unknown>;
  /** Delete a message (REST); the inbound `message.deleted` drops the row. */
  deleteMessage: (messageId: string) => Promise<unknown>;
  /** Retry a failed queued message by nonce. */
  retryOutbox: (channelId: string, nonce: string) => void;
  /** Discard a failed queued message by nonce. */
  discardOutbox: (channelId: string, nonce: string) => void;
  /** Localize a failed pin/unpin (bound to the surface's `t`). */
  pinErrorText: (err: unknown) => string;

  /* ── Slots (desktop-coupled sub-UI) ──────────────────────────────────────── */
  /** Wrap the avatar/name trigger in the profile-card popover. */
  renderProfileCard: (userId: string, children: ReactNode) => ReactNode;
  /**
   * OPTIONAL: wrap the author's NAME so it opens the same profile card and the
   * same user context menu the avatar does — a name is a handle, not
   * decoration. Separate from {@link renderProfileCard} because the
   * name sits inside a baseline-aligned text row, so the surface has to control
   * what element it wraps it in; a surface that has not wired it renders the
   * plain name and loses nothing.
   */
  renderAuthorName?: (userId: string, children: ReactNode) => ReactNode;
  /** Render a message's attachment tiles. */
  renderAttachments: (
    channelId: string,
    attachments: Attachment[],
    localUrls?: Record<AttachmentId, string>,
  ) => ReactNode;
  /** Render a message's link-preview embed cards. */
  renderEmbeds: (embeds: MessageEmbed[]) => ReactNode;
  /**
   * OPTIONAL: invite cards for invite links detected in the message TEXT (davet
   * embed kartı — the "join this server" card). Called with the
   * raw content of every confirmed message; the surface detects links itself and
   * returns null when there are none. Separate from {@link renderEmbeds} because
   * these are client-detected from content, not server-unfurled metadata.
   */
  renderInviteEmbeds?: (content: string) => ReactNode;
  /**
   * Render the reaction picker around a trigger — the full emoji picker (unicode
   * + the group's custom emoji, M17). `onOpenChange` lets the row keep the hover
   * toolbar visible while the picker is open (the JS replacement for the
   * Safari-unsupported `:has([data-state=open])` selector).
   */
  renderReactionPicker: (props: {
    onSelect: (emoji: string) => void;
    align?: "start" | "center" | "end";
    onOpenChange?: (open: boolean) => void;
    children: ReactNode;
  }) => ReactNode;
  /**
   * Render a reaction's glyph inside its count badge: a unicode emoji as text, or
   * a `:name:` custom emoji (M17) as its image. Resolved by the surface because
   * the `:name:` → image URL map is group-scoped desktop state; an unknown /
   * deleted name degrades to the literal `:name:` text.
   */
  renderReactionEmoji: (emoji: string) => ReactNode;
}

const MessageRowServicesContext = createContext<MessageRowServices | null>(null);

export interface MessageRowServicesProviderProps {
  value: MessageRowServices;
  children: ReactNode;
}

/** Make the {@link MessageRowServices} available to the rows rendered below. */
export function MessageRowServicesProvider({
  value,
  children,
}: MessageRowServicesProviderProps): ReactNode {
  return (
    <MessageRowServicesContext.Provider value={value}>
      {children}
    </MessageRowServicesContext.Provider>
  );
}

/**
 * Read the ambient {@link MessageRowServices}. Throws when no provider is above —
 * a wiring bug surfaced loudly rather than a silent half-render.
 */
export function useMessageRowServices(): MessageRowServices {
  const value = useContext(MessageRowServicesContext);
  if (value === null) {
    throw new Error(
      "useMessageRowServices() must be used within a <MessageRowServicesProvider>. Wire one " +
        "around the message list and feed it your surface's store/mutation bindings.",
    );
  }
  return value;
}

/**
 * Like {@link useMessageRowServices}, but null instead of throwing when no
 * provider is mounted. For the LIST (not a row): its optional keyboard features
 * (↑-to-edit needs the viewer id) degrade to inert on a surface that renders a
 * thread without row services, rather than taking the whole thread down.
 */
export function useOptionalMessageRowServices(): MessageRowServices | null {
  return useContext(MessageRowServicesContext);
}
