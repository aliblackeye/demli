import { randomBytes } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type {
  GroupId,
  MutualServer,
  ProfileFriendshipStatus,
  User,
  UserId,
  UserProfile,
} from "@demli/types";
import type { Db } from "../client.js";
import {
  toRole,
  toSelfUser,
  toUser,
  toUserAuthRecord,
  type UserAuthRecord,
} from "../mappers.js";
import {
  friendGroupMembers,
  friendGroups,
  friendships,
  memberRoles,
  roles,
  userBlocks,
  users,
} from "../schema.js";

export interface CreateUserInput {
  username: string;
  displayName: string;
  avatarUrl?: string | null;
  /**
   * argon2id hash for a password account, or `null`/omitted for a Google-only
   * account (0010) that authenticates by {@link googleSub} instead.
   */
  passwordHash?: string | null;
  /** Verified email (0010); stored case-insensitively unique. */
  email?: string | null;
  /** Google subject id (0010); unique per Google account. */
  googleSub?: string | null;
  /**
   * Date of birth (M15) as an ISO `YYYY-MM-DD` string, or null/omitted. Validated
   * at the API boundary (valid calendar date, year > 1900, not in the future).
   */
  birthdate?: string | null;
}

/** Default freeze window before an account is hard-purged (M15): 14 days. */
export const ACCOUNT_FREEZE_DAYS = 14;

/** Fields set when linking a Google identity onto an existing user (0010). */
export interface LinkGoogleInput {
  googleSub: string;
  /** Verified email to backfill; omit to leave the row's email untouched. */
  email?: string | null;
  /** Avatar to adopt only when the account has none; omit to leave untouched. */
  avatarUrl?: string | null;
}

export interface UpdateProfileInput {
  displayName?: string;
  avatarUrl?: string | null;
  /** ≤280, validated at the API boundary; `null` clears it. */
  bio?: string | null;
  /** Public profile banner URL (M15); `null` clears it. */
  bannerUrl?: string | null;
  /**
   * Date of birth (M15) as an ISO `YYYY-MM-DD`. Set-once at the API boundary
   * (only writable while still null); the age-gate integrity check lives in the
   * `PATCH /users/me` handler, not here.
   */
  birthdate?: string | null;
}

/** Unambiguous base32 alphabet (no 0/O/1/I/L), shared with invite codes. */
const FRIEND_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const FRIEND_CODE_LENGTH = 8;
/** How many code regenerations to attempt on a unique collision before failing. */
const CODE_RETRY_LIMIT = 8;

/**
 * A fresh friend code (ADR 0010 §2): 8 chars of {@link FRIEND_CODE_ALPHABET},
 * uppercase. 30⁸ ≈ 6.5×10¹¹ combinations; collisions are handled by retrying
 * against the DB unique index, not avoided by construction.
 */
export function generateFriendCode(): string {
  const bytes = randomBytes(FRIEND_CODE_LENGTH);
  let code = "";
  for (const byte of bytes) {
    code += FRIEND_CODE_ALPHABET[byte % FRIEND_CODE_ALPHABET.length];
  }
  return code;
}

/** Canonicalize user-typed input (`xxxx-xxxx`, spaces, lowercase) for lookup. */
export function normalizeFriendCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function isFriendCodeCollision(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "23505" &&
    (err as { constraint_name?: string }).constraint_name === "users_friend_code_unique"
  );
}

export function usersRepo(db: Db) {
  return {
    /**
     * Create a user, minting a unique {@link generateFriendCode}. Regenerates
     * the code and retries on the (astronomically rare) unique collision; a
     * username collision propagates unchanged so the caller still sees it.
     */
    async create(input: CreateUserInput): Promise<User> {
      for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt++) {
        try {
          const [row] = await db
            .insert(users)
            .values({
              username: input.username,
              displayName: input.displayName,
              avatarUrl: input.avatarUrl ?? null,
              passwordHash: input.passwordHash ?? null,
              email: input.email ?? null,
              googleSub: input.googleSub ?? null,
              birthdate: input.birthdate ?? null,
              friendCode: generateFriendCode(),
            })
            .returning();
          if (!row) throw new Error("insert users returned no row");
          return toUser(row);
        } catch (err) {
          if (isFriendCodeCollision(err)) continue;
          throw err;
        }
      }
      throw new Error("could not generate a unique friend code");
    },

    async findById(id: UserId): Promise<User | null> {
      const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
      return row ? toUser(row) : null;
    },

    /**
     * The caller's OWN record for `/users/me` — includes the private
     * `friendCode` ({@link toSelfUser}). Never use to fetch another user.
     */
    async findSelf(id: UserId): Promise<User | null> {
      const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
      return row ? toSelfUser(row) : null;
    },

    async findByUsername(username: string): Promise<UserAuthRecord | null> {
      const [row] = await db
        .select()
        .from(users)
        .where(eq(users.username, username))
        .limit(1);
      return row ? toUserAuthRecord(row) : null;
    },

    /** Resolve a linked Google identity by its stable `sub` (0010). */
    async findByGoogleSub(googleSub: string): Promise<User | null> {
      const [row] = await db
        .select()
        .from(users)
        .where(eq(users.googleSub, googleSub))
        .limit(1);
      return row ? toUser(row) : null;
    },

    /**
     * Resolve a user by email, case-insensitively (0010) — matches the
     * `lower(email)` unique index. Note: pre-0010 password users have NULL email,
     * so this only ever matches an account that has already stored one (i.e. a
     * Google-linked account), never a legacy password-only row.
     */
    async findByEmail(email: string): Promise<User | null> {
      const normalized = email.trim().toLowerCase();
      if (normalized.length === 0) return null;
      const [row] = await db
        .select()
        .from(users)
        .where(sql`lower(${users.email}) = ${normalized}`)
        .limit(1);
      return row ? toUser(row) : null;
    },

    /**
     * Attach a Google identity to an existing account (0010). Always sets
     * `google_sub`; backfills `email` when provided and adopts `avatarUrl` only
     * when the caller passes one AND the row currently has none (never clobbers a
     * user-chosen avatar). Returns the updated user, or null if it vanished.
     */
    async linkGoogleAccount(
      userId: UserId,
      input: LinkGoogleInput,
    ): Promise<User | null> {
      const patch: Partial<typeof users.$inferInsert> = { googleSub: input.googleSub };
      if (input.email !== undefined && input.email !== null) patch.email = input.email;
      const [row] = await db
        .update(users)
        .set(patch)
        .where(eq(users.id, userId))
        .returning();
      if (!row) return null;
      // Adopt the Google picture only for an account with no avatar yet, in a
      // second guarded update so we never overwrite a chosen avatar.
      if (input.avatarUrl && !row.avatarUrl) {
        const [withAvatar] = await db
          .update(users)
          .set({ avatarUrl: input.avatarUrl })
          .where(eq(users.id, userId))
          .returning();
        if (withAvatar) return toUser(withAvatar);
      }
      return toUser(row);
    },

    /** Resolve a friend code (case-insensitive, dashes/spaces ignored). */
    async findByFriendCode(code: string): Promise<User | null> {
      const normalized = normalizeFriendCode(code);
      if (normalized.length === 0) return null;
      const [row] = await db
        .select()
        .from(users)
        .where(eq(users.friendCode, normalized))
        .limit(1);
      return row ? toUser(row) : null;
    },

    async updateProfile(id: UserId, input: UpdateProfileInput): Promise<User | null> {
      const patch: Partial<typeof users.$inferInsert> = {};
      if (input.displayName !== undefined) patch.displayName = input.displayName;
      if (input.avatarUrl !== undefined) patch.avatarUrl = input.avatarUrl;
      if (input.bio !== undefined) patch.bio = input.bio;
      if (input.bannerUrl !== undefined) patch.bannerUrl = input.bannerUrl;
      if (input.birthdate !== undefined) patch.birthdate = input.birthdate;
      if (Object.keys(patch).length === 0) return this.findById(id);
      const [row] = await db.update(users).set(patch).where(eq(users.id, id)).returning();
      return row ? toUser(row) : null;
    },

    /**
     * Set or CLEAR the user's custom status (M18). `text: null` (or a blank
     * string, which the API normalizes to null) clears both columns together —
     * an expiry without a status is meaningless. Returns the updated public
     * record (which already has the expiry applied by the mapper), or null when
     * the user no longer exists.
     */
    async setCustomStatus(
      userId: UserId,
      input: { text: string | null; expiresAt: Date | null },
    ): Promise<User | null> {
      const clearing = input.text === null || input.text.trim().length === 0;
      const [row] = await db
        .update(users)
        .set({
          customStatus: clearing ? null : input.text,
          customStatusExpiresAt: clearing ? null : input.expiresAt,
        })
        .where(eq(users.id, userId))
        .returning();
      return row ? toUser(row) : null;
    },

    /**
     * BATCHED custom-status read (M18) for the gateway's `auth.succeeded`
     * presence snapshot: one `WHERE id IN (…)` for the whole audience instead of
     * one query per peer (§27). Only users with a LIVE status appear in the map
     * (`toUser` applies the expiry), so a caller reads `map.get(id) ?? null`.
     */
    async customStatusesFor(userIds: UserId[]): Promise<Map<UserId, string>> {
      const ids = [...new Set(userIds)];
      const statuses = new Map<UserId, string>();
      if (ids.length === 0) return statuses;
      const rows = await db.select().from(users).where(inArray(users.id, ids));
      for (const row of rows) {
        const status = toUser(row).customStatus;
        if (status) statuses.set(row.id, status);
      }
      return statuses;
    },

    /**
     * Mint a new unique friend code for the user, invalidating the old one
     * (ADR 0010 §2). Returns the updated self record (with the new code), or
     * null if the user no longer exists.
     */
    async regenerateFriendCode(userId: UserId): Promise<User | null> {
      for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt++) {
        try {
          const [row] = await db
            .update(users)
            .set({ friendCode: generateFriendCode() })
            .where(eq(users.id, userId))
            .returning();
          return row ? toSelfUser(row) : null;
        } catch (err) {
          if (isFriendCodeCollision(err)) continue;
          throw err;
        }
      }
      throw new Error("could not generate a unique friend code");
    },

    /**
     * Soft-delete (freeze) an account (M15). Sets `deleted_at = now` and
     * `purge_at = now + ACCOUNT_FREEZE_DAYS`, so the account is hidden everywhere
     * (auth join + member/search reads exclude `deleted_at IS NOT NULL`) but is
     * still recoverable via {@link reactivate} until the purge deadline. Idempotent:
     * calling it again refreshes the window. The CALLER is responsible for revoking
     * the user's sessions (this only stamps the row). Returns the two ISO instants,
     * or null when the user no longer exists.
     */
    async softDelete(
      userId: UserId,
      opts: { now?: Date; freezeDays?: number } = {},
    ): Promise<{ deletedAt: string; purgeAt: string } | null> {
      const now = opts.now ?? new Date();
      const purgeAt = new Date(
        now.getTime() + (opts.freezeDays ?? ACCOUNT_FREEZE_DAYS) * 24 * 60 * 60 * 1000,
      );
      const [row] = await db
        .update(users)
        .set({ deletedAt: now, purgeAt })
        .where(eq(users.id, userId))
        .returning({ deletedAt: users.deletedAt, purgeAt: users.purgeAt });
      if (!row || !row.deletedAt || !row.purgeAt) return null;
      return { deletedAt: row.deletedAt.toISOString(), purgeAt: row.purgeAt.toISOString() };
    },

    /**
     * Reactivate a frozen account (M15) — clears `deleted_at`/`purge_at` so the
     * account is live again. Called from the login path when a frozen user signs in
     * within the window and confirms reactivation. Returns true when a frozen row
     * was restored; false when the user was not frozen / does not exist.
     */
    async reactivate(userId: UserId): Promise<boolean> {
      const rows = await db
        .update(users)
        .set({ deletedAt: null, purgeAt: null })
        .where(and(eq(users.id, userId), isNotNull(users.deletedAt)))
        .returning({ id: users.id });
      return rows.length > 0;
    },

    /**
     * Hard-purge job (M15): ANONYMIZE every account whose `purge_at` has elapsed.
     *
     * A true row DELETE is intentionally NOT used: `messages.author_id` and
     * `friend_groups.owner_id` reference `users.id` with ON DELETE NO ACTION
     * (RESTRICT), so deleting a user who ever sent a message or owns a server would
     * either fail or (if those FKs cascaded) destroy shared history and whole
     * servers other members still use. Anonymization scrubs ALL personal data —
     * username, display name, avatar/banner, bio, birthdate, email, Google link,
     * password hash — and regenerates the friend code, so the person is
     * unrecoverable and unfindable while their authored rows keep referential
     * integrity as a "Deleted User" tombstone. `deleted_at`
     * stays set (the row remains hidden everywhere); `purge_at` is cleared so the
     * job never reprocesses it. Returns how many accounts were purged this tick.
     *
     * NB: this is a founder-facing interpretation of "destroy after 14 days"
     * (personal data destroyed, tombstone kept). See the handoff note.
     */
    async purgeExpired(now: Date = new Date()): Promise<number> {
      const expired = await db
        .select({ id: users.id })
        .from(users)
        .where(and(isNotNull(users.purgeAt), lte(users.purgeAt, now)));
      let purged = 0;
      for (const { id } of expired) {
        const compact = id.replace(/-/g, "");
        await db
          .update(users)
          .set({
            username: `deleted_${compact}`,
            displayName: "Deleted User",
            avatarUrl: null,
            bannerUrl: null,
            bio: null,
            birthdate: null,
            email: null,
            googleSub: null,
            passwordHash: null,
            friendCode: `DEL_${compact}`,
            purgeAt: null,
          })
          .where(eq(users.id, id));
        // Sessions were already revoked at soft-delete, and the frozen-login gate
        // prevents new ones, so there is nothing left to authenticate; the
        // scrubbed row also stays hidden via `deleted_at IS NOT NULL`.
        purged += 1;
      }
      return purged;
    },

    /**
     * Context-aware profile card (ADR 0010 §3). `friendship` is the viewer→
     * target relationship; `roles` is populated ONLY when `groupId` names a
     * `kind='server'` space that BOTH users belong to — otherwise it is omitted,
     * so a stranger's card (or a server the viewer is not in) never leaks roles.
     * Returns null if the target user does not exist.
     */
    async getProfile(
      viewerId: UserId,
      targetId: UserId,
      groupId?: GroupId,
    ): Promise<UserProfile | null> {
      const [targetRow] = await db
        .select()
        .from(users)
        .where(eq(users.id, targetId))
        .limit(1);
      if (!targetRow) return null;

      let friendship: ProfileFriendshipStatus = "none";
      if (viewerId !== targetId) {
        const [a, b] =
          viewerId < targetId ? [viewerId, targetId] : [targetId, viewerId];
        const [row] = await db
          .select()
          .from(friendships)
          .where(and(eq(friendships.userA, a), eq(friendships.userB, b)))
          .limit(1);
        if (row) {
          friendship =
            row.status === "accepted"
              ? "friends"
              : row.requestedBy === viewerId
                ? "outgoing"
                : "incoming";
        }
      }

      const profile: UserProfile = { user: toUser(targetRow), friendship };

      // Block flag (M18) — ONE direction only: "have I blocked them", never
      // "have they blocked me". Telling someone they are blocked is exactly the
      // information a block withholds (§28), so the reverse row is never read
      // here. Only meaningful on another user's card.
      if (viewerId !== targetId) {
        const [blockRow] = await db
          .select({ blockerId: userBlocks.blockerId })
          .from(userBlocks)
          .where(
            and(eq(userBlocks.blockerId, viewerId), eq(userBlocks.blockedId, targetId)),
          )
          .limit(1);
        profile.blocked = blockRow !== undefined;
      }

      // Mutual servers — the `kind='server'` spaces BOTH users belong to. Only
      // ever computed for ANOTHER user's card (you are not "mutual" with
      // yourself), and in ONE round trip: a self-join of `friend_group_members`
      // (viewer's row ⋈ target's row on the same group) against the server rows.
      // A minimal id/name/icon projection — never the target's per-server data.
      if (viewerId !== targetId) {
        const viewerMember = alias(friendGroupMembers, "mutual_viewer");
        const targetMember = alias(friendGroupMembers, "mutual_target");
        const mutualRows = await db
          .select({
            id: friendGroups.id,
            name: friendGroups.name,
            iconUrl: friendGroups.iconUrl,
          })
          .from(friendGroups)
          .innerJoin(
            viewerMember,
            and(
              eq(viewerMember.groupId, friendGroups.id),
              eq(viewerMember.userId, viewerId),
            ),
          )
          .innerJoin(
            targetMember,
            and(
              eq(targetMember.groupId, friendGroups.id),
              eq(targetMember.userId, targetId),
            ),
          )
          .where(eq(friendGroups.kind, "server"))
          .orderBy(asc(friendGroups.name), asc(friendGroups.createdAt));
        profile.mutualServers = mutualRows.map(
          (r): MutualServer => ({ id: r.id, name: r.name, iconUrl: r.iconUrl }),
        );
      }

      if (groupId !== undefined) {
        const [server] = await db
          .select({ id: friendGroups.id })
          .from(friendGroups)
          .where(and(eq(friendGroups.id, groupId), eq(friendGroups.kind, "server")))
          .limit(1);
        if (server) {
          const memberRows = await db
            .select({ userId: friendGroupMembers.userId })
            .from(friendGroupMembers)
            .where(
              and(
                eq(friendGroupMembers.groupId, groupId),
                inArray(friendGroupMembers.userId, [viewerId, targetId]),
              ),
            );
          const members = new Set(memberRows.map((r) => r.userId));
          if (members.has(viewerId) && members.has(targetId)) {
            const roleRows = await db
              .select({ role: roles })
              .from(memberRoles)
              .innerJoin(roles, eq(roles.id, memberRoles.roleId))
              .where(
                and(eq(memberRoles.groupId, groupId), eq(memberRoles.userId, targetId)),
              )
              .orderBy(asc(roles.position), asc(roles.createdAt));
            profile.roles = roleRows.map((r) => toRole(r.role));
          }
        }
      }

      return profile;
    },
  };
}

export type UsersRepo = ReturnType<typeof usersRepo>;
