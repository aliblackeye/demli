import { and, eq } from "drizzle-orm";
import type { Friendship, User, UserId } from "@demli/types";
import type { Db } from "../client.js";
import { toFriendship, toUser } from "../mappers.js";
import { friendships, users } from "../schema.js";

/**
 * A friend request send outcome (ADR 0010 §2). The DB layer resolves the
 * canonical row and the reverse-pending auto-accept; the API maps each outcome
 * to a status code and the right event (`friend.request_received` for
 * `created`, `friend.request_accepted` for `auto_accepted`).
 */
export type SendRequestOutcome =
  | "created" // brand-new pending row
  | "auto_accepted" // the target had already requested me → now accepted
  | "already_pending" // I already have an outstanding request to them
  | "already_friends" // already accepted
  | "self"; // cannot friend yourself

export interface SendRequestResult {
  outcome: SendRequestOutcome;
  /** The resulting/existing row; null only for `"self"`. */
  friendship: Friendship | null;
}

export type AcceptResult =
  | { ok: true; friendship: Friendship }
  | { ok: false; reason: "not_found" | "not_pending" | "not_addressee" };

/** A friend (or pending counterpart) plus the relationship row. */
export interface FriendWithUser {
  user: User;
  friendship: Friendship;
}

/** Canonical unordered pair — `user_a < user_b`, matching the DB CHECK. */
function canonical(x: UserId, y: UserId): [UserId, UserId] {
  return x < y ? [x, y] : [y, x];
}

/**
 * Friendships query layer (ADR 0010 §2). Every row is stored canonically
 * (`user_a < user_b`); this repo is the single place that enforces the pair
 * invariant, the reverse-pending auto-accept, and the addressee-only accept
 * guard, so the API never reasons about ordering.
 */
export function friendshipsRepo(db: Db) {
  return {
    /**
     * Send a request from `requesterId` to `addresseeId`. Idempotent and
     * consent-aware: a duplicate outgoing request is a no-op; if the addressee
     * had already requested the requester, both sides have now consented and the
     * row goes straight to `accepted`.
     */
    async send(requesterId: UserId, addresseeId: UserId): Promise<SendRequestResult> {
      if (requesterId === addresseeId) return { outcome: "self", friendship: null };
      const [a, b] = canonical(requesterId, addresseeId);
      return db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(friendships)
          .where(and(eq(friendships.userA, a), eq(friendships.userB, b)))
          .for("update")
          .limit(1);

        if (existing) {
          if (existing.status === "accepted") {
            return { outcome: "already_friends", friendship: toFriendship(existing) };
          }
          if (existing.requestedBy === requesterId) {
            return { outcome: "already_pending", friendship: toFriendship(existing) };
          }
          // Reverse pending: they asked me first → mutual consent → accept.
          const [updated] = await tx
            .update(friendships)
            .set({ status: "accepted", updatedAt: new Date() })
            .where(and(eq(friendships.userA, a), eq(friendships.userB, b)))
            .returning();
          if (!updated) throw new Error("friendships auto-accept returned no row");
          return { outcome: "auto_accepted", friendship: toFriendship(updated) };
        }

        const [row] = await tx
          .insert(friendships)
          .values({ userA: a, userB: b, status: "pending", requestedBy: requesterId })
          .returning();
        if (!row) throw new Error("insert friendships returned no row");
        return { outcome: "created", friendship: toFriendship(row) };
      });
    },

    /**
     * Accept a pending request. Only the ADDRESSEE (the side that is not
     * `requested_by`) may accept — a requester accepting their own request is
     * rejected with `not_addressee`.
     */
    async accept(byUser: UserId, otherUser: UserId): Promise<AcceptResult> {
      const [a, b] = canonical(byUser, otherUser);
      return db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(friendships)
          .where(and(eq(friendships.userA, a), eq(friendships.userB, b)))
          .for("update")
          .limit(1);
        if (!existing) return { ok: false, reason: "not_found" };
        if (existing.status !== "pending") return { ok: false, reason: "not_pending" };
        if (existing.requestedBy === byUser) return { ok: false, reason: "not_addressee" };
        const [updated] = await tx
          .update(friendships)
          .set({ status: "accepted", updatedAt: new Date() })
          .where(and(eq(friendships.userA, a), eq(friendships.userB, b)))
          .returning();
        if (!updated) throw new Error("friendships accept returned no row");
        return { ok: true, friendship: toFriendship(updated) };
      });
    },

    /**
     * Delete the pair row regardless of status — the single primitive behind
     * decline (addressee), cancel (requester), and unfriend (either side).
     * Returns true when a row was removed.
     */
    async remove(userX: UserId, userY: UserId): Promise<boolean> {
      const [a, b] = canonical(userX, userY);
      const rows = await db
        .delete(friendships)
        .where(and(eq(friendships.userA, a), eq(friendships.userB, b)))
        .returning({ userA: friendships.userA });
      return rows.length > 0;
    },

    /** The raw relationship row for a pair (any status), or null. */
    async getFriendshipWith(viewerId: UserId, targetId: UserId): Promise<Friendship | null> {
      if (viewerId === targetId) return null;
      const [a, b] = canonical(viewerId, targetId);
      const [row] = await db
        .select()
        .from(friendships)
        .where(and(eq(friendships.userA, a), eq(friendships.userB, b)))
        .limit(1);
      return row ? toFriendship(row) : null;
    },

    /** Accepted friends of `userId`, each with the other user's record. */
    async listFriends(userId: UserId): Promise<FriendWithUser[]> {
      const asA = await db
        .select({ f: friendships, u: users })
        .from(friendships)
        .innerJoin(users, eq(users.id, friendships.userB))
        .where(and(eq(friendships.userA, userId), eq(friendships.status, "accepted")));
      const asB = await db
        .select({ f: friendships, u: users })
        .from(friendships)
        .innerJoin(users, eq(users.id, friendships.userA))
        .where(and(eq(friendships.userB, userId), eq(friendships.status, "accepted")));
      return [...asA, ...asB].map((r) => ({
        user: toUser(r.u),
        friendship: toFriendship(r.f),
      }));
    },

    /**
     * Pending requests involving `userId`, filtered by direction: `"incoming"`
     * = someone asked me (I may accept), `"outgoing"` = I asked someone. The
     * embedded user is always the OTHER party.
     */
    async listRequests(
      userId: UserId,
      direction: "incoming" | "outgoing",
    ): Promise<FriendWithUser[]> {
      const asA = await db
        .select({ f: friendships, u: users })
        .from(friendships)
        .innerJoin(users, eq(users.id, friendships.userB))
        .where(and(eq(friendships.userA, userId), eq(friendships.status, "pending")));
      const asB = await db
        .select({ f: friendships, u: users })
        .from(friendships)
        .innerJoin(users, eq(users.id, friendships.userA))
        .where(and(eq(friendships.userB, userId), eq(friendships.status, "pending")));
      return [...asA, ...asB]
        .filter((r) =>
          direction === "outgoing"
            ? r.f.requestedBy === userId
            : r.f.requestedBy !== userId,
        )
        .map((r) => ({ user: toUser(r.u), friendship: toFriendship(r.f) }));
    },

    /** Ids of every accepted friend — the presence-audience extension (§4). */
    async listAcceptedFriendIds(userId: UserId): Promise<UserId[]> {
      const asA = await db
        .select({ id: friendships.userB })
        .from(friendships)
        .where(and(eq(friendships.userA, userId), eq(friendships.status, "accepted")));
      const asB = await db
        .select({ id: friendships.userA })
        .from(friendships)
        .where(and(eq(friendships.userB, userId), eq(friendships.status, "accepted")));
      return [...asA.map((r) => r.id), ...asB.map((r) => r.id)];
    },
  };
}

export type FriendshipsRepo = ReturnType<typeof friendshipsRepo>;
