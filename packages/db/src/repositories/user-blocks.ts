import { and, desc, eq, inArray, or } from "drizzle-orm";
import type { BlockedUser, UserBlock, UserId } from "@demli/types";
import type { Db } from "../client.js";
import { toBlockedUser, toUserBlock } from "../mappers.js";
import { userBlocks, users } from "../schema.js";

/**
 * User blocking (M18, ADR 0017).
 *
 * Rows are DIRECTIONAL (`blocker` → `blocked`) but almost every enforcement point
 * asks the SYMMETRIC question — "is there a block in either direction between
 * these two?" — because a block must stop contact BOTH ways: the blocker no
 * longer receives from the blocked user, AND the blocked user can no longer reach
 * the blocker (otherwise blocking would only mute, not protect).
 *
 * The two symmetric primitives are the ones call sites should reach for:
 *  - {@link UserBlocksRepo.existsBetween} for a single pair (a DM send, a call);
 *  - {@link UserBlocksRepo.relatedIds} for a batch (filter a message page, a push
 *    audience, a member roster) — ONE query returning every counterpart in either
 *    direction, so no call site ever N+1s per user.
 */
export function userBlocksRepo(db: Db) {
  return {
    /**
     * Block `blockedId` on behalf of `blockerId`. IDEMPOTENT: re-blocking someone
     * already blocked returns the existing row rather than erroring, so a
     * double-tapped button is harmless. Self-blocking is refused (the DB CHECK
     * `user_blocks_no_self` is the backstop; this returns null so the API can map
     * it to a 400 without catching a constraint error).
     */
    async block(blockerId: UserId, blockedId: UserId): Promise<UserBlock | null> {
      if (blockerId === blockedId) return null;
      const [inserted] = await db
        .insert(userBlocks)
        .values({ blockerId, blockedId })
        .onConflictDoNothing({ target: [userBlocks.blockerId, userBlocks.blockedId] })
        .returning();
      if (inserted) return toUserBlock(inserted);
      const [existing] = await db
        .select()
        .from(userBlocks)
        .where(
          and(eq(userBlocks.blockerId, blockerId), eq(userBlocks.blockedId, blockedId)),
        )
        .limit(1);
      return existing ? toUserBlock(existing) : null;
    },

    /** Lift a block. Returns true when a row was actually removed (else it never existed). */
    async unblock(blockerId: UserId, blockedId: UserId): Promise<boolean> {
      const rows = await db
        .delete(userBlocks)
        .where(
          and(eq(userBlocks.blockerId, blockerId), eq(userBlocks.blockedId, blockedId)),
        )
        .returning({ blockerId: userBlocks.blockerId });
      return rows.length > 0;
    },

    /**
     * Everyone THIS user has blocked, newest first, hydrated with the blocked
     * user's public record for the settings list. Deliberately one-directional:
     * this answers "who did I block", never "who blocked me" — the latter is
     * information a block exists to withhold (§28).
     */
    async listBlocked(blockerId: UserId): Promise<BlockedUser[]> {
      const rows = await db
        .select({ block: userBlocks, user: users })
        .from(userBlocks)
        .innerJoin(users, eq(users.id, userBlocks.blockedId))
        .where(eq(userBlocks.blockerId, blockerId))
        .orderBy(desc(userBlocks.createdAt));
      return rows.map((r) => toBlockedUser(r.block, r.user));
    },

    /** True when `viewerId` has blocked `targetId` (ONE direction — the profile flag). */
    async hasBlocked(viewerId: UserId, targetId: UserId): Promise<boolean> {
      if (viewerId === targetId) return false;
      const [row] = await db
        .select({ blockerId: userBlocks.blockerId })
        .from(userBlocks)
        .where(and(eq(userBlocks.blockerId, viewerId), eq(userBlocks.blockedId, targetId)))
        .limit(1);
      return row !== undefined;
    },

    /**
     * THE guard: true when a block exists between `a` and `b` in EITHER direction.
     * Every "can these two interact" check (DM send, friend request, DM call,
     * group-DM invite redeem, add-by-username) routes through this, so the rule
     * lives in one place and cannot drift per surface.
     */
    async existsBetween(a: UserId, b: UserId): Promise<boolean> {
      if (a === b) return false;
      const [row] = await db
        .select({ blockerId: userBlocks.blockerId })
        .from(userBlocks)
        .where(
          or(
            and(eq(userBlocks.blockerId, a), eq(userBlocks.blockedId, b)),
            and(eq(userBlocks.blockerId, b), eq(userBlocks.blockedId, a)),
          ),
        )
        .limit(1);
      return row !== undefined;
    },

    /**
     * BATCH form of {@link existsBetween}: every user id that has a block with
     * `userId` in either direction. ONE query, so filtering a message page, a
     * push audience, or a member roster costs a single round trip instead of one
     * per candidate (§27).
     *
     * Pass `candidates` to bound the scan to the ids you actually care about
     * (e.g. the distinct authors of a 50-message page); omit it for the user's
     * full block universe (the gateway's per-connection set).
     */
    async relatedIds(userId: UserId, candidates?: UserId[]): Promise<Set<UserId>> {
      if (candidates !== undefined) {
        const unique = [...new Set(candidates)].filter((id) => id !== userId);
        if (unique.length === 0) return new Set();
        const rows = await db
          .select({ blockerId: userBlocks.blockerId, blockedId: userBlocks.blockedId })
          .from(userBlocks)
          .where(
            or(
              and(eq(userBlocks.blockerId, userId), inArray(userBlocks.blockedId, unique)),
              and(eq(userBlocks.blockedId, userId), inArray(userBlocks.blockerId, unique)),
            ),
          );
        return new Set(
          rows.map((r) => (r.blockerId === userId ? r.blockedId : r.blockerId)),
        );
      }

      const rows = await db
        .select({ blockerId: userBlocks.blockerId, blockedId: userBlocks.blockedId })
        .from(userBlocks)
        .where(or(eq(userBlocks.blockerId, userId), eq(userBlocks.blockedId, userId)));
      return new Set(rows.map((r) => (r.blockerId === userId ? r.blockedId : r.blockerId)));
    },
  };
}

export type UserBlocksRepo = ReturnType<typeof userBlocksRepo>;
