/**
 * Composer services seam (Phase 1 step 3d, tek-kaynak UI).
 *
 * The single typed surface the shared {@link "../components/MessageComposer".MessageComposer}
 * reads its store subscriptions, drafts, typing/send actions and desktop-coupled
 * sub-pieces (the emoji picker, the attachment-preview strip) from — instead of
 * touching a Zustand store, the draft store, the realtime client or a desktop-only
 * component directly. Same design as {@link ./chat-data} / {@link ./message-row-data}:
 *   - REACTIVE members are exposed as HOOKS so the composer subscribes to exactly
 *     the store slices it needs, at the desktop original's re-render granularity (§27).
 *   - NON-reactive members are plain callbacks resolved by the surface.
 *   - The emoji picker and attachment-preview strip are composition SLOTS; the
 *     emoji slot resolves its own group context at the composer's tree position
 *     (so a DM with no custom-emoji provider simply gets no "Group" tab).
 */
import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type { Attachment, AttachmentId, MessageKind, MessageReplyPreview } from "@demli/types";

/** A directory entry the composer needs for @mention candidates. */
export interface ComposerDirectoryUser {
  id: string;
  displayName: string;
  username: string;
  /** `user.avatarUrl` — the mention picker draws the real face, not initials. */
  avatarUrl: string | null;
}

/** The active reply target for a channel (drives the banner + optimistic quote). */
export interface ComposerReplyTarget {
  messageId: string;
  authorId: string;
  content: string;
  kind: MessageKind;
}

/** The composer's read-only view of one attachment draft (submit gating). */
export interface ComposerAttachmentDraft {
  localId: string;
  status: "processing" | "uploading" | "ready" | "error";
  /** The completed metadata DTO (present once `status === "ready"`). */
  attachment?: Attachment;
  /** Local object URL for the optimistic preview; null when none. */
  previewUrl: string | null;
}

/** The per-channel attachment-draft bridge the composer reads. */
export interface ComposerAttachmentDrafts {
  drafts: ComposerAttachmentDraft[];
  /** True while any draft is still processing or uploading (blocks send). */
  hasPending: boolean;
  /** True when at least one draft exists (any status). */
  hasDrafts: boolean;
  addFiles: (files: File[]) => void;
  removeDraft: (localId: string) => void;
  retryDraft: (localId: string) => void;
  /** Drop all drafts WITHOUT cancelling — call after a successful send. */
  clearDrafts: (preserveUrls?: Set<string>) => void;
}

/** Ready attachment payload for {@link ComposerServices.sendMessage}. */
export interface ComposerSendAttachments {
  attachmentIds: AttachmentId[];
  attachments: Attachment[];
  localAttachmentUrls: Record<AttachmentId, string>;
}

/** Optional reply payload for {@link ComposerServices.sendMessage}. */
export interface ComposerReplyPayload {
  replyToMessageId: string;
  replyTo: MessageReplyPreview;
}

/**
 * Why this conversation cannot take a message right now, known BEFORE a send
 * (M16). Today: the viewer blocked the DM peer — the server would refuse the
 * send with `BLOCKED`, so the composer says so up front and offers the one
 * thing that changes it. Never "they blocked you": that is not knowable by
 * design, and a composer must not reveal it.
 */
export interface ComposerSendBlock {
  kind: "blocked";
  /** The blocked person's display name, for the notice. */
  name: string;
  /**
   * Start lifting the block. The surface routes this through its ONE unblock
   * confirmation (the same dialog the profile card and the settings list
   * open), so the composer never becomes a second, unconfirmed unblock path.
   */
  unblock: () => void;
}

/** The ambient services the shared {@link "../components/MessageComposer".MessageComposer} reads. */
export interface ComposerServices {
  /* ── Reactive (hooks — called during the composer's render) ───────────────── */
  /** Subscribe to the signed-in user's id (excluded from @mention candidates). */
  useMeId: () => string | undefined;
  /** Subscribe to the users directory (the @mention candidate source). */
  useUsers: () => Record<string, ComposerDirectoryUser>;
  /** Subscribe to a channel's reply target (drives the banner). */
  useReplyTarget: (channelId: string) => ComposerReplyTarget | undefined;
  /** Subscribe to the reply target author's name as a PRIMITIVE (repaints only the banner name). */
  useReplyAuthorName: (channelId: string) => string | null;
  /** Subscribe to whether `@everyone`/`@here` may be offered on this surface. */
  useAllowBroadcast: () => boolean;
  /** Subscribe to whether attachments are globally disabled. */
  useAttachmentsDisabled: () => boolean;
  /** Subscribe to a channel's attachment drafts + upload lifecycle. */
  useAttachmentDrafts: (channelId: string) => ComposerAttachmentDrafts;
  /** Subscribe to a channel's active slow-mode cooldown deadline (ms epoch, 0 = none). */
  useSlowmodeCooldownUntil: (channelId: string) => number;
  /**
   * OPTIONAL: subscribe to a reason this conversation cannot take a message
   * (the viewer blocked the DM peer). Null / absent = the composer is open.
   */
  useSendBlock?: (channelId: string) => ComposerSendBlock | null;

  /* ── Imperative reads / writes ────────────────────────────────────────────── */
  /** Read a channel's reply target at send time (never a subscription). */
  getReplyTarget: (channelId: string) => ComposerReplyTarget | undefined;
  /** Clear a channel's reply target. */
  clearReplyTarget: (channelId: string) => void;
  /** Clear a channel's elapsed slow-mode cooldown entry. */
  clearSlowmodeCooldown: (channelId: string) => void;
  /** Read a channel's saved draft text (initial seed). */
  getDraft: (channelId: string) => string;
  /** Persist a channel's draft text (debounced store-side). */
  setDraft: (channelId: string, text: string) => void;
  /** Drop a channel's draft (after a successful send). */
  clearDraft: (channelId: string) => void;
  /** Flush the debounced draft persist (on channel switch). */
  flushDrafts: () => void;
  /** Announce typing on a channel. */
  notifyTyping: (channelId: string) => void;
  /** Announce idle on a channel. */
  notifyIdle: (channelId: string) => void;
  /** Optimistically append + send a message over the gateway. */
  sendMessage: (
    channelId: string,
    text: string,
    media?: ComposerSendAttachments,
    reply?: ComposerReplyPayload,
  ) => void;
  /** The file-input `accept` string for the attachment picker. */
  attachmentAccept: string;

  /* ── Slots (desktop-coupled sub-UI) ──────────────────────────────────────── */
  /**
   * Render the emoji picker around a trigger. `onSelect` receives either a
   * unicode glyph or a `:name:` shortcode — inserted verbatim. The slot resolves
   * its own group context at render position.
   */
  renderEmojiPicker: (props: {
    onSelect: (text: string) => void;
    align?: "start" | "center" | "end";
    side?: "top" | "bottom" | "left" | "right";
    children: ReactNode;
  }) => ReactNode;
  /** Render the pending-attachment preview strip. */
  renderAttachmentPreview: (props: {
    drafts: ComposerAttachmentDraft[];
    onRemove: (localId: string) => void;
    onRetry: (localId: string) => void;
  }) => ReactNode;
}

const ComposerServicesContext = createContext<ComposerServices | null>(null);

export interface ComposerServicesProviderProps {
  value: ComposerServices;
  children: ReactNode;
}

/** Make the {@link ComposerServices} available to the composer rendered below. */
export function ComposerServicesProvider({
  value,
  children,
}: ComposerServicesProviderProps): ReactNode {
  return (
    <ComposerServicesContext.Provider value={value}>{children}</ComposerServicesContext.Provider>
  );
}

/**
 * Read the ambient {@link ComposerServices}. Throws when no provider is above —
 * a wiring bug surfaced loudly rather than a silent half-render.
 */
export function useComposerServices(): ComposerServices {
  const value = useContext(ComposerServicesContext);
  if (value === null) {
    throw new Error(
      "useComposerServices() must be used within a <ComposerServicesProvider>. Wire one around " +
        "the composer and feed it your surface's store/draft/realtime bindings.",
    );
  }
  return value;
}
