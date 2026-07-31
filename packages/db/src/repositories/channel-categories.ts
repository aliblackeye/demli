import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { CategoryId, ChannelCategory, ChannelId, GroupId } from "@demli/types";
import type { Db } from "../client.js";
import { toChannelCategory } from "../mappers.js";
import { channelCategories, channels } from "../schema.js";

/**
 * Channel categories (M18) — the sidebar grouping layer for SERVERS.
 *
 * Categories are purely organizational: they hold no permissions and never affect
 * channel visibility (that stays the M9 `channel_role_access` model, ADR 0007).
 * Membership is the nullable `channels.category_id`, so a channel with none keeps
 * its pre-M18 top-level placement.
 *
 * Ordering is a dense `position` per scope, rewritten wholesale by the reorder
 * primitives. Both reorders run in ONE transaction so the sidebar can never be
 * observed half-reordered.
 */
export function channelCategoriesRepo(db: Db) {
  return {
    /** Append a category to the end of the server's category list. */
    async create(input: { groupId: GroupId; name: string }): Promise<ChannelCategory> {
      return db.transaction(async (tx) => {
        const [top] = await tx
          .select({ position: channelCategories.position })
          .from(channelCategories)
          .where(eq(channelCategories.groupId, input.groupId))
          .orderBy(desc(channelCategories.position))
          .limit(1);
        const [row] = await tx
          .insert(channelCategories)
          .values({
            groupId: input.groupId,
            name: input.name,
            position: (top?.position ?? -1) + 1,
          })
          .returning();
        if (!row) throw new Error("insert channel_categories returned no row");
        return toChannelCategory(row);
      });
    },

    async findById(categoryId: CategoryId): Promise<ChannelCategory | null> {
      const [row] = await db
        .select()
        .from(channelCategories)
        .where(eq(channelCategories.id, categoryId))
        .limit(1);
      return row ? toChannelCategory(row) : null;
    },

    /** A server's categories in sidebar order (position, then creation for ties). */
    async listForGroup(groupId: GroupId): Promise<ChannelCategory[]> {
      const rows = await db
        .select()
        .from(channelCategories)
        .where(eq(channelCategories.groupId, groupId))
        .orderBy(asc(channelCategories.position), asc(channelCategories.createdAt));
      return rows.map(toChannelCategory);
    },

    /** Rename a category. Returns null when it no longer exists. */
    async rename(categoryId: CategoryId, name: string): Promise<ChannelCategory | null> {
      const [row] = await db
        .update(channelCategories)
        .set({ name })
        .where(eq(channelCategories.id, categoryId))
        .returning();
      return row ? toChannelCategory(row) : null;
    },

    /**
     * Delete a category. Its channels are NOT deleted — the FK is ON DELETE SET
     * NULL, so they fall back to uncategorized and reappear in the top-level list
     * Returns true when a row was removed.
     */
    async delete(categoryId: CategoryId): Promise<boolean> {
      const rows = await db
        .delete(channelCategories)
        .where(eq(channelCategories.id, categoryId))
        .returning({ id: channelCategories.id });
      return rows.length > 0;
    },

    /**
     * Rewrite the ORDER of a server's categories from an explicit id list, in one
     * transaction. `orderedIds` must be exactly the ids the caller wants ordered;
     * ids not belonging to `groupId` are IGNORED (the API validates and rejects
     * them first — this is the second line of defence, so a stale client can
     * never reposition another server's rows). Any category omitted from the list
     * keeps a position AFTER the listed ones, ordered as before.
     */
    async reorderCategories(groupId: GroupId, orderedIds: CategoryId[]): Promise<void> {
      await db.transaction(async (tx) => {
        const existing = await tx
          .select({ id: channelCategories.id })
          .from(channelCategories)
          .where(eq(channelCategories.groupId, groupId))
          .orderBy(asc(channelCategories.position), asc(channelCategories.createdAt));
        const valid = new Set(existing.map((r) => r.id));

        const seen = new Set<CategoryId>();
        const ordered: CategoryId[] = [];
        for (const id of orderedIds) {
          if (!valid.has(id) || seen.has(id)) continue;
          seen.add(id);
          ordered.push(id);
        }
        // Anything the client did not mention keeps its relative order, appended.
        for (const row of existing) {
          if (!seen.has(row.id)) ordered.push(row.id);
        }

        for (const [index, id] of ordered.entries()) {
          await tx
            .update(channelCategories)
            .set({ position: index })
            .where(
              and(eq(channelCategories.id, id), eq(channelCategories.groupId, groupId)),
            );
        }
      });
    },

    /**
     * Move channels into a category (or to uncategorized with `categoryId: null`)
     * AND rewrite their order, in one transaction — the single primitive behind
     * "drag a channel to a new place in the sidebar".
     *
     * Every id in `orderedChannelIds` must belong to `groupId` (the API validates;
     * the `group_id` predicate here is the backstop). Positions are rewritten
     * densely from 0 in the given order. Channels of the group NOT named in the
     * list are untouched — this only reorders the target bucket, so reordering
     * "# general, # random" inside one category never disturbs another.
     */
    async moveChannels(
      groupId: GroupId,
      categoryId: CategoryId | null,
      orderedChannelIds: ChannelId[],
    ): Promise<void> {
      const unique = [...new Set(orderedChannelIds)];
      if (unique.length === 0) return;
      await db.transaction(async (tx) => {
        const owned = await tx
          .select({ id: channels.id })
          .from(channels)
          .where(and(eq(channels.groupId, groupId), inArray(channels.id, unique)));
        const valid = new Set(owned.map((r) => r.id));

        let position = 0;
        for (const channelId of unique) {
          if (!valid.has(channelId)) continue;
          await tx
            .update(channels)
            .set({ categoryId, position })
            .where(and(eq(channels.id, channelId), eq(channels.groupId, groupId)));
          position += 1;
        }
      });
    },
  };
}

export type ChannelCategoriesRepo = ReturnType<typeof channelCategoriesRepo>;
