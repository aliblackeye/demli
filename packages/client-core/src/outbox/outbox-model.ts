/**
 * Persistent offline send queue — the PURE model (M17).
 *
 * This file is a pure reducer + selectors: no I/O, no timers, no socket, no
 * storage. The controller drives it and owns every side effect, exactly like
 * `dm-calls/call-state.ts` drives `call-controller.ts`. Keeping the transitions
 * pure is what makes the acceptance criteria (offline → online ordering, dedupe,
 * the 3-attempt cap) trivially unit-testable.
 *
 * WHY THIS IS SAFE TO REPLAY
 * Every queued item keeps the nonce it was created with, forever. The gateway's
 * insert is `ON CONFLICT (author_id, nonce) DO NOTHING` against a partial unique
 * index, so re-sending an item whose `message.created` echo was lost resolves to
 * the ORIGINAL row instead of inserting a duplicate. That server-side dedupe is
 * the entire reason a persistent queue is possible at all — note that it exists
 * only on the GATEWAY path; the REST send carries no nonce, so the queue must
 * never drain over HTTP.
 *
 * ORDERING
 * Exactly one item is in flight at a time, and {@link nextSendable} always picks
 * the globally oldest `queued` item. That is what makes "messages typed offline
 * arrive in the order they were typed" a property of the model rather than a
 * hopeful consequence of network timing — a parallel drain would let a short
 * message overtake a long one.
 *
 * Every reducer returns the SAME REFERENCE when nothing changed, so a store
 * bound to it can skip the notify (the `call-state.ts` convention).
 */

import type { AttachmentId, ChannelId, MessageId, UserId } from "@demli/types";

/**
 * How many send attempts an item gets before it stops retrying by itself.
 *
 * Bounded on purpose: an item that fails three times is failing for a reason the
 * queue cannot fix (rejected content, lost permission, a server bug), and an
 * unbounded retry would hammer the gateway forever and keep the user's message in
 * a permanently ambiguous state. After the cap it sits in `failed` with a Retry
 * affordance — the user decides, not the loop.
 */
export const OUTBOX_MAX_ATTEMPTS = 3;

/**
 * Upper bound on persisted items. A queue this long means something is very
 * wrong (weeks offline, or a drain bug); persisting without a cap would let the
 * stored blob grow without limit. Oldest items are dropped first.
 */
export const OUTBOX_MAX_ITEMS = 200;

/**
 * - `queued`  — waiting for a live connection, or waiting its turn. The resting
 *   state while offline.
 * - `sending` — dispatched to the gateway, awaiting the `message.created` echo.
 *   At most ONE item is in this state at a time.
 * - `failed`  — out of attempts, or rejected in a way retrying cannot fix. Only a
 *   user action (retry / discard) leaves this state.
 */
export type OutboxStatus = "queued" | "sending" | "failed";

/**
 * Why an item is not progressing. A KEY, never a message — the UI localizes it at
 * render (§26 and the house `DraftError` convention), which is what fixes the
 * current hard-coded English "You're offline. Reconnect and retry." string.
 */
export type OutboxErrorKey =
  /** No live socket. Transient: the drain retries automatically on reconnect. */
  | "offline"
  /** Dispatched but never echoed within the ack deadline. */
  | "timeout"
  /** The gateway rejected it (`error.raised`). */
  | "rejected"
  /** The channel was deleted, or the user lost access to it. Terminal. */
  | "channel_gone"
  /** Out of attempts. Terminal until the user retries. */
  | "attempts_exhausted";

/**
 * One queued send. Deliberately a SERIALIZABLE subset of the platform outbox
 * entry: no blob URLs (they die on reload), no hydrated author/attachment
 * objects, no reply preview — only the ids needed to re-dispatch. The rendering
 * layer joins the rest from its own caches.
 */
export interface OutboxItem {
  /** Idempotency key. Stable across every retry — see the header. */
  nonce: string;
  channelId: ChannelId;
  authorId: UserId;
  content: string;
  /** ISO instant the user pressed send. The FIFO ordering key. */
  createdAt: string;
  status: OutboxStatus;
  /** Completed dispatch attempts. Compared against {@link OUTBOX_MAX_ATTEMPTS}. */
  attempts: number;
  errorKey: OutboxErrorKey | null;
  /** Ids only — already uploaded and `ready` before the send was queued. */
  attachmentIds?: AttachmentId[];
  replyToMessageId?: MessageId;
}

/** The queue, bucketed by channel for cheap per-channel rendering. */
export type OutboxMap = Record<ChannelId, OutboxItem[]>;

export const emptyOutbox: OutboxMap = {};

/** Replace one channel's bucket, dropping the key entirely when it empties. */
function withBucket(map: OutboxMap, channelId: ChannelId, items: OutboxItem[]): OutboxMap {
  if (items.length === 0) {
    if (!(channelId in map)) return map;
    const next = { ...map };
    delete next[channelId];
    return next;
  }
  return { ...map, [channelId]: items };
}

/**
 * Apply `patch` to one item. Returns the SAME map reference when the nonce is
 * absent or the patch is a no-op, so a no-op transition never notifies.
 */
function patchItem(
  map: OutboxMap,
  channelId: ChannelId,
  nonce: string,
  patch: (item: OutboxItem) => OutboxItem,
): OutboxMap {
  const bucket = map[channelId];
  if (!bucket) return map;
  const index = bucket.findIndex((item) => item.nonce === nonce);
  if (index === -1) return map;
  const current = bucket[index]!;
  const updated = patch(current);
  if (updated === current) return map;
  const items = [...bucket];
  items[index] = updated;
  return { ...map, [channelId]: items };
}

/**
 * Add a new send to the queue.
 *
 * DEDUPE: a nonce already present is ignored and the map is returned unchanged.
 * This is the client-side half of the idempotency story — it makes a double-tap
 * on Send, or a hydration racing a fresh send, a no-op rather than two rows.
 */
export function enqueueItem(map: OutboxMap, item: OutboxItem): OutboxMap {
  if (findItem(map, item.channelId, item.nonce)) return map;
  const bucket = map[item.channelId] ?? [];
  const next = withBucket(map, item.channelId, [...bucket, item]);
  return enforceItemCap(next);
}

/**
 * Mark an item dispatched and COUNT THE ATTEMPT.
 *
 * The attempt is counted at dispatch, not at failure, on purpose: a send whose
 * outcome is never observed (socket dies mid-flight, app killed) has still
 * consumed a try. Counting on failure instead would let an item that always dies
 * silently retry forever, which is exactly the unbounded loop the cap exists to
 * prevent.
 */
export function markSending(map: OutboxMap, channelId: ChannelId, nonce: string): OutboxMap {
  return patchItem(map, channelId, nonce, (item) =>
    item.status === "sending"
      ? item
      : { ...item, status: "sending", attempts: item.attempts + 1, errorKey: null },
  );
}

/**
 * Record a failed attempt.
 *
 * `channel_gone` is terminal regardless of attempts — retrying a send into a
 * channel that no longer exists (or that the user was removed from) can only fail
 * again, so it goes straight to `failed` and the controller surfaces it. Every
 * other cause returns to `queued` while attempts remain, and lands in `failed`
 * with `attempts_exhausted` once they do not.
 */
export function markAttemptFailed(
  map: OutboxMap,
  channelId: ChannelId,
  nonce: string,
  errorKey: OutboxErrorKey,
): OutboxMap {
  return patchItem(map, channelId, nonce, (item) => {
    if (errorKey === "channel_gone") {
      return { ...item, status: "failed", errorKey };
    }
    if (item.attempts >= OUTBOX_MAX_ATTEMPTS) {
      return { ...item, status: "failed", errorKey: "attempts_exhausted" };
    }
    return { ...item, status: "queued", errorKey };
  });
}

/**
 * User pressed Retry: back to `queued` with the attempt budget RESET.
 *
 * Resetting is the point — the cap exists to stop an automatic loop, not to
 * permanently retire a message. An explicit human retry is new information
 * ("I reconnected", "I fixed it"), so it earns a fresh budget.
 */
export function retryItem(map: OutboxMap, channelId: ChannelId, nonce: string): OutboxMap {
  return patchItem(map, channelId, nonce, (item) =>
    item.status === "failed" ? { ...item, status: "queued", attempts: 0, errorKey: null } : item,
  );
}

/** Remove one item — the confirmed-send path and the user's Discard action. */
export function removeItem(map: OutboxMap, channelId: ChannelId, nonce: string): OutboxMap {
  const bucket = map[channelId];
  if (!bucket) return map;
  const items = bucket.filter((item) => item.nonce !== nonce);
  if (items.length === bucket.length) return map;
  return withBucket(map, channelId, items);
}

/**
 * Drop an entire channel's queue — the channel was deleted or access was lost.
 * Returns the removed items so the controller can tell the user which messages
 * will never be delivered rather than silently vanishing them.
 */
export function removeChannel(
  map: OutboxMap,
  channelId: ChannelId,
): { map: OutboxMap; removed: OutboxItem[] } {
  const bucket = map[channelId];
  if (!bucket || bucket.length === 0) return { map, removed: [] };
  return { map: withBucket(map, channelId, []), removed: bucket };
}

/**
 * Re-queue anything left `sending`. Called on hydration and whenever the socket
 * drops: an item dispatched but never echoed is in an UNKNOWN state, and the only
 * safe reading is "not confirmed, try again" — which is safe precisely because
 * the nonce makes the replay idempotent server-side. Attempts are NOT reset, so a
 * message that keeps dying mid-flight still walks into the cap.
 */
export function requeueInFlight(map: OutboxMap): OutboxMap {
  let changed = false;
  const next: OutboxMap = {};
  for (const [channelId, bucket] of Object.entries(map)) {
    const items = bucket.map((item) => {
      if (item.status !== "sending") return item;
      changed = true;
      const exhausted = item.attempts >= OUTBOX_MAX_ATTEMPTS;
      return {
        ...item,
        status: exhausted ? ("failed" as const) : ("queued" as const),
        errorKey: exhausted ? ("attempts_exhausted" as const) : item.errorKey,
      };
    });
    next[channelId] = items;
  }
  return changed ? next : map;
}

/** The item for `nonce` in `channelId`, or undefined. */
export function findItem(
  map: OutboxMap,
  channelId: ChannelId,
  nonce: string,
): OutboxItem | undefined {
  return map[channelId]?.find((item) => item.nonce === nonce);
}

/** Every item across all channels, oldest first. */
export function allItems(map: OutboxMap): OutboxItem[] {
  return Object.values(map)
    .flat()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * The next item to dispatch, or null.
 *
 * Returns null while ANY item is `sending`: the queue drains strictly one at a
 * time so ordering is guaranteed (see the header). Otherwise it is the globally
 * oldest `queued` item — global, not per-channel, so two channels typed offline
 * still deliver in the order the user typed them.
 */
export function nextSendable(map: OutboxMap): OutboxItem | null {
  let oldest: OutboxItem | null = null;
  for (const bucket of Object.values(map)) {
    for (const item of bucket) {
      if (item.status === "sending") return null;
      if (item.status !== "queued") continue;
      if (!oldest || item.createdAt.localeCompare(oldest.createdAt) < 0) oldest = item;
    }
  }
  return oldest;
}

/** How many items are waiting or in flight (not `failed`) — the "N queued" badge. */
export function pendingCount(map: OutboxMap): number {
  let count = 0;
  for (const bucket of Object.values(map)) {
    for (const item of bucket) if (item.status !== "failed") count += 1;
  }
  return count;
}

/** True when `channelId` holds at least one `failed` item (sidebar indicator). */
export function channelHasFailed(map: OutboxMap, channelId: ChannelId): boolean {
  return (map[channelId] ?? []).some((item) => item.status === "failed");
}

/** Drop the oldest items once the queue exceeds {@link OUTBOX_MAX_ITEMS}. */
function enforceItemCap(map: OutboxMap): OutboxMap {
  const items = allItems(map);
  if (items.length <= OUTBOX_MAX_ITEMS) return map;
  const doomed = new Set(items.slice(0, items.length - OUTBOX_MAX_ITEMS).map((i) => i.nonce));
  const next: OutboxMap = {};
  for (const [channelId, bucket] of Object.entries(map)) {
    const kept = bucket.filter((item) => !doomed.has(item.nonce));
    if (kept.length > 0) next[channelId] = kept;
  }
  return next;
}

const STATUSES: readonly OutboxStatus[] = ["queued", "sending", "failed"];
const ERROR_KEYS: readonly OutboxErrorKey[] = [
  "offline",
  "timeout",
  "rejected",
  "channel_gone",
  "attempts_exhausted",
];

/** Narrow one persisted entry, or null when it is unusable. */
function sanitizeItem(raw: unknown): OutboxItem | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const { nonce, channelId, authorId, content, createdAt } = r;
  if (
    typeof nonce !== "string" ||
    nonce.length === 0 ||
    typeof channelId !== "string" ||
    channelId.length === 0 ||
    typeof authorId !== "string" ||
    typeof content !== "string" ||
    typeof createdAt !== "string"
  ) {
    return null;
  }

  const attempts =
    typeof r["attempts"] === "number" && Number.isFinite(r["attempts"])
      ? Math.max(0, Math.min(OUTBOX_MAX_ATTEMPTS, Math.floor(r["attempts"])))
      : 0;
  const status = STATUSES.includes(r["status"] as OutboxStatus)
    ? (r["status"] as OutboxStatus)
    : "queued";
  const errorKey = ERROR_KEYS.includes(r["errorKey"] as OutboxErrorKey)
    ? (r["errorKey"] as OutboxErrorKey)
    : null;
  const attachmentIds = Array.isArray(r["attachmentIds"])
    ? r["attachmentIds"].filter((v): v is string => typeof v === "string")
    : undefined;
  const replyToMessageId =
    typeof r["replyToMessageId"] === "string" ? r["replyToMessageId"] : undefined;

  // An entry with neither text nor attachments could never be accepted by the
  // server, so it would retry into the cap and then sit as a permanent failure.
  if (content.trim().length === 0 && (attachmentIds?.length ?? 0) === 0) return null;

  return {
    nonce,
    channelId,
    authorId,
    content,
    createdAt,
    status,
    attempts,
    errorKey,
    ...(attachmentIds && attachmentIds.length > 0 ? { attachmentIds } : {}),
    ...(replyToMessageId ? { replyToMessageId } : {}),
  };
}

/**
 * Rebuild a queue from persisted JSON, tolerating anything.
 *
 * Hydration is the one place the model meets untrusted input: the blob was
 * written by an older app version, may be truncated, or hand-edited. Every
 * malformed entry is DROPPED rather than throwing, because a corrupt queue must
 * never be able to stop the app from starting.
 *
 * Also re-queues in-flight items ({@link requeueInFlight}) — a `sending` entry in
 * a persisted blob means the app died mid-send, and that item was never confirmed.
 * Duplicate nonces are collapsed, keeping the first.
 */
export function sanitizeOutboxMap(raw: unknown): OutboxMap {
  if (typeof raw !== "object" || raw === null) return emptyOutbox;

  const seen = new Set<string>();
  const map: OutboxMap = {};
  for (const [channelId, bucket] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof channelId !== "string" || channelId.length === 0) continue;
    if (!Array.isArray(bucket)) continue;

    const items: OutboxItem[] = [];
    for (const entry of bucket) {
      const item = sanitizeItem(entry);
      if (!item) continue;
      // Trust the KEY over the entry's own channelId — the bucket is where the
      // renderer will look for it.
      if (item.channelId !== channelId) continue;
      if (seen.has(item.nonce)) continue;
      seen.add(item.nonce);
      items.push(item);
    }
    if (items.length > 0) {
      items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      map[channelId] = items;
    }
  }
  return enforceItemCap(requeueInFlight(map));
}
