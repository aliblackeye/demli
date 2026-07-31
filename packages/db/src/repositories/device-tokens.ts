import { eq, inArray, sql } from "drizzle-orm";
import type { UserId } from "@demli/types";
import type { Db } from "../client.js";
import { toDeviceToken, type DeviceToken, type DevicePlatform } from "../mappers.js";
import { deviceTokens } from "../schema.js";

/** A user's token, the minimum a push fan-out needs (no id/timestamps). */
export interface UserPushToken {
  userId: UserId;
  token: string;
  platform: DevicePlatform;
}

/**
 * Device-token query layer (task #46). One row per physical device; the Expo
 * push token is the natural key (UNIQUE), NOT the surrogate id, because a device
 * can be handed to a new account on re-install — {@link DeviceTokensRepo.upsert}
 * re-binds the existing row instead of inserting a duplicate.
 *
 * The push service (apps/api) owns invalidation: when Expo answers
 * `DeviceNotRegistered` for a token it is removed via {@link deleteByTokens}.
 */
export function deviceTokensRepo(db: Db) {
  return {
    /**
     * Register (or re-register) a device. Idempotent on the token:
     * - new token → insert.
     * - existing token → re-bind to `userId` (device changed hands), refresh the
     *   platform, and bump `last_seen_at`.
     * Returns the resulting row.
     */
    async upsert(
      userId: UserId,
      token: string,
      platform: DevicePlatform,
    ): Promise<DeviceToken> {
      const [row] = await db
        .insert(deviceTokens)
        .values({ userId, token, platform })
        .onConflictDoUpdate({
          target: deviceTokens.token,
          set: {
            userId,
            platform,
            lastSeenAt: sql`now()`,
          },
        })
        .returning();
      if (!row) throw new Error("upsert device_tokens returned no row");
      return toDeviceToken(row);
    },

    /** Every device registered to a single user (newest registration first). */
    async listForUser(userId: UserId): Promise<DeviceToken[]> {
      const rows = await db
        .select()
        .from(deviceTokens)
        .where(eq(deviceTokens.userId, userId));
      return rows.map(toDeviceToken);
    },

    /**
     * Flat list of (userId, token, platform) for a set of users — the push
     * fan-out primitive. Empty input short-circuits (no query).
     */
    async listTokensForUsers(userIds: readonly UserId[]): Promise<UserPushToken[]> {
      if (userIds.length === 0) return [];
      const rows = await db
        .select({
          userId: deviceTokens.userId,
          token: deviceTokens.token,
          platform: deviceTokens.platform,
        })
        .from(deviceTokens)
        .where(inArray(deviceTokens.userId, [...userIds]));
      return rows.map((r) => ({
        userId: r.userId,
        token: r.token,
        platform: r.platform as DevicePlatform,
      }));
    },

    /**
     * Remove a device the CALLER owns (logout). Scoped to `userId` so one user
     * can never delete another's registration by presenting its token. Returns
     * true when a row was removed.
     */
    async deleteForUser(userId: UserId, token: string): Promise<boolean> {
      const removed = await db
        .delete(deviceTokens)
        .where(sql`${deviceTokens.userId} = ${userId} and ${deviceTokens.token} = ${token}`)
        .returning({ id: deviceTokens.id });
      return removed.length > 0;
    },

    /**
     * Purge tokens Expo reported as dead (`DeviceNotRegistered`). Keyed on the
     * token alone — a dead token is dead regardless of its current owner. Returns
     * the number of rows removed.
     */
    async deleteByTokens(tokens: readonly string[]): Promise<number> {
      if (tokens.length === 0) return 0;
      const removed = await db
        .delete(deviceTokens)
        .where(inArray(deviceTokens.token, [...tokens]))
        .returning({ id: deviceTokens.id });
      return removed.length;
    },
  };
}

export type DeviceTokensRepo = ReturnType<typeof deviceTokensRepo>;
