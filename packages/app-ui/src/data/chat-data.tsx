/**
 * Chat data contract (Phase 1 step 3, tek-kaynak UI).
 *
 * The single typed seam the shared message-center components read their data +
 * actions from, instead of touching a Zustand store, a TanStack Query hook or a
 * module emitter directly. Same design as {@link ./shell-data}:
 *   - CONSUMER-DRIVEN and PRE-DERIVED: only the fields the moved components
 *     actually consume live here, and anything platform-coupled (the message
 *     assembly from query pages + the optimistic outbox, read-marker access,
 *     error localization, the jump emitter) is resolved by the surface and
 *     handed over as plain data or a stable callback. The shared components stay
 *     presentational, so their output matches the desktop originals byte-for-byte.
 *   - The desktop maps its chat-store / queries into this shape once, per open
 *     channel, via a <ChatDataProvider> (see the desktop ChatDataProvider).
 *   - The mutation/desktop-coupled ROW itself (edit/delete/pin/react/attachments/
 *     profile card) is NOT data — it is a composition slot: `renderMessage`. The
 *     desktop passes its <MessageRow>; web (Phase 4) supplies its own.
 *
 * This starts list-focused (what MessageList needs). It grows — reply target,
 * send/edit/delete, slowmode — as the composer/row move into the shared layer.
 */
import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type { AttachmentId, Channel, Message } from "@demli/types";
import type { OutboxErrorKey } from "@demli/client-core";

/**
 * `queued` is the persistent-queue state (M17): typed while offline, waiting for
 * a connection or its turn in the drain, surviving an app restart. `sending`
 * means dispatched and awaiting the `message.created` echo.
 */
export type ChatDeliveryState = "queued" | "sending" | "sent" | "failed";

/**
 * Renderer view of a message: a confirmed server Message, or a queued/optimistic
 * outbox entry awaiting its `message.created` echo. Mirrors the desktop
 * `ChatMessage` (which now re-exports this) so one message shape flows through
 * the shared list and back into the surface's row renderer.
 */
export interface ChatMessageView extends Message {
  deliveryState: ChatDeliveryState;
  /** Why the send is stuck, as a catalog KEY — localized at render (ADR 0009). */
  errorKey: OutboxErrorKey | null;
  /** Present on optimistic messages — the retry/discard key. */
  nonce: string | null;
  /**
   * Optimistic-only: local object URLs (attachmentId → blob: URL) so a
   * still-sending message renders its own just-uploaded bytes without fetching a
   * signed URL. Absent on confirmed messages (they use the signed-URL layer).
   */
  localAttachmentUrls?: Record<AttachmentId, string>;
  /**
   * List identity when it differs from `id`: a confirmed message that replaced
   * one of the viewer's optimistic sends keeps that row's key, so the row is
   * updated in place instead of remounting (and replaying its arrival motion).
   */
  renderKey?: string;
}

/**
 * Header controls for the shared server-channel {@link "../components/ChatView".ChatView}.
 * Only the server-channel surface renders that header, so this is OPTIONAL on the
 * data contract — the flat-group-chat and DM surfaces carry their own header and
 * leave it undefined. Booleans are pre-derived; actions are stable callbacks (the
 * surface memoizes the object so a search/member toggle repaints only the header
 * chrome, never a message re-render storm — §27).
 */
export interface ChatHeaderControls {
  /** The channel-search panel is open (search toggle is pressed). */
  searchOpen: boolean;
  /** Toggle the channel-search panel (mirrors the Ctrl/Cmd+F shortcut). */
  toggleSearch: () => void;
  /** Open the server invite dialog. */
  openInvite: () => void;
  /** The member roster column is visible (members toggle is pressed). */
  memberSidebarOpen: boolean;
  /** Toggle the member roster column. */
  toggleMemberSidebar: () => void;
}

/**
 * Per-row context the shared list hands to the surface's row renderer. Everything
 * the list itself computes (grouping, flash-highlight, arrival freshness, the
 * reply-jump handler); the surface's `renderMessage` closure adds its own
 * surface data (author color, profile group, permission) around it.
 */
export interface ChatMessageRowContext {
  message: ChatMessageView;
  /** Compact row — same author within the grouping window, avatar hidden. */
  isContinuation: boolean;
  /** This row is the flash target of a reply-preview / pin jump. */
  isHighlighted: boolean;
  /** This message landed moments ago → play the "arrival" motion (data-derived). */
  isArriving: boolean;
  /** Scroll to (and briefly flash) the quoted message id. */
  onJumpToMessage: (messageId: string) => void;
}

/**
 * What the empty thread's opening reads as. A DM and a flat group chat run on a
 * hidden stream channel named after the peer / group, so the channel intro
 * ("#Can kanalına hoş geldin") would be wrong there — they say who it is with.
 */
export type ChatIntro =
  | { kind: "channel" }
  | {
      kind: "dm";
      /** The other person: their avatar and name open the conversation. */
      peer: { id: string; displayName: string; avatarUrl: string | null };
    }
  | { kind: "groupChat"; groupId: string; name: string };

/** The full ambient data the shared message center reads. */
export interface ChatData {
  /** The open channel (its name seeds the empty-channel intro). */
  channel: Channel;
  /** How the start of the thread introduces itself. Omitted → the channel intro. */
  intro?: ChatIntro;
  /** Messages oldest→newest, deduped, with optimistic sends appended (pre-derived). */
  messages: ChatMessageView[];
  /** An older page is available to fetch (drives load-on-scroll-up + jump paging). */
  hasMore: boolean;
  /** An older page is currently being fetched. */
  isLoadingMore: boolean;
  /** The first page has not resolved yet (drives the skeleton). */
  isPending: boolean;
  /** Localized error message for the first-page load, else null. */
  errorMessage: string | null;

  /** Fetch the next (older) page; resolves when it has settled (jump paging awaits it). */
  loadMore: () => Promise<unknown>;
  /** Retry the first-page load after an error. */
  retry: () => void;
  /**
   * The persisted read watermark for this channel, read IMPERATIVELY (never a
   * subscription) so the frozen unread-divider anchor never re-renders the list
   * on a watermark change (§27).
   */
  getReadWatermark: () => string | null;
  /**
   * Subscribe the mounted list to external "scroll to this message" commands (the
   * pin board today; search / deep links later). Returns the unsubscribe fn.
   */
  subscribeJump: (listener: (messageId: string) => void) => () => void;
  /** Render one message row — the surface supplies its mutation-coupled row. */
  renderMessage: (row: ChatMessageRowContext) => ReactNode;

  /**
   * Authors the viewer is ignoring (ADR 0019 §4). Their messages are delivered
   * and stored exactly as before — an ignore hides NOTHING server-side, unlike a
   * block — so the list folds consecutive runs of them behind an expandable
   * placeholder instead. Omit (or pass an empty set) on a surface with no ignore
   * data; the list then renders every row normally.
   *
   * Must be a STABLE reference (memoize it in the surface) — it is a dependency
   * of the row-model memo that feeds the virtualizer.
   */
  ignoredAuthorIds?: ReadonlySet<string>;

  /**
   * Header controls for the shared server-channel {@link "../components/ChatView".ChatView}.
   * Present ONLY on the server-channel surface; the flat-group-chat / DM surfaces
   * render their own header and leave this undefined.
   */
  header?: ChatHeaderControls;
}

const ChatDataContext = createContext<ChatData | null>(null);

export interface ChatDataProviderProps {
  /** The surface's assembled chat data (desktop maps its store/queries into it). */
  value: ChatData;
  children: ReactNode;
}

/** Makes the {@link ChatData} available to the shared message-center components below it. */
export function ChatDataProvider({ value, children }: ChatDataProviderProps): ReactNode {
  return <ChatDataContext.Provider value={value}>{children}</ChatDataContext.Provider>;
}

/**
 * Read the ambient {@link ChatData}. Throws when no {@link ChatDataProvider} is
 * above it — a wiring bug surfaced loudly rather than a silent half-render.
 */
export function useChatData(): ChatData {
  const value = useContext(ChatDataContext);
  if (value === null) {
    throw new Error(
      "useChatData() must be used within a <ChatDataProvider>. Wire one around the message " +
        "center and feed it your surface's messages/paging/read-marker state.",
    );
  }
  return value;
}
