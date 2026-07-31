/**
 * Field primitives shared by more than one request schema: ids, cursors, page
 * limits, colours, and the "send at least one field" guard every PATCH body uses.
 *
 * Extracted because the API currently declares `groupParamsSchema` six times,
 * `channelParamsSchema` three times and the same `.refine(Object.keys(body).length > 0)`
 * three times — identical code, independently maintained. One copy here means a
 * fix reaches every endpoint at once.
 */

import { z } from "zod";
import { CURSOR_MAX_LENGTH, HEX_COLOR_PATTERN } from "@demli/config";
import { customIssue } from "./codes.js";

/**
 * A resource id on the REST wire: a uuid.
 *
 * Note the deliberate difference from `schemas.ts`'s `id` (`min(1).max(128)`),
 * which validates ids on the WS envelope. The gateway relays ids that the API
 * already minted and it does not want to hard-code a format there; a REST route,
 * by contrast, takes ids straight from a URL a user can edit, so the tighter
 * check is what turns a typo into a clean 400 instead of a database round-trip.
 */
export const uuidField = z.string().uuid();

/** An opaque keyset pagination cursor from a previous page's `nextCursor`. */
export const cursorField = z.string().min(1).max(CURSOR_MAX_LENGTH);

/**
 * A page-size query param. `z.coerce` because query strings arrive as strings;
 * the repositories re-clamp authoritatively, so this is the friendly gate rather
 * than the load-bearing one.
 */
export function pageLimit(max: number): z.ZodOptional<z.ZodNumber> {
  return z.coerce.number().int().min(1).max(max).optional();
}

/** A `#rrggbb` colour. */
export const hexColorField = z.string().superRefine((value, ctx) => {
  if (!HEX_COLOR_PATTERN.test(value)) ctx.addIssue(customIssue("hexColorPattern"));
});

/**
 * The PATCH guard: a body that names no field at all is a client bug, and
 * answering 200 to it hides the bug behind a successful-looking no-op.
 *
 * Shaped as a `superRefine` callback rather than a `.refine` predicate so the
 * failure carries a CODE instead of zod's English default "Invalid input" — the
 * one place this rule could otherwise leak untranslated text to a user.
 */
export function requireAtLeastOneField(body: object, ctx: z.RefinementCtx): void {
  if (Object.keys(body).length === 0) ctx.addIssue(customIssue("emptyUpdate"));
}
