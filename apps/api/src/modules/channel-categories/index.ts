/**
 * Channel categories + sidebar ordering (M18).
 *
 * Routes:
 *   POST   /groups/:groupId/categories                 create           → 201 { category }
 *   GET    /groups/:groupId/categories                 list             → { categories }
 *   PATCH  /categories/:categoryId                     rename           → { category }
 *   DELETE /categories/:categoryId                     delete           → 204
 *   PATCH  /groups/:groupId/channel-order              reorder          → 204
 *
 * Permission: owner ∨ MANAGE_CHANNELS on every mutation — the SAME bit that
 * already governs "create/edit/delete/reorder channels" (ADR 0007, see
 * `PERMISSIONS.MANAGE_CHANNELS`). No new permission system is invented: a
 * category is a channel-organization concept, so it rides the channel bit.
 * Reading is open to any member (they already see the channels).
 *
 * Categories are PURELY ORGANIZATIONAL — they carry no permissions and never
 * affect channel VISIBILITY, which stays the M9 `channel_role_access` model. That
 * is why the reorder endpoint needs no visibility recompute and the gateway
 * forwards these events without a subscription resync (§27).
 *
 * The reorder endpoint deliberately takes BOTH axes in one call (`categoryIds`
 * and/or `channels`) and answers with ONE `category.reordered` event, so a drag
 * that moves a channel between categories AND shifts a category header is a
 * single atomic statement — never two racing deltas the client must reconcile.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RealtimeMutationPublisher } from "@demli/db";
import { serverEvent } from "@demli/protocol";
import type { CategoryId, ChannelCategory } from "@demli/types";
import { PERMISSIONS } from "@demli/types";
import { ApiError, parseWith } from "../../errors.js";
import { loadServer, requirePerm } from "../../lib/permissions.js";
import { requireUser } from "../../plugins/auth.js";
import { LIST_LIMIT, userRateLimit } from "../../lib/rate-limit.js";

/** Category name bounds — a sidebar header, not a description. */
const CATEGORY_NAME_MAX_LENGTH = 64;
/** Safety cap on the id lists a single reorder may carry. */
const REORDER_LIST_MAX = 500;

const groupParamsSchema = z.object({
  groupId: z.string().uuid("Invalid group id."),
});

const categoryParamsSchema = z.object({
  categoryId: z.string().uuid("Invalid category id."),
});

const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(CATEGORY_NAME_MAX_LENGTH),
});

const renameCategorySchema = z.object({
  name: z.string().trim().min(1).max(CATEGORY_NAME_MAX_LENGTH),
});

/**
 * Reorder body. Both halves are optional but at least one must be present:
 *  - `categoryIds` — the server's categories in their new order;
 *  - `channels`    — the channels whose category and/or position changed, each
 *    with its target category (`null` = the uncategorized top-level list). The
 *    ORDER of this array is the new order within its bucket.
 */
const reorderSchema = z
  .object({
    categoryIds: z
      .array(z.string().uuid("Invalid category id."))
      .max(REORDER_LIST_MAX)
      .optional(),
    channels: z
      .array(
        z.object({
          channelId: z.string().uuid("Invalid channel id."),
          categoryId: z.string().uuid("Invalid category id.").nullable(),
        }),
      )
      .max(REORDER_LIST_MAX)
      .optional(),
  })
  .refine(
    (b) => (b.categoryIds?.length ?? 0) > 0 || (b.channels?.length ?? 0) > 0,
    { message: "Provide categoryIds and/or channels to reorder." },
  );

export async function registerChannelCategoriesModule(
  server: FastifyInstance,
  mutationBus?: RealtimeMutationPublisher,
): Promise<void> {
  /**
   * Resolve a category the caller may MANAGE, or throw. Enforces (in order):
   * the category exists, its group is a SERVER the caller belongs to (a
   * non-member / flat chat gets the same "not found", no existence leak, §28),
   * and the caller is owner ∨ MANAGE_CHANNELS.
   */
  async function loadManageableCategory(
    categoryId: CategoryId,
    userId: string,
  ): Promise<ChannelCategory> {
    const category = await server.repos.channelCategories.findById(categoryId);
    if (!category) throw new ApiError(404, "NOT_FOUND", "Category not found.");
    // loadServer answers 404 for a non-member OR a non-server — so this doubles
    // as the membership + kind gate without leaking which one failed.
    const { role } = await loadServer(server, category.groupId, userId).catch(() => {
      throw new ApiError(404, "NOT_FOUND", "Category not found.");
    });
    await requirePerm(
      server,
      category.groupId,
      role,
      userId,
      PERMISSIONS.MANAGE_CHANNELS,
      "You do not have permission to manage categories.",
    );
    return category;
  }

  server.post(
    "/groups/:groupId/categories",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 30, timeWindow: "1 minute" }),
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { groupId } = parseWith(groupParamsSchema, request.params);
      const body = parseWith(createCategorySchema, request.body);

      const { role } = await loadServer(server, groupId, user.id);
      await requirePerm(
        server,
        groupId,
        role,
        user.id,
        PERMISSIONS.MANAGE_CHANNELS,
        "You do not have permission to create categories.",
      );

      const category = await server.repos.channelCategories.create({
        groupId,
        name: body.name,
      });
      await mutationBus?.publish({
        groupId,
        event: serverEvent.categoryCreated({ category }),
      });
      return reply.status(201).send({ category });
    },
  );

  // Any member may READ the categories — they already see the channels these
  // group, so the header list carries no additional information.
  server.get(
    "/groups/:groupId/categories",
    {
      preHandler: [server.authenticate],
      config: { rateLimit: userRateLimit(LIST_LIMIT) },
    },
    async (request) => {
      const user = requireUser(request);
      const { groupId } = parseWith(groupParamsSchema, request.params);
      await loadServer(server, groupId, user.id);
      return { categories: await server.repos.channelCategories.listForGroup(groupId) };
    },
  );

  server.patch(
    "/categories/:categoryId",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 30, timeWindow: "1 minute" }),
      },
    },
    async (request) => {
      const user = requireUser(request);
      const { categoryId } = parseWith(categoryParamsSchema, request.params);
      const body = parseWith(renameCategorySchema, request.body);

      const existing = await loadManageableCategory(categoryId, user.id);
      const category = await server.repos.channelCategories.rename(categoryId, body.name);
      if (!category) throw new ApiError(404, "NOT_FOUND", "Category not found.");

      await mutationBus?.publish({
        groupId: existing.groupId,
        event: serverEvent.categoryUpdated({ category }),
      });
      return { category };
    },
  );

  server.delete(
    "/categories/:categoryId",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 30, timeWindow: "1 minute" }),
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { categoryId } = parseWith(categoryParamsSchema, request.params);

      const category = await loadManageableCategory(categoryId, user.id);

      // Snapshot the channels BEFORE the delete: the FK is ON DELETE SET NULL, so
      // after the delete there is no way to tell which channels were freed. The
      // event carries them so clients move them to the top-level list without a
      // full channel refetch.
      const freed = (await server.repos.channels.listForGroup(category.groupId))
        .filter((c) => c.categoryId === categoryId)
        .map((c) => c.id);

      const removed = await server.repos.channelCategories.delete(categoryId);
      if (!removed) throw new ApiError(404, "NOT_FOUND", "Category not found.");

      await mutationBus?.publish({
        groupId: category.groupId,
        event: serverEvent.categoryDeleted({
          groupId: category.groupId,
          categoryId,
          channelIds: freed,
        }),
      });
      return reply.status(204).send();
    },
  );

  // The sidebar reorder: category order and/or channel placement, atomically.
  server.patch(
    "/groups/:groupId/channel-order",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 60, timeWindow: "1 minute" }),
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { groupId } = parseWith(groupParamsSchema, request.params);
      const body = parseWith(reorderSchema, request.body);

      const { role } = await loadServer(server, groupId, user.id);
      await requirePerm(
        server,
        groupId,
        role,
        user.id,
        PERMISSIONS.MANAGE_CHANNELS,
        "You do not have permission to reorder channels.",
      );

      // Validate EVERY referenced id against THIS group before writing anything —
      // a stale/hostile client must never reposition another server's rows. The
      // repo re-filters as a backstop, but a friendly 400 beats a silent no-op.
      const groupCategoryIds = new Set(
        (await server.repos.channelCategories.listForGroup(groupId)).map((c) => c.id),
      );
      const groupChannels = await server.repos.channels.listForGroup(groupId);
      const groupChannelIds = new Set(groupChannels.map((c) => c.id));

      for (const id of body.categoryIds ?? []) {
        if (!groupCategoryIds.has(id)) {
          throw new ApiError(
            400,
            "VALIDATION_ERROR",
            "Category does not belong to this group.",
          );
        }
      }
      for (const entry of body.channels ?? []) {
        if (!groupChannelIds.has(entry.channelId)) {
          throw new ApiError(
            400,
            "VALIDATION_ERROR",
            "Channel does not belong to this group.",
          );
        }
        if (entry.categoryId !== null && !groupCategoryIds.has(entry.categoryId)) {
          throw new ApiError(
            400,
            "VALIDATION_ERROR",
            "Category does not belong to this group.",
          );
        }
      }

      if ((body.categoryIds?.length ?? 0) > 0) {
        await server.repos.channelCategories.reorderCategories(
          groupId,
          body.categoryIds ?? [],
        );
      }

      // Group the channel moves by TARGET bucket so each bucket's positions are
      // rewritten densely from 0 in the order the client listed them. A client
      // that only reordered inside one category therefore never disturbs another.
      const byBucket = new Map<string, { categoryId: CategoryId | null; ids: string[] }>();
      for (const entry of body.channels ?? []) {
        const key = entry.categoryId ?? " uncategorized";
        const bucket = byBucket.get(key) ?? { categoryId: entry.categoryId, ids: [] };
        bucket.ids.push(entry.channelId);
        byBucket.set(key, bucket);
      }
      for (const bucket of byBucket.values()) {
        await server.repos.channelCategories.moveChannels(
          groupId,
          bucket.categoryId,
          bucket.ids,
        );
      }

      // Re-read so the event states the AUTHORITATIVE placement (positions as the
      // DB now holds them), not the client's request echoed back.
      const [categories, channels] = await Promise.all([
        server.repos.channelCategories.listForGroup(groupId),
        server.repos.channels.listForGroup(groupId),
      ]);
      const touched = new Set((body.channels ?? []).map((c) => c.channelId));
      await mutationBus?.publish({
        groupId,
        event: serverEvent.categoryReordered({
          groupId,
          categoryIds: categories.map((c) => c.id),
          channels: channels
            .filter((c) => touched.has(c.id))
            .map((c) => ({
              channelId: c.id,
              categoryId: c.categoryId ?? null,
              position: c.position,
            })),
        }),
      });

      return reply.status(204).send();
    },
  );
}
