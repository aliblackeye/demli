/**
 * Mobile binding for the PERSISTENT offline send queue (M17) — the twin of the
 * desktop renderer's realtime/outbox.ts.
 *
 * The queue itself — transitions, ordering, the 3-attempt cap, the ack deadline,
 * the drain loop — lives in `@demli/client-core/outbox` and is shared verbatim
 * with desktop. This module supplies only the three platform-specific things:
 *
 *  1. the TRANSPORT (the gateway socket, injected by realtime/connection.ts so
 *     this module never imports it back — no cycle);
 *  2. the STORAGE (an expo-file-system JSON file, scoped per account);
 *  3. the PROJECTION into the chat store, joining each queued item with the
 *     non-serializable extras the row needs to paint (attachment metadata, the
 *     reply quote).
 *
 * WHY A SPLIT MODEL
 * `OutboxItem` is deliberately serializable — ids only. Hydrated attachment and
 * reply objects are re-derivable, so persisting them would store stale
 * duplicates of query data. They live here in a module-level `meta` map instead:
 * present for the lifetime of the send, dropped the moment the item leaves the
 * queue. After a restart a restored item has no meta and renders as text — which
 * is correct, its local preview state is gone.
 */

import type { Attachment, ChannelId, MessageReplyPreview, UserId } from "@demli/types";
import {
  createOutboxController,
  type OutboxItem,
  type OutboxMap,
  type OutboxStorage,
} from "@demli/client-core";
import { createOutboxStorage } from "../lib/outbox-storage";
import { useChatStore, type OutboxMessage } from "../stores/chat-store";

/** Render-only extras for one queued send, keyed by nonce. Never persisted. */
interface OutboxMeta {
  attachments?: Attachment[];
  replyTo?: MessageReplyPreview;
}

const meta = new Map<string, OutboxMeta>();

/**
 * The account-scoped file, swapped by {@link attachOutbox}. Indirection (rather
 * than a storage fixed at construction) is what makes an account switch safe:
 * detaching sets this to null FIRST, so the subsequent in-memory clear cannot
 * delete the previous account's persisted queue.
 */
let backing: OutboxStorage | null = null;

const storage: OutboxStorage = {
  get: () => backing?.get() ?? Promise.resolve(null),
  set: (value) => backing?.set(value) ?? Promise.resolve(),
  clear: () => backing?.clear() ?? Promise.resolve(),
};

/** Gateway dispatch, injected by realtime/connection.ts (avoids an import cycle). */
let transport: ((item: OutboxItem) => boolean) | null = null;

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
// keeps array identity stable and a thread whose queue did not change never
// re-renders (§27).
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
    ...(item.replyToMessageId ? { replyToMessageId: item.replyToMessageId } : {}),
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

/** Drop meta for nonces that have left the queue. */
function pruneMeta(map: OutboxMap): void {
  if (meta.size === 0) return;
  const live = new Set<string>();
  for (const bucket of Object.values(map)) for (const item of bucket) live.add(item.nonce);
  for (const nonce of [...meta.keys()]) {
    if (!live.has(nonce)) meta.delete(nonce);
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
});

/** Remember the render-only extras for a send about to be queued. */
export function rememberOutboxMeta(nonce: string, extras: OutboxMeta): void {
  if (!extras.attachments && !extras.replyTo) return;
  meta.set(nonce, extras);
}

/**
 * Point the queue at `userId`'s persisted file and replay whatever survived the
 * last session. Call on sign-in and after an account switch.
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
  meta.clear();
  lastSource = {};
  lastProjected = {};
}
