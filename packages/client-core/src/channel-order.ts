/**
 * channel-order — the pure sidebar-placement model for channel categories (M18).
 *
 * The server stores placement as a nullable `Channel.categoryId` plus a DENSE
 * `position` per bucket ("bucket" = one category, or the uncategorized top-level
 * list). `PATCH /groups/:id/channel-order` rewrites a bucket's positions from 0
 * **in the order the request lists them, over the listed ids only**.
 *
 * That last clause is the whole reason this module exists: sending only the
 * channel the user moved would renumber it to position 0 and collide with the
 * neighbours nobody touched. So every mutation here produces the COMPLETE ordered
 * id list of each bucket it changed — {@link toReorderPayload} enforces that by
 * construction, and the tests lock it in.
 *
 * WHY IT LIVES IN client-core (moved here from `@demli/app-ui`, M18 mobile
 * parity): the model is framework-free and side-effect-free, but its old home is
 * a react-dom package that React Native cannot import. Leaving it there forced
 * the mobile channel list to hand-write a second copy of "which bucket is a
 * channel in, and what does the reorder request look like" — and a second copy
 * of dense-position arithmetic drifts on the first change, silently corrupting
 * the sidebar order on ONE platform only. Same reason `member-menu.ts` and
 * `voice-channel-chat.ts` live here. `@demli/app-ui` now re-exports this
 * module, so the desktop/web sidebar keeps its imports and there is exactly one
 * implementation.
 *
 * The React sidebar renders the model and the surface posts the payload. No
 * sorting, bucketing or index math lives in a component.
 */
import type { CategoryId, Channel, ChannelCategory, ChannelId } from "@demli/types";
import type { ChannelOrderInput } from "./api-client.js";

/** Server-side cap on a category name (`1..64`, validated at the API boundary). */
export const CATEGORY_NAME_MAX_LENGTH = 64;

/**
 * One rendered sidebar bucket: a category and the channels filed under it, or
 * `category: null` for the uncategorized top-level list that every pre-M18 server
 * consists of entirely.
 */
export interface SidebarBucket {
  category: ChannelCategory | null;
  channels: Channel[];
}

/** Where a channel is moved to, relative to an existing sibling. */
export interface ChannelDropTarget {
  /** Destination bucket (`null` = uncategorized). */
  categoryId: CategoryId | null;
  /**
   * Insert BEFORE this channel. `null` appends to the end of the bucket. A
   * channel id that is not in the destination bucket also appends (a stale drop
   * target must never silently reorder something else).
   */
  beforeChannelId: ChannelId | null;
}

/**
 * Map key standing for the uncategorized bucket, which has no id of its own.
 *
 * The leading space is what makes it collision-proof: a real `categoryId` is a
 * server-issued UUID, so it can never be this string. It was a literal NUL byte
 * while this module lived in app-ui, which worked but rendered the whole source
 * file as BINARY to git — undiffable in review, and one "helpful" editor
 * clean-up away from silently becoming the empty string and colliding. Naming it
 * removes both hazards without changing a single lookup.
 */
const UNCATEGORIZED_KEY = " uncategorized";

/** The stable key of a bucket, used to compare two models. */
function bucketKey(categoryId: CategoryId | null): string {
  return categoryId ?? UNCATEGORIZED_KEY;
}

/**
 * Total order for categories: `position`, then `createdAt`, then `id`. Mirrors
 * the server's `ORDER BY position, created_at` and adds the id as a final
 * tie-break so two rows written in the same millisecond still render stably.
 */
function compareCategories(a: ChannelCategory, b: ChannelCategory): number {
  if (a.position !== b.position) return a.position - b.position;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Same total order for channels (the server sorts by `position, created_at`). */
function compareChannels(a: Channel, b: Channel): number {
  if (a.position !== b.position) return a.position - b.position;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Build the render model: the uncategorized bucket first, then every category in
 * sidebar order, each holding its channels in position order.
 *
 * A channel whose `categoryId` names a category the viewer does not have (a
 * category deleted between two fetches, or one filtered out) falls back to the
 * uncategorized bucket rather than vanishing — a channel must never become
 * unreachable because its label went missing.
 */
export function buildSidebarBuckets(
  channels: readonly Channel[],
  categories: readonly ChannelCategory[],
): SidebarBucket[] {
  const ordered = [...categories].sort(compareCategories);
  const known = new Set(ordered.map((c) => c.id));

  const buckets: SidebarBucket[] = [{ category: null, channels: [] }];
  const byId = new Map<string, SidebarBucket>();
  for (const category of ordered) {
    const bucket: SidebarBucket = { category, channels: [] };
    buckets.push(bucket);
    byId.set(category.id, bucket);
  }

  for (const channel of [...channels].sort(compareChannels)) {
    const categoryId = channel.categoryId ?? null;
    const bucket =
      categoryId !== null && known.has(categoryId) ? byId.get(categoryId) : buckets[0];
    (bucket ?? buckets[0])?.channels.push(channel);
  }

  return buckets;
}

/** Locate the bucket a channel currently sits in, or null when it is unknown. */
function findBucketOf(buckets: readonly SidebarBucket[], channelId: ChannelId): SidebarBucket | null {
  for (const bucket of buckets) {
    if (bucket.channels.some((c) => c.id === channelId)) return bucket;
  }
  return null;
}

/**
 * Move one channel to `target`, returning a NEW model (the input is untouched).
 *
 * Returns the input unchanged when the move is a no-op — an unknown channel, an
 * unknown destination, or a drop that lands exactly where the channel already is.
 * Callers rely on that: an identity result produces an empty payload, so a
 * mis-aimed drag never fires a request.
 */
export function moveChannel(
  buckets: readonly SidebarBucket[],
  channelId: ChannelId,
  target: ChannelDropTarget,
): SidebarBucket[] {
  if (target.beforeChannelId === channelId) return [...buckets];

  const source = findBucketOf(buckets, channelId);
  if (!source) return [...buckets];
  const moved = source.channels.find((c) => c.id === channelId);
  if (!moved) return [...buckets];

  const destinationKey = bucketKey(target.categoryId);
  const destination = buckets.find((b) => bucketKey(b.category?.id ?? null) === destinationKey);
  if (!destination) return [...buckets];

  // Compute the destination order WITHOUT the moved channel first, so an
  // in-bucket move measures its insertion index against its future neighbours.
  const withoutMoved = destination.channels.filter((c) => c.id !== channelId);
  const beforeIndex =
    target.beforeChannelId === null
      ? -1
      : withoutMoved.findIndex((c) => c.id === target.beforeChannelId);
  const insertAt = beforeIndex === -1 ? withoutMoved.length : beforeIndex;

  const nextDestination = [
    ...withoutMoved.slice(0, insertAt),
    { ...moved, categoryId: target.categoryId },
    ...withoutMoved.slice(insertAt),
  ];

  return buckets.map((bucket) => {
    const key = bucketKey(bucket.category?.id ?? null);
    if (key === destinationKey) return { ...bucket, channels: nextDestination };
    if (bucket === source) {
      return { ...bucket, channels: bucket.channels.filter((c) => c.id !== channelId) };
    }
    return bucket;
  });
}

/**
 * Narrow-viewport / keyboard alternative to dragging: shift a channel one slot up
 * or down INSIDE its own bucket. Cross-bucket moves are a separate, explicit
 * "move to category" action — a nudge silently teleporting a channel into another
 * category would be a surprising side effect of an arrow key.
 *
 * This is also the ONLY placement gesture on mobile: a phone has no drag-and-drop
 * sidebar, so the nudge plus "move to category" IS the touch affordance — which
 * is why these live beside the drag model rather than under a `desktop/` folder.
 *
 * Returns the input unchanged at a bucket edge, so the caller can hide (never
 * disable-and-lie about) an arrow that would do nothing.
 */
export function nudgeChannel(
  buckets: readonly SidebarBucket[],
  channelId: ChannelId,
  direction: "up" | "down",
): SidebarBucket[] {
  const bucket = findBucketOf(buckets, channelId);
  if (!bucket) return [...buckets];

  const index = bucket.channels.findIndex((c) => c.id === channelId);
  const swapWith = direction === "up" ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= bucket.channels.length) return [...buckets];

  const next = [...bucket.channels];
  const a = next[index];
  const b = next[swapWith];
  if (!a || !b) return [...buckets];
  next[index] = b;
  next[swapWith] = a;

  return buckets.map((b2) => (b2 === bucket ? { ...b2, channels: next } : b2));
}

/** True when this channel can still move `direction` inside its bucket. */
export function canNudgeChannel(
  buckets: readonly SidebarBucket[],
  channelId: ChannelId,
  direction: "up" | "down",
): boolean {
  const bucket = findBucketOf(buckets, channelId);
  if (!bucket) return false;
  const index = bucket.channels.findIndex((c) => c.id === channelId);
  return direction === "up" ? index > 0 : index >= 0 && index < bucket.channels.length - 1;
}

/**
 * The channel half of the reorder request: every bucket whose ORDER or MEMBERSHIP
 * differs between `previous` and `next`, listed in FULL and in its new order.
 *
 * Sending a partial bucket would renumber the listed channels from 0 and leave
 * the unlisted ones colliding with them, so "changed ⇒ send the whole bucket" is
 * not an optimization but the correctness rule (see the module note).
 *
 * An empty array means nothing moved — the caller must skip the request rather
 * than send a body the API rejects as empty.
 */
export function toChannelOrderEntries(
  previous: readonly SidebarBucket[],
  next: readonly SidebarBucket[],
): NonNullable<ChannelOrderInput["channels"]> {
  const previousByKey = new Map<string, string[]>();
  for (const bucket of previous) {
    previousByKey.set(
      bucketKey(bucket.category?.id ?? null),
      bucket.channels.map((c) => c.id),
    );
  }

  const entries: NonNullable<ChannelOrderInput["channels"]> = [];
  for (const bucket of next) {
    const categoryId = bucket.category?.id ?? null;
    const before = previousByKey.get(bucketKey(categoryId)) ?? [];
    const after = bucket.channels.map((c) => c.id);
    const unchanged =
      before.length === after.length && before.every((id, i) => id === after[i]);
    if (unchanged) continue;
    for (const channelId of after) entries.push({ channelId, categoryId });
  }
  return entries;
}

/**
 * Reorder the CATEGORY list itself: move `draggedId` before `beforeCategoryId`
 * (or to the end when that is null). Returns the new id order, or the input order
 * unchanged for a no-op / unknown id.
 */
export function moveCategory(
  categoryIds: readonly CategoryId[],
  draggedId: CategoryId,
  beforeCategoryId: CategoryId | null,
): CategoryId[] {
  if (draggedId === beforeCategoryId) return [...categoryIds];
  if (!categoryIds.includes(draggedId)) return [...categoryIds];

  const without = categoryIds.filter((id) => id !== draggedId);
  const beforeIndex =
    beforeCategoryId === null ? -1 : without.indexOf(beforeCategoryId);
  const insertAt = beforeIndex === -1 ? without.length : beforeIndex;
  return [...without.slice(0, insertAt), draggedId, ...without.slice(insertAt)];
}

/** Same one-slot nudge, for the category list (narrow-viewport alternative). */
export function nudgeCategory(
  categoryIds: readonly CategoryId[],
  categoryId: CategoryId,
  direction: "up" | "down",
): CategoryId[] {
  const index = categoryIds.indexOf(categoryId);
  const swapWith = direction === "up" ? index - 1 : index + 1;
  if (index === -1 || swapWith < 0 || swapWith >= categoryIds.length) return [...categoryIds];

  const next = [...categoryIds];
  const a = next[index];
  const b = next[swapWith];
  if (a === undefined || b === undefined) return [...categoryIds];
  next[index] = b;
  next[swapWith] = a;
  return next;
}

/** True when this category can still move `direction`. */
export function canNudgeCategory(
  categoryIds: readonly CategoryId[],
  categoryId: CategoryId,
  direction: "up" | "down",
): boolean {
  const index = categoryIds.indexOf(categoryId);
  if (index === -1) return false;
  return direction === "up" ? index > 0 : index < categoryIds.length - 1;
}

/**
 * Build the request body from a before/after pair of models plus the before/after
 * category order. Returns `null` when NOTHING changed, so the caller skips the
 * call — the API rejects a body with neither half.
 */
export function toReorderPayload(input: {
  previousBuckets: readonly SidebarBucket[];
  nextBuckets: readonly SidebarBucket[];
  previousCategoryIds: readonly CategoryId[];
  nextCategoryIds: readonly CategoryId[];
}): ChannelOrderInput | null {
  const channels = toChannelOrderEntries(input.previousBuckets, input.nextBuckets);
  const categoriesChanged =
    input.previousCategoryIds.length !== input.nextCategoryIds.length ||
    input.previousCategoryIds.some((id, i) => id !== input.nextCategoryIds[i]);

  if (channels.length === 0 && !categoriesChanged) return null;

  const payload: ChannelOrderInput = {};
  if (categoriesChanged) payload.categoryIds = [...input.nextCategoryIds];
  if (channels.length > 0) payload.channels = channels;
  return payload;
}

// ---------------------------------------------------------------------------
// Menu visibility — WHICH management entries a category header / channel row
// offers, decided once for both renderers (the `member-menu.ts` pattern).
// ---------------------------------------------------------------------------

/**
 * Entries a CATEGORY header's manage menu can render, in render order.
 *
 * Every one of them is refused server-side without owner ∨ MANAGE_CHANNELS
 * (`apps/api/src/modules/channel-categories`), so an unauthorized viewer gets an
 * EMPTY list rather than a menu of disabled rows — §35's "no dead controls",
 * decided here instead of in two component trees that would drift.
 *
 * Categories are pure organization: they grant no permissions and never change
 * who can see a channel (ADR 0007 keeps visibility on the channel). That is why
 * one bit gates all five entries and no category-specific bit was invented.
 */
export type CategoryMenuItem =
  | "createChannel"
  | "rename"
  | "moveUp"
  | "moveDown"
  | "delete";

export interface CategoryMenuContext {
  /** Viewer is the server owner OR holds MANAGE_CHANNELS. */
  canManageChannels: boolean;
  /** This category has a sibling above it — see {@link canNudgeCategory}. */
  canMoveUp: boolean;
  /** This category has a sibling below it — see {@link canNudgeCategory}. */
  canMoveDown: boolean;
}

/**
 * The category header's menu. Empty for a viewer who may not manage channels,
 * and the two move entries appear only when there is somewhere to move TO — a
 * "move up" on the first category is a control that does nothing.
 */
export function categoryMenuItems(ctx: CategoryMenuContext): CategoryMenuItem[] {
  if (!ctx.canManageChannels) return [];
  const items: CategoryMenuItem[] = ["createChannel", "rename"];
  if (ctx.canMoveUp) items.push("moveUp");
  if (ctx.canMoveDown) items.push("moveDown");
  items.push("delete");
  return items;
}

/** Whether a category-menu entry must render in the danger colour. */
export function isDestructiveCategoryMenuItem(item: CategoryMenuItem): boolean {
  return item === "delete";
}

/**
 * The PLACEMENT entries a channel row's context/long-press menu adds — the
 * drag-free way to reorder, and the only way at all on a touch surface.
 *
 * `moveToCategory` appears whenever there is at least one OTHER bucket to move
 * into (another category, or the uncategorized list when the channel is filed).
 * On a server with no categories at all, a channel's only bucket is the
 * uncategorized one, so the entry is correctly absent.
 */
export type ChannelPlacementMenuItem = "moveUp" | "moveDown" | "moveToCategory";

export interface ChannelPlacementMenuContext {
  /** Viewer is the server owner OR holds MANAGE_CHANNELS. */
  canManageChannels: boolean;
  /** This channel has a sibling above it in its own bucket. */
  canMoveUp: boolean;
  /** This channel has a sibling below it in its own bucket. */
  canMoveDown: boolean;
  /** There is at least one bucket other than the one this channel sits in. */
  hasOtherBuckets: boolean;
}

export function channelPlacementMenuItems(
  ctx: ChannelPlacementMenuContext,
): ChannelPlacementMenuItem[] {
  if (!ctx.canManageChannels) return [];
  const items: ChannelPlacementMenuItem[] = [];
  if (ctx.canMoveUp) items.push("moveUp");
  if (ctx.canMoveDown) items.push("moveDown");
  if (ctx.hasOtherBuckets) items.push("moveToCategory");
  return items;
}

/**
 * The buckets a channel may be moved INTO — every bucket except its current one,
 * in sidebar order, with `categoryId: null` standing for the uncategorized list.
 *
 * Returned as ids + names so a renderer can build the picker without re-deriving
 * "which one am I already in", the check most likely to be forgotten and to
 * produce a move that silently does nothing.
 */
export interface ChannelMoveDestination {
  categoryId: CategoryId | null;
  /** `null` for the uncategorized bucket — the caller supplies its own label. */
  name: string | null;
}

export function channelMoveDestinations(
  buckets: readonly SidebarBucket[],
  channelId: ChannelId,
): ChannelMoveDestination[] {
  const current = findBucketOf(buckets, channelId);
  const currentKey = bucketKey(current?.category?.id ?? null);
  const destinations: ChannelMoveDestination[] = [];
  for (const bucket of buckets) {
    const categoryId = bucket.category?.id ?? null;
    if (current && bucketKey(categoryId) === currentKey) continue;
    destinations.push({ categoryId, name: bucket.category?.name ?? null });
  }
  return destinations;
}
