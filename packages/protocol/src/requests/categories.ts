/**
 * Sidebar category request bodies (M18) — create, rename, and the bulk reorder
 * that moves channels between categories.
 */

import { z } from "zod";
import { CATEGORY_NAME_MAX_LENGTH, REORDER_LIST_MAX } from "@demli/config";
import { customIssue } from "./codes.js";
import { uuidField } from "./common.js";
import { nameText, type TextField } from "./text.js";

/** Category name: 1..64, at least one visible character. A header, not a description. */
export const categoryNameField: TextField = nameText(CATEGORY_NAME_MAX_LENGTH);

/** `/categories/:categoryId` routes. */
export const categoryParamsSchema = z.object({ categoryId: uuidField });

/** `POST /groups/:groupId/categories`. */
export const createCategoryBodySchema = z.object({ name: categoryNameField });

/**
 * `PATCH /categories/:categoryId`.
 *
 * Identical to the create body today, and declared separately anyway: the two
 * bodies are separate contracts that merely happen to agree, and a future
 * create-only field (a default collapsed state, say) must not silently become
 * renameable.
 */
export const renameCategoryBodySchema = z.object({ name: categoryNameField });

/**
 * `PATCH /groups/:groupId/channel-order`.
 *
 * Both halves are optional but at least one must carry entries:
 *  - `categoryIds` — the server's categories in their new order;
 *  - `channels`    — the channels whose category and/or position changed, each
 *    with its target category (`null` = the uncategorized top-level list). The
 *    ORDER of the array is the new order within its bucket.
 *
 * Cross-group ownership (every id belonging to `:groupId`) is checked in the
 * handler — it needs the database, and a body cannot vouch for itself.
 */
export const reorderChannelsBodySchema = z
  .object({
    categoryIds: z.array(uuidField).max(REORDER_LIST_MAX).optional(),
    channels: z
      .array(z.object({ channelId: uuidField, categoryId: uuidField.nullable() }))
      .max(REORDER_LIST_MAX)
      .optional(),
  })
  .superRefine((body, ctx) => {
    const empty =
      (body.categoryIds?.length ?? 0) === 0 && (body.channels?.length ?? 0) === 0;
    if (empty) ctx.addIssue(customIssue("emptyUpdate"));
  });

export type CreateCategoryBody = z.infer<typeof createCategoryBodySchema>;
export type RenameCategoryBody = z.infer<typeof renameCategoryBodySchema>;
export type ReorderChannelsBody = z.infer<typeof reorderChannelsBodySchema>;
