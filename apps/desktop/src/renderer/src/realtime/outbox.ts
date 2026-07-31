/**
 * Desktop binding for the PERSISTENT offline send queue (M17).
 *
 * The queue itself — transitions, ordering, the 3-attempt cap, the ack deadline,
 * the drain loop — lives in `@demli/client-core/outbox` and is shared verbatim
 * with mobile. This module supplies only the three things that cannot be shared:
 *
 *  1. the TRANSPORT (the gateway socket, injected by realtime/connection.ts so
 *     this module never imports it back — no cycle);
 *  2. the STORAGE (localStorage, scoped per account);
 *  3. the PROJECTION into the renderer's chat store, joining each queued item
 *     with the non-serializable extras the row needs to paint (attachment
 *     metadata, local blob: preview URLs, the reply quote).
 *
 * WHY A SPLIT MODEL
 * `OutboxItem` is deliberately serializable — ids only. Blob URLs die on reload
 * and hydrated attachment/reply objects are re-derivable, so persisting them
 * would store garbage that outlives its meaning. They live here in a
 * module-level `meta` map instead: present for the lifetime of the send, dropped
 * (and, for blob URLs, REVOKED) the moment the item leaves the queue. After a
 * restart a restored item simply has no meta and renders as text — which is
 * correct: its local preview bytes are gone.
 */

import type { Attachment, AttachmentId, ChannelId, MessageReplyPreview } from "@demli/types";
import {
  createOutboxController,
  type OutboxItem,
  type OutboxMap,
  type OutboxStorage,
} from "@demli/client-core";
import type { UserId } from "@demli/types";
import { createOutboxStorage } from "../lib/outbox-storage";
import { useChatStore, type OutboxMessage } from "../stores/chat-store";

/** Render-only extras for one queued send, keyed by nonce. Never persisted. */
interface OutboxMeta {
  attachments?: Attachment[];
  localAttachmentUrls?: Record<AttachmentId, string>;
  replyTo?: MessageReplyPreview;
}

const meta = new Map<string, OutboxMeta>();

/**
 * The account-scoped blob, swapped by {@link attachOutbox}. Indirection (rather
 * than a storage fixed at construction) is what makes an account switch safe:
 * detaching sets this to null FIRST, so the subsequent in-memory clear cannot
 * wipe the previous account's persisted queue.
 */
let backing: OutboxStorage | null = null;

const storage: OutboxStorage = {
  get: () => backing?.get() ?? Promise.resolve(null),
  set: (value) => backing?.set(value) ?? Promise.resolve(),
  clear: () => backing?.clear() ?? Promise.resolve(),
};

/** Gateway dispatch, injected by realtime/connection.ts (avoids an import cycle). */
let transport: ((item: OutboxItem) => boolean) | null = null;

/** Called once by connection.ts at module init. */
export function setOutboxTransport(send: (item: OutboxItem) => boolean): void {
  transport = send;
}

/** Notified when queued messages are dropped because their channel is gone. */
let channelGoneListener: ((channelId: ChannelId, dropped: OutboxItem[]) => void) | null = null;

export function setOutboxChannelGoneListener(
  listener: (channelId: ChannelId, dropped: OutboxItem[]) => void,
): void {
  channelGoneListener = listener;
}

// ---------------------------------------------------------------------------
// Projection: OutboxMap (persisted shape) → the store's render shape
// ---------------------------------------------------------------------------

// Per-channel projection cache. The pure model already returns the SAME bucket
// reference for an untouched channel, so reusing our previous projection for it
// keeps the array identity stable and a channel whose queue did not change never
// re-renders its message list (§27).
let lastSource: OutboxMap = {};
let lastProjected: Record<ChannelId, OutboxMessage[]> = {};

function toOutboxMessage(item: OutboxItem): OutboxMessage {
  const extras = meta.get(item.nonce);
  return {
    nonce: item.nonce,
    channelId: item.channelId,
    authorId: item.authorId,
    content: item.content,
    createdAt: item.createdAt,
    // `queued` and `sending` are distinct on purpose: "waiting to send" (offline,
    // or waiting its turn) is a different, calmer story than "in flight".
    deliveryState: item.status,
    errorKey: item.errorKey,
    ...(extras?.attachments ? { attachments: extras.attachments } : {}),
    ...(extras?.localAttachmentUrls
      ? { localAttachmentUrls: extras.localAttachmentUrls }
      : {}),
    ...(extras?.replyTo ? { replyTo: extras.replyTo } : {}),
  };
}

function project(map: OutboxMap): Record<ChannelId, OutboxMessage[]> {
  const next: Record<ChannelId, OutboxMessage[]> = {};
  for (const [channelId, bucket] of Object.entries(map)) {
    const previousSource = lastSource[channelId];
    const previousProjection = lastProjected[channelId];
    if (previousSource === bucket && previousProjection) {
      next[channelId] = previousProjection;
      continue;
    }
    next[channelId] = bucket.map(toOutboxMessage);
  }
  lastSource = map;
  lastProjected = next;
  return next;
}

/** Drop meta for nonces that left the queue, revoking their preview blob URLs. */
function pruneMeta(map: OutboxMap): void {
  if (meta.size === 0) return;
  const live = new Set<string>();
  for (const bucket of Object.values(map)) for (const item of bucket) live.add(item.nonce);
  for (const [nonce, extras] of meta) {
    if (live.has(nonce)) continue;
    // The optimistic row owned these object URLs (handed over at send); now that
    // it is confirmed or discarded, free them (ADR 0008 render path).
    if (extras.localAttachmentUrls) {
      for (const url of Object.values(extras.localAttachmentUrls)) URL.revokeObjectURL(url);
    }
    meta.delete(nonce);
  }
}

// ---------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------

export const outbox = createOutboxController({
  send: (item) => {
    try {
      return transport?.(item) ?? false;
    } catch {
      return false;
    }
  },
  storage,
  onChannelGone: (channelId, dropped) => channelGoneListener?.(channelId, dropped),
  onChange: (map) => {
    pruneMeta(map);
    useChatStore.getState().syncOutbox(project(map));
  },
  setTimer: (cb, ms) => window.setTimeout(cb, ms) as unknown as ReturnType<typeof setTimeout>,
  clearTimer: (handle) => window.clearTimeout(handle as unknown as number),
});

/** Remember the render-only extras for a send about to be queued. */
export function rememberOutboxMeta(nonce: string, extras: OutboxMeta): void {
  if (!extras.attachments && !extras.localAttachmentUrls && !extras.replyTo) return;
  meta.set(nonce, extras);
}

/**
 * Point the queue at `userId`'s persisted blob and replay whatever survived the
 * last session. Call on sign-in and after an account switch, BEFORE the socket
 * reports online (the drain is kicked by `setOnline`, so order is not critical,
 * but hydrating first means a restored message is on screen immediately).
 */
export async function attachOutbox(userId: UserId): Promise<void> {
  backing = createOutboxStorage(userId);
  await outbox.hydrate();
}

/**
 * Detach on logout / account switch. Storage is dropped FIRST so the in-memory
 * clear cannot erase the account's persisted queue — those messages must still
 * be there when the user signs back in.
 */
export async function detachOutbox(): Promise<void> {
  backing = null;
  outbox.setOnline(false);
  await outbox.clear();
  for (const extras of meta.values()) {
    if (extras.localAttachmentUrls) {
      for (const url of Object.values(extras.localAttachmentUrls)) URL.revokeObjectURL(url);
    }
  }
  meta.clear();
  lastSource = {};
  lastProjected = {};
}
