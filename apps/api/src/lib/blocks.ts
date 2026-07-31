/**
 * Shared block enforcement (M18, ADR 0017).
 *
 * Blocking is stored DIRECTIONALLY (`user_blocks`) but enforced SYMMETRICALLY:
 * once a block exists in either direction the two users can no longer reach each
 * other on ANY surface. Every guard lives here so the rule cannot drift per
 * endpoint — a new surface calls one of these three helpers rather than writing
 * its own predicate:
 *
 *  - {@link assertNotBlocked}   — "these two may not interact" (403), for the
 *    directed actions: DM open/send, friend request, DM call, group-DM add.
 *  - {@link isBlockedBetween}   — the same test without throwing, for the paths
 *    that must stay silent/uniform (add-by-username must not become an oracle).
 *  - {@link blockedAuthorIds}   — the batch form for READ paths: which authors'
 *    messages must be filtered out of a page / search / push audience.
 *
 * SERVER-SIDE, not client-side: hidden content is filtered in SQL and never
 * leaves the process (see the ADR — a client-side hide still ships the blocked
 * user's text to the machine that blocked them, which is a real leak).
 */

import type { FastifyInstance } from "fastify";
import type { UserId } from "@demli/types";
import { ApiError } from "../errors.js";

/**
 * The ONE user-facing message for a refused interaction. Deliberately identical
 * whichever side blocked: telling A that B blocked them is exactly the
 * information a block withholds (§28), so both directions answer the same.
 */
export const BLOCKED_MESSAGE = "You can't do that because of a block between you and this user.";

/** True when a block exists between the two users in EITHER direction. */
export async function isBlockedBetween(
  server: FastifyInstance,
  a: UserId,
  b: UserId,
): Promise<boolean> {
  return server.repos.userBlocks.existsBetween(a, b);
}

/**
 * Throw `403 BLOCKED` when a block exists between the two users in either
 * direction. The guard for every DIRECTED action (DM, friend request, call,
 * group-DM add). Same code + copy both ways — see {@link BLOCKED_MESSAGE}.
 */
export async function assertNotBlocked(
  server: FastifyInstance,
  a: UserId,
  b: UserId,
): Promise<void> {
  if (await isBlockedBetween(server, a, b)) {
    throw new ApiError(403, "BLOCKED", BLOCKED_MESSAGE);
  }
}

/**
 * The authors whose messages must be HIDDEN from `viewerId` — every user with a
 * block against them in either direction. ONE query (see
 * `userBlocksRepo.relatedIds`), so a page read costs a single extra round trip
 * regardless of how many distinct authors it contains (§27).
 *
 * Pass `candidates` when the set is already known (e.g. a push audience) to bound
 * the scan; omit it for a read path where the authors are not yet known (a
 * message page is filtered in SQL by author, so it needs the full universe).
 */
export async function blockedAuthorIds(
  server: FastifyInstance,
  viewerId: UserId,
  candidates?: UserId[],
): Promise<UserId[]> {
  const ids = await server.repos.userBlocks.relatedIds(viewerId, candidates);
  return [...ids];
}
