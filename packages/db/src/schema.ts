/**
 * Drizzle schema — MVP tables per CLAUDE.md §25.
 * Column shapes mirror the domain types in @demli/types; repositories map
 * rows to those types (timestamps become ISO strings at the boundary).
 */

import { sql, type SQL } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

/**
 * Postgres `tsvector` — the full-text search type (migration 0012, ADR 0011 §5).
 * drizzle has no first-class tsvector, so this thin `customType` teaches the ORM
 * the column type. The value is never read into a DTO (the search path only ever
 * matches it with `@@`), so `data: string` is a nominal placeholder.
 */
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export const memberRoleEnum = pgEnum("member_role", ["owner", "member", "guest"]);
export const channelKindEnum = pgEnum("channel_kind", ["text", "voice"]);
/**
 * "dm" is type-level ahead of the database: migration 0007 (ADR 0010, W1b)
 * adds the enum value via `ALTER TYPE ... ADD VALUE 'dm'`. Nothing constructs
 * a `kind='dm'` row before the W2 social API lands, so the window is inert —
 * this keeps repositories compiling against the widened domain
 * `FriendGroupKind` ("server" | "group" | "dm").
 */
export const friendGroupKindEnum = pgEnum("friend_group_kind", ["server", "group", "dm"]);
/**
 * Who may create invites for a server (M9, ADR 0007). "members" is the
 * pre-M9 behavior (owner + members). "roles" restricts creation to the owner
 * and holders of the CREATE_INVITE permission bit.
 */
export const invitePolicyEnum = pgEnum("invite_policy", ["members", "roles"]);
/**
 * Lifecycle of a `friendships` row (ADR 0010 §2). "pending" = request sent,
 * awaiting the addressee; "accepted" = both consented. Decline/cancel/unfriend
 * DELETE the row — there is no "declined"/"removed" value. Blocking, when it
 * lands, is a separate directional `user_blocks` table, never a third value.
 */
export const friendshipStatusEnum = pgEnum("friendship_status", ["pending", "accepted"]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    username: text("username").notNull(),
    displayName: text("display_name").notNull(),
    avatarUrl: text("avatar_url"),
    /**
     * NULLABLE since 0010 (Google OAuth groundwork). A username+password user
     * always has a hash; a Google-only user has `null` here (no password to
     * verify) and authenticates via {@link googleSub}. Auth call sites MUST treat
     * null as "password login not available for this account" — never pass null
     * to argon2.verify. Existing rows keep their hash (additive/back-compatible).
     */
    passwordHash: text("password_hash"),
    /**
     * Verified email (0010, Google OAuth). NULL for the pre-existing
     * username+password users (they never supplied one) and for any account that
     * has not linked Google. Set from Google's `email` claim (only when
     * `email_verified` is true). Case-insensitively UNIQUE via the expression
     * index below, so `lower(email)` collides across differing letter case.
     * Server-side only — never emitted on the wire (login/register never returned
     * it and the response shape must not change).
     */
    email: text("email"),
    /**
     * Google's stable subject id (0010, the `sub` claim) — unique per Google
     * account, never reused, and the primary key for a linked identity. NULL
     * until an account links Google. UNIQUE (multiple NULLs allowed). Server-side
     * only, never on the wire.
     */
    googleSub: text("google_sub"),
    /**
     * Short self-description on the profile card (ADR 0010 §3). ≤280 chars,
     * plain text, escaped like message content at the API boundary. Null when
     * unset; the mapper always emits it.
     */
    bio: text("bio"),
    /**
     * Renewable friend code (ADR 0010 §2): 8 chars of the invite base32
     * alphabet, stored uppercase, unique, looked up case-insensitively. The
     * repository generates it (collision-retry) at user creation — never null
     * for a row created through `usersRepo.create`. Present on the wire ONLY for
     * the caller's own `/users/me` record; the protocol `userSchema` strips it
     * for every other user (leak guard, ADR 0010 §6).
     */
    friendCode: text("friend_code").notNull(),
    /**
     * Profile banner image URL (M15). PUBLIC (served by a stable public bucket
     * URL like {@link avatarUrl}); the mapper emits it on every user. Null for
     * every pre-M15 row and any account that never set one. Additive/back-compat.
     */
    bannerUrl: text("banner_url"),
    /**
     * Date of birth (M15). NULLABLE — every pre-M15 account stays null, and the
     * derived `isAdult` gate treats null as "not an adult" (conservative). Stored
     * as a SQL `date` (no time/zone); mode "string" so the row carries an ISO
     * `YYYY-MM-DD` string end-to-end, matching {@link User.birthdate}. ME-ONLY on
     * the wire: only `/users/me` (`toSelfUser`) ever emits it.
     */
    birthdate: date("birthdate", { mode: "string" }),
    /**
     * Soft-delete instant (M15 account deletion). NULL = active. Set on
     * `POST /users/me/delete`, which also revokes every session, so a frozen
     * account cannot authenticate; the auth join + member/search reads exclude
     * `deleted_at IS NOT NULL` rows so a frozen user vanishes everywhere. Cleared
     * on reactivation (login within the {@link purgeAt} window). Additive.
     */
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
    /**
     * Hard-purge deadline (M15): `deleted_at + 14 days`. The hourly purge job
     * anonymizes accounts whose `purge_at` has elapsed (scrubs PII, keeps a
     * tombstone row so authored messages / owned servers keep referential
     * integrity — see the purge job). NULL while active or after a purge has run.
     */
    purgeAt: timestamp("purge_at", { withTimezone: true, mode: "date" }),
    /**
     * Free-text "custom status" line (M18), ≤128 chars, PLAIN TEXT. Stored raw
     * and escaped like message content at render time (§28). NULL = unset, which
     * is every pre-M18 row (additive/back-compatible). Cleared by writing NULL.
     */
    customStatus: text("custom_status"),
    /**
     * Auto-expiry for {@link customStatus} (M18): "for 30 minutes" / "today".
     * NULL = indefinite. An ELAPSED value is treated as "no status" by the mapper,
     * so a stale line never reaches the wire even before anything sweeps the row.
     */
    customStatusExpiresAt: timestamp("custom_status_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    usernameUnique: uniqueIndex("users_username_unique").on(t.username),
    friendCodeUnique: uniqueIndex("users_friend_code_unique").on(t.friendCode),
    /**
     * Case-insensitive email uniqueness (0010). Expression index on `lower(email)`
     * so `Ada@x.com` and `ada@x.com` collide. NULL emails are distinct under a
     * unique index, so the many rows without an email are unconstrained.
     */
    emailLowerUnique: uniqueIndex("users_email_lower_unique").on(sql`lower(${t.email})`),
    /** One account per Google identity (0010). Multiple NULLs allowed. */
    googleSubUnique: uniqueIndex("users_google_sub_unique").on(t.googleSub),
  }),
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 hex of the opaque bearer token; the raw token is never stored. */
    tokenHash: text("token_hash").notNull(),
    /**
     * Human-readable device label (M15-A) shown in the "active sessions" list —
     * a CLIENT DECLARATION, not server-derived (e.g. "Windows · Electron",
     * "Pixel 7"). Nullable: pre-M15 rows and any client that omits it stay null.
     * Escaped like other user content at the API boundary (§28); the client caps
     * length before sending and the API re-caps it.
     */
    deviceName: text("device_name"),
    /**
     * Client surface this session was issued to (M15-A). Plain `text` with a
     * TYPE-LEVEL enum (like `messages.kind` / `device_tokens.platform`), never a
     * pg enum — keeps migration 0014 a pure additive `ADD COLUMN` with no
     * `CREATE TYPE`. Null for pre-M15 rows and clients that do not declare it.
     */
    platform: text("platform", { enum: ["desktop", "mobile"] }),
    /**
     * Last time a request authenticated with this session's token (M15-A).
     * Defaults to the issue instant and is bumped by the auth middleware at most
     * once per throttle window, so the hot path stays cheap (§27). Drives the
     * "last active" column and the newest-active-first ordering of the list.
     */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => ({
    tokenHashUnique: uniqueIndex("sessions_token_hash_unique").on(t.tokenHash),
    userIdIdx: index("sessions_user_id_idx").on(t.userId),
  }),
);

export const friendGroups = pgTable(
  "friend_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    iconUrl: text("icon_url"),
    /**
     * Server banner image URL (M20). PUBLIC — served by a stable URL from the
     * same public avatar bucket the profile banner uses, stored under
     * `group-banners/<groupId>/…`. Null = no banner, which is every pre-0022 row
     * and stays a first-class state: the sidebar header renders exactly as it did
     * before rather than showing an empty box (§35).
     *
     * Servers only in practice (the upload route is server-kind + owner-only);
     * meaningless for kind='group'/'dm' rows, which have no settings screen that
     * could set it.
     */
    bannerUrl: text("banner_url"),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    /**
     * "server" = multi-channel space (default; every pre-existing row).
     * "group"  = flat chat owning exactly one hidden text channel (its stream).
     */
    kind: friendGroupKindEnum("kind").notNull().default("server"),
    /**
     * Servers only: the text channel that receives system messages (member
     * joined/left). Set automatically to the server's FIRST text channel on
     * creation; the owner can re-point or clear it (null = feature off).
     * Deleting the channel clears it via ON DELETE SET NULL. Always null for
     * kind='group' rows. Lazy AnyPgColumn callback breaks the circular
     * friend_groups ↔ channels type reference.
     */
    systemChannelId: uuid("system_channel_id").references(
      (): AnyPgColumn => channels.id,
      { onDelete: "set null" },
    ),
    /**
     * Servers only: who may create invites (M9, ADR 0007). Defaults to
     * "members" so every pre-M9 row keeps its exact behavior. Meaningless for
     * kind='group' rows (flat chats have no invite editor).
     */
    invitePolicy: invitePolicyEnum("invite_policy").notNull().default("members"),
    /**
     * DMs only (kind='dm', ADR 0010 §1): canonical unordered-pair key
     * `least(a,b) || ':' || greatest(a,b)` of the two member ids. Null for
     * server/group rows. The partial unique index below enforces "one DM per
     * pair". Keyed on `dm_key IS NOT NULL` rather than `kind='dm'` on purpose:
     * migration 0007 adds the 'dm' enum value in the SAME transaction it builds
     * this index, and Postgres forbids USING a freshly-added enum value in its
     * own transaction. `dm_key IS NOT NULL` is an equivalent predicate (dm_key
     * is set iff kind='dm') that never references the enum literal. See
     * .claude/reports/social-db-w1b.md.
     */
    dmKey: text("dm_key"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    kindIdx: index("friend_groups_kind_idx").on(t.kind),
    dmKeyUnique: uniqueIndex("friend_groups_dm_key_unique")
      .on(t.dmKey)
      .where(sql`${t.dmKey} is not null`),
  }),
);

export const friendGroupMembers = pgTable(
  "friend_group_members",
  {
    groupId: uuid("group_id")
      .notNull()
      .references(() => friendGroups.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRoleEnum("role").notNull().default("member"),
    /**
     * DM "close" = hide-for-self (ADR 0010 §1), meaningful for kind='dm' rows
     * only. Setting it drops the DM from THIS member's `/dms` list; the
     * counterpart's row is untouched, so their copy and the full history
     * survive. A new inbound message or re-opening via the profile clears it.
     * Null for server/group memberships.
     */
    hiddenAt: timestamp("hidden_at", { withTimezone: true, mode: "date" }),
    /**
     * Per-server nickname (migration 0020, ADR 0019) — the PUBLIC one: everyone
     * in this server sees it in place of the user's display name. NULL ⇒ fall
     * back to `users.display_name`.
     *
     * Deliberately NOT the same thing as `user_nicknames`, which is the PRIVATE
     * per-viewer nickname only its author ever sees. Two columns in two tables
     * because they are two different products (ADR 0019 §2); merging them would
     * turn one user's private label into a whole server's public one.
     */
    nickname: text("nickname"),
    /**
     * Timeout (mute) expiry (migration 0020, ADR 0019). A member is timed out
     * while this is in the FUTURE; NULL or a past value means they are not.
     *
     * Expiry is evaluated at QUERY time (`timed_out_until > now()`), so nothing
     * has to run when a timeout ends — no sweeper, no cron, no restart hazard,
     * and no window in which a lapsed timeout is still enforced. Enforced
     * server-side on message send (BOTH transports), reaction add, and
     * voice-token mint.
     */
    timedOutUntil: timestamp("timed_out_until", { withTimezone: true, mode: "date" }),
    joinedAt: timestamp("joined_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.groupId, t.userId] }),
    userIdIdx: index("friend_group_members_user_id_idx").on(t.userId),
  }),
);

export const channels = pgTable(
  "channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => friendGroups.id, { onDelete: "cascade" }),
    kind: channelKindEnum("kind").notNull(),
    name: text("name").notNull(),
    /** Optional topic/description; null when unset. */
    description: text("description"),
    /**
     * Age-restricted (NSFW) channel flag (M15). Default false so
     * every pre-M15 channel stays a normal channel. When false, image
     * attachments are NSFW-screened by the media moderation seam on upload; when
     * true, they are allowed through (an NSFW channel is where such media belongs).
     */
    nsfw: boolean("nsfw").notNull().default(false),
    /** Voice channels only: soft cap on concurrent participants; null = no cap. */
    maxParticipants: integer("max_participants"),
    /**
     * Text channels only: minimum seconds between messages per non-owner
     * member (0 = off). Enforced in Redis at send time; owners are exempt.
     */
    slowmodeSeconds: integer("slowmode_seconds").notNull().default(0),
    /** Voice channels only: preferred audio bitrate in kbps; null = default. */
    audioBitrateKbps: integer("audio_bitrate_kbps"),
    /**
     * Voice channels only: an explicit LiveKit room name override (ADR 0012 §6).
     * NULL ⇒ the room IS the channel id (every pre-existing voice channel is
     * unchanged; `POST /media/token` resolves `room = livekitRoom ?? id`). The
     * DM-call upgrade sets this to the ongoing call's ephemeral room
     * (`dmcall:<callId>`) so the group's new voice channel lands the third person
     * in the LIVE call and the two originals never reconnect. One nullable column
     * is the entire cost of "a voice channel's room may be an explicit name."
     */
    livekitRoom: text("livekit_room"),
    position: integer("position").notNull().default(0),
    /**
     * Sidebar category this channel is filed under (M18), or NULL for an
     * UNCATEGORIZED channel — which keeps rendering in the top-level list exactly
     * as before, so every pre-M18 row is unaffected. ON DELETE SET NULL: deleting
     * a category never deletes its channels, they simply fall back to
     * uncategorized. Lazy `AnyPgColumn` callback because
     * {@link channelCategories} is declared later in this file.
     */
    categoryId: uuid("category_id").references(
      (): AnyPgColumn => channelCategories.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    groupIdIdx: index("channels_group_id_idx").on(t.groupId),
    /** Sidebar read path: "this category's channels, in order". */
    categoryIdIdx: index("channels_category_id_idx").on(t.categoryId),
    /**
     * Composite-FK target for channel_role_access (M9): guarantees a role and
     * the channel it restricts belong to the SAME group. `id` is already the
     * PK; this pair makes (id, group_id) referenceable.
     */
    idGroupUnique: unique("channels_id_group_id_unique").on(t.id, t.groupId),
  }),
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    content: text("content").notNull(),
    /**
     * "user"   = a regular message typed by a person (default).
     * "system" = server-generated notice (member joined/left) written to the
     *            group's system channel; authorId is the affected user.
     */
    kind: text("kind", { enum: ["user", "system"] })
      .notNull()
      .default("user"),
    /**
     * Client-generated idempotency key per send. Lets a retried `message.send`
     * (after a lost `message.created` echo) resolve to the ORIGINAL row instead
     * of inserting a duplicate. Null for server/seed-originated rows.
     */
    nonce: text("nonce"),
    /**
     * The message this one replies to (ADR 0011 §2, M14). Nullable self-FK: null
     * for the 99% of messages that reply to nothing. `ON DELETE SET NULL` is the
     * safety net for a genuine hard row removal — the common path is a
     * SOFT-deleted target (row kept, `deleted_at` set), which the reply-preview
     * builder detects and renders as a "deleted" stub. Set at send, never changed.
     * Lazy `AnyPgColumn` thunk breaks the self-reference cycle.
     */
    replyToMessageId: uuid("reply_to_message_id").references(
      (): AnyPgColumn => messages.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
    /**
     * Full-text search vector (migration 0012, ADR 0011 §5). A STORED generated
     * column derived from `content` with the language-agnostic `simple` config —
     * no stemming, because Postgres ships no Turkish dictionary and channels mix
     * TR/EN. Because it is `GENERATED ALWAYS`, drizzle omits it from inserts and
     * every existing row auto-populates on migrate; nothing writes it directly.
     * The search repo only ever matches it (`@@`), never selects it into a DTO.
     */
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      (): SQL => sql`to_tsvector('simple', ${messages.content})`,
    ),
  },
  (t) => ({
    /** Supports newest-first cursor pagination per channel. */
    channelCreatedIdx: index("messages_channel_created_id_idx").on(
      t.channelId,
      t.createdAt,
      t.id,
    ),
    /**
     * Idempotency guard: at most one message per (author, nonce). Partial so
     * that null-nonce rows (seed/server) are never constrained. The gateway's
     * upsert relies on this index to dedupe retried sends at the source.
     */
    authorNonceUnique: uniqueIndex("messages_author_nonce_unique")
      .on(t.authorId, t.nonce)
      .where(sql`${t.nonce} IS NOT NULL`),
    /**
     * Cheap `ON DELETE SET NULL` referrer lookup when a quoted message is
     * hard-deleted. Partial — indexes only the rare reply rows, not the 99% that
     * reply to nothing (ADR 0011 §2).
     */
    replyToIdx: index("messages_reply_to_idx")
      .on(t.replyToMessageId)
      .where(sql`${t.replyToMessageId} IS NOT NULL`),
    /**
     * GIN index over the full-text vector (migration 0012, ADR 0011 §5) — makes
     * `search_vector @@ websearch_to_tsquery('simple', q)` an index scan for the
     * channel-scoped message search endpoint.
     */
    searchVectorIdx: index("messages_search_vector_idx").using("gin", t.searchVector),
  }),
);

export const invites = pgTable(
  "invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => friendGroups.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    maxUses: integer("max_uses"),
    useCount: integer("use_count").notNull().default(0),
    /**
     * Channel this invite lands the joiner on (migration 0021), or NULL for a
     * plain server invite — which every pre-0021 row is, so the column is a
     * no-op for existing data.
     *
     * `ON DELETE SET NULL` is the whole point: deleting the channel must NOT
     * delete the invite. A link already shared in a chat keeps working and
     * simply degrades to "join the server" instead of 404-ing people who click
     * it. Cascade would have made channel deletion silently revoke invites.
     *
     * Only meaningful for `kind='server'` groups; a flat group chat has no
     * channel picker and never sets it.
     */
    targetChannelId: uuid("target_channel_id").references(() => channels.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    codeUnique: uniqueIndex("invites_code_unique").on(t.code),
    groupIdIdx: index("invites_group_id_idx").on(t.groupId),
    /**
     * Backs the `ON DELETE SET NULL` sweep when a channel is removed — without
     * it Postgres seq-scans `invites` on every channel delete.
     */
    targetChannelIdx: index("invites_target_channel_id_idx")
      .on(t.targetChannelId)
      .where(sql`${t.targetChannelId} IS NOT NULL`),
  }),
);

export const devicePreferences = pgTable("device_preferences", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  inputDeviceId: text("input_device_id"),
  outputDeviceId: text("output_device_id"),
  inputVolume: integer("input_volume").notNull().default(100),
  outputVolume: integer("output_volume").notNull().default(100),
});

/* ---------------------------------------------------------------------------
 * M9 — Roles & permissions (ADR 0007). Server-scoped only; the additive layer
 * on top of the member enum. A server with zero roles behaves exactly as pre-M9.
 * ------------------------------------------------------------------------- */

export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => friendGroups.id, { onDelete: "cascade" }),
    /** 1..32 chars, validated at the API boundary. */
    name: text("name").notNull(),
    /** '#rrggbb' or null. Highest-positioned colored role colors a member's name. */
    color: text("color"),
    /** Display order only (no permission hierarchy in the MVP). */
    position: integer("position").notNull().default(0),
    /**
     * PERMISSIONS bitfield (ADR 0007). Effective perms = bitwise OR of a
     * member's roles. `bigint` for headroom; JS numbers are exact to 53 bits,
     * so `{ mode: "number" }` is safe for our handful of flags.
     */
    permissions: bigint("permissions", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    groupIdIdx: index("roles_group_id_idx").on(t.groupId),
    /** Composite-FK target so assignments/access rows can pin (role, group). */
    idGroupUnique: unique("roles_id_group_id_unique").on(t.id, t.groupId),
  }),
);

/**
 * Role assignments. The two composite FKs are the load-bearing invariant:
 * - (group_id, user_id) → friend_group_members  ⇒ leaving a server removes all
 *   assignments; a role can only be assigned to an actual member.
 * - (role_id, group_id) → roles(id, group_id)    ⇒ deleting a role removes all
 *   assignments, and a role can NEVER be assigned across servers.
 */
export const memberRoles = pgTable(
  "member_roles",
  {
    groupId: uuid("group_id").notNull(),
    userId: uuid("user_id").notNull(),
    roleId: uuid("role_id").notNull(),
    assignedAt: timestamp("assigned_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.roleId, t.userId] }),
    groupUserIdx: index("member_roles_group_user_idx").on(t.groupId, t.userId),
    memberFk: foreignKey({
      columns: [t.groupId, t.userId],
      foreignColumns: [friendGroupMembers.groupId, friendGroupMembers.userId],
      name: "member_roles_group_user_fk",
    }).onDelete("cascade"),
    roleFk: foreignKey({
      columns: [t.roleId, t.groupId],
      foreignColumns: [roles.id, roles.groupId],
      name: "member_roles_role_group_fk",
    }).onDelete("cascade"),
  }),
);

/**
 * Channel visibility. No rows for a channel = public to all members (today's
 * behavior). ≥1 row = restricted: visible only to the owner and members holding
 * at least one listed role. Composite FKs keep channel and role in the same
 * group and cascade-clean on channel/role deletion.
 */
export const channelRoleAccess = pgTable(
  "channel_role_access",
  {
    channelId: uuid("channel_id").notNull(),
    roleId: uuid("role_id").notNull(),
    groupId: uuid("group_id").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.channelId, t.roleId] }),
    roleIdx: index("channel_role_access_role_idx").on(t.roleId),
    channelFk: foreignKey({
      columns: [t.channelId, t.groupId],
      foreignColumns: [channels.id, channels.groupId],
      name: "channel_role_access_channel_group_fk",
    }).onDelete("cascade"),
    roleFk: foreignKey({
      columns: [t.roleId, t.groupId],
      foreignColumns: [roles.id, roles.groupId],
      name: "channel_role_access_role_group_fk",
    }).onDelete("cascade"),
  }),
);

/* ---------------------------------------------------------------------------
 * Server moderation — bans (migration 0017). The ban list: one row per
 * (group, user) permanently barring that user from a server (`kind='server'`
 * only). The invite-redeem path re-checks this table inside its transaction and
 * refuses a banned user, so a ban survives kicks, invites, and re-joins (§28).
 *
 * The composite (group_id, user_id) PRIMARY KEY is the idempotency guard: banning
 * an already-banned user upserts (refreshes reason/moderator) with no duplicate.
 *
 * FK behavior mirrors the rest of the schema:
 *  - group_id → friend_groups ON DELETE CASCADE: deleting a server reaps its bans.
 *  - user_id  → users        ON DELETE CASCADE: deleting the user reaps their bans.
 *  - banned_by → users       ON DELETE SET NULL: the ban OUTLIVES the moderator's
 *    account (a deleted mod must never lift a ban by disappearing), so this column
 *    is nullable — exactly the pattern `messages.reply_to_message_id` uses.
 * ------------------------------------------------------------------------- */

export const groupBans = pgTable(
  "group_bans",
  {
    groupId: uuid("group_id")
      .notNull()
      .references(() => friendGroups.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The moderator who issued the ban; null once that account is deleted. */
    bannedBy: uuid("banned_by").references(() => users.id, { onDelete: "set null" }),
    /** Optional moderator note, escaped like message content at render (§28). */
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.groupId, t.userId] }),
    /** "is THIS user banned anywhere" reverse lookup + the user_id cascade. */
    userIdIdx: index("group_bans_user_id_idx").on(t.userId),
  }),
);

/* ---------------------------------------------------------------------------
 * M10 — Media attachments (ADR 0008, plan §1). Rows outlive a text-only world:
 * an attachment is created "pending" during the signed-upload window (before it
 * belongs to any message), verified "ready" on upload completion, then linked to
 * a message on send. Read authorization reuses the ADR 0007 channel-visibility
 * check — attachments carry NO ACL of their own.
 * ------------------------------------------------------------------------- */

export const attachmentKindEnum = pgEnum("attachment_kind", ["image", "video", "audio"]);

export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * The message this attachment belongs to. NULL during the upload window
     * (created → uploaded → linked). Hard-deleting the message cascades the row;
     * soft-delete does NOT (the API purges storage objects explicitly). Linkage
     * is tracked SOLELY by this column being null/non-null — see `status`.
     */
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "cascade" }),
    /**
     * Denormalized owning channel. Load-bearing: the row must be authorized (via
     * the ADR 0007 channel check) and cleaned up during the pre-link window when
     * `message_id` is still null. Cascades so deleting a channel also reaps its
     * still-unlinked (orphan) uploads, which are reachable only through here.
     */
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    uploaderId: uuid("uploader_id")
      .notNull()
      .references(() => users.id),
    kind: attachmentKindEnum("kind").notNull(),
    /** Exact whitelisted MIME (server-authoritative, §4). */
    mime: text("mime").notNull(),
    /** Byte size, validated <= the per-kind cap before the row is created. */
    sizeBytes: integer("size_bytes").notNull(),
    /** image/video pixels; null for audio. */
    width: integer("width"),
    height: integer("height"),
    /** audio/video milliseconds; null for image. */
    durationMs: integer("duration_ms"),
    /** True for inline-recorded voice notes; false (default) for file-picked audio. */
    isVoiceMessage: boolean("is_voice_message").notNull().default(false),
    /** Bucket-relative object key (random UUID path); never leaves the API. */
    storagePath: text("storage_path").notNull(),
    /**
     * Upload lifecycle ONLY:
     * - "pending" = row + signed upload URL issued, bytes not yet confirmed.
     * - "ready"   = bytes uploaded and magic-byte verified; attachable to a message.
     * Linkage ("linked") is intentionally NOT a status — it is `message_id IS NOT
     * NULL`, the single source of truth. This drops the plan's redundant third
     * state; see .claude/reports/media-db.md.
     */
    status: text("status", { enum: ["pending", "ready"] })
      .notNull()
      .default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    /** listForMessage / listForMessages lookups + the message_id cascade. */
    messageIdIdx: index("attachments_message_id_idx").on(t.messageId),
    /** channel_id cascade + per-channel orphan cleanup of unlinked rows. */
    channelIdIdx: index("attachments_channel_id_idx").on(t.channelId),
    /**
     * Orphan sweep: unlinked rows past their TTL. Partial (only unlinked rows,
     * which are transient) and ordered by age — exactly `sweepStalePending`'s
     * query. Replaces the plan's generic (status, created_at) since linkage, not
     * status, now selects orphans.
     */
    sweepIdx: index("attachments_sweep_idx")
      .on(t.createdAt)
      .where(sql`${t.messageId} IS NULL`),
    /** One row per stored object; guards accidental duplicate keys. */
    storagePathUnique: uniqueIndex("attachments_storage_path_unique").on(t.storagePath),
  }),
);

/* ---------------------------------------------------------------------------
 * M13 — Friendships (ADR 0010 §2). One row per unordered pair, stored
 * canonically: user_a = LEAST(a,b), user_b = GREATEST(a,b). The CHECK forces
 * that order AND forbids self-friendship in a single constraint. `requested_by`
 * names the side that sent the request — the OTHER side is the addressee and
 * the only one allowed to accept. Blocking is deferred (separate directional
 * table); status is deliberately a two-value enum.
 * ------------------------------------------------------------------------- */

export const friendships = pgTable(
  "friendships",
  {
    userA: uuid("user_a")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    userB: uuid("user_b")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: friendshipStatusEnum("status").notNull(),
    /** Which side sent the request; distinguishes incoming vs outgoing. */
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userA, t.userB] }),
    /** Reverse lookups (user_a leads the PK; user_b needs its own index). */
    userBIdx: index("friendships_user_b_idx").on(t.userB),
    /** Canonical order + no self-friendship, both from one constraint. */
    canonicalOrder: check("friendships_canonical_order", sql`${t.userA} < ${t.userB}`),
  }),
);

/* ---------------------------------------------------------------------------
 * M14 — Message reactions (ADR 0011 §1). One row per (message, user, emoji).
 * The composite PK IS the idempotency guard: adding is `INSERT … ON CONFLICT DO
 * NOTHING`, removing is a keyed `DELETE`, and the count is always `count(*)`
 * grouped by emoji — no counter column to drift under concurrency. The PK leads
 * with `message_id`, so the per-page `WHERE message_id IN (…)` aggregation is an
 * index range scan; no secondary index is needed. `emoji` is plain `text`
 * (canonical unicode from `REACTION_EMOJI`) so a future arbitrary-emoji picker
 * needs no migration. Both FKs cascade: deleting a message OR a user reaps its
 * reactions; a soft-deleted message has its reactions reaped explicitly by
 * `messagesRepo.softDelete`.
 * ------------------------------------------------------------------------- */

export const messageReactions = pgTable(
  "message_reactions",
  {
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Canonical unicode from the REACTION_EMOJI palette (@demli/config). */
    emoji: text("emoji").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.messageId, t.userId, t.emoji] }),
  }),
);

/* ---------------------------------------------------------------------------
 * M17 — Link previews / unfurl (migration 0015). 0..N cards per message (capped
 * at the first few URLs by the unfurl service, not the DB). Written
 * ASYNCHRONOUSLY after the message is created; the send never waits on the
 * SSRF-guarded fetch. Every OG field is nullable — a page may expose only some.
 * `position` preserves the URL's order in the message content so cards render
 * deterministically regardless of which fetch finishes first. The (message_id,
 * url) unique index makes a re-unfurl (retried send → same message) idempotent.
 * FK cascades so deleting a message reaps its embeds; a soft-deleted message's
 * embeds are reaped explicitly by the API on delete.
 * ------------------------------------------------------------------------- */

export const messageEmbeds = pgTable(
  "message_embeds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    /** The exact http(s) URL from the message content this card previews. */
    url: text("url").notNull(),
    title: text("title"),
    description: text("description"),
    imageUrl: text("image_url"),
    siteName: text("site_name"),
    /** Order of the URL within the message content (0-based); stable render order. */
    position: integer("position").notNull().default(0),
    fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    /** listForMessages lookups + the message_id cascade. */
    messageIdIdx: index("message_embeds_message_id_idx").on(t.messageId),
    /** One card per (message, url): a re-unfurl upserts instead of duplicating. */
    messageUrlUnique: uniqueIndex("message_embeds_message_url_unique").on(t.messageId, t.url),
  }),
);

/* ---------------------------------------------------------------------------
 * M17 — Pinned messages (migration 0016). A per-channel pin board: one
 * row per pinned message, so `message_id` is the PRIMARY KEY — a message is
 * pinned or it is not, and `INSERT … ON CONFLICT DO NOTHING` makes pinning
 * idempotent with no counter to drift (the same shape that makes
 * `message_reactions` safe under concurrency).
 *
 * `channel_id` is DENORMALIZED from the message. It is load-bearing twice: the
 * per-channel board is a single index range scan without joining `messages`, and
 * deleting a channel reaps its pins directly (the message cascade would do it
 * too, but only for hard deletes — see below).
 *
 * Both FKs cascade. A hard-deleted message or channel reaps its pin row
 * automatically; a SOFT-deleted message (`deleted_at` set, the common path) does
 * NOT cascade, so the API drops the pin explicitly on delete — a deleted message
 * must never linger on the pin board.
 *
 * There is deliberately NO `message_pins.id`: the pin has no identity of its own,
 * it is an attribute of the (message, channel) pair. Re-pinning after an unpin is
 * a fresh row with a fresh `pinned_at`, which is exactly the desired semantic.
 * ------------------------------------------------------------------------- */

export const messagePins = pgTable(
  "message_pins",
  {
    /** PK: a message is pinned at most once. Cascades on hard message delete. */
    messageId: uuid("message_id")
      .primaryKey()
      .references(() => messages.id, { onDelete: "cascade" }),
    /** Denormalized owning channel — the board query's index prefix. */
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    /** The member who pinned it (kept for the "pinned by X" line). */
    pinnedBy: uuid("pinned_by")
      .notNull()
      .references(() => users.id),
    pinnedAt: timestamp("pinned_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    /**
     * The ENTIRE pin board read: `where channel_id = $1 order by pinned_at desc`
     * is a pure index scan, and the same index serves the `count(*)` that
     * enforces `PINS_MAX_PER_CHANNEL`. Descending so newest-pinned leads without
     * a sort step.
     */
    channelPinnedAtIdx: index("message_pins_channel_pinned_at_idx").on(
      t.channelId,
      t.pinnedAt.desc(),
    ),
  }),
);

/* ---------------------------------------------------------------------------
 * M17 — Custom emoji (migration 0016). Per-group emoji images referenced in
 * message content as `:name:`.
 *
 * `name` is stored ALREADY LOWERCASED by the API (the grammar in
 * @demli/config rejects uppercase outright rather than silently folding it),
 * so the uniqueness index below is a plain column index, not an expression index
 * — `:Cat:` never reaches the database as a distinct row from `:cat:`.
 *
 * Uniqueness is per GROUP, not global: an emoji reference in a message resolves
 * against that message's own group, so two groups may both define `:shrug:` and
 * neither can see the other's. This is what keeps emoji a group asset with no
 * cross-group leak (§28) and no global namespace to squat.
 *
 * `storage_path` is the bucket-relative object key and is UNIQUE (one row per
 * stored object). It never leaves the API — clients render emoji through
 * short-lived signed URLs from the batch emoji-URL endpoint, exactly like
 * attachments (ADR 0008 §2).
 * ------------------------------------------------------------------------- */

export const customEmojis = pgTable(
  "custom_emojis",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => friendGroups.id, { onDelete: "cascade" }),
    /** Lowercased `[a-z0-9_]{2,32}` shortcode; unique within the group. */
    name: text("name").notNull(),
    /** Whitelisted image MIME — `image/png` or `image/webp`. Never SVG (§28). */
    mime: text("mime").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    /** Bucket-relative object key; never leaves the API. */
    storagePath: text("storage_path").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    /**
     * One `:name:` per group + the `list(groupId)` read + the `count(*)` that
     * enforces `CUSTOM_EMOJI_MAX_PER_GROUP`, all from one index (the group_id
     * prefix serves the list; the pair enforces uniqueness).
     */
    groupNameUnique: uniqueIndex("custom_emojis_group_name_unique").on(t.groupId, t.name),
    /** One row per stored object; guards accidental duplicate keys. */
    storagePathUnique: uniqueIndex("custom_emojis_storage_path_unique").on(t.storagePath),
  }),
);

/* ---------------------------------------------------------------------------
 * Task #46 — Mobile push (Expo Push). One row per registered device: a user may
 * have several (phone + tablet). The stored `token` is an Expo push token
 * ("ExponentPushToken[…]"); the API POSTs to the Expo Push service, which bridges
 * to FCM/APNs — no Firebase Admin SDK lives on the server. `platform` is a plain
 * two-value string (not a pg enum: it needs no DB-level constraint and avoids an
 * ALTER TYPE dance), mirroring `messages.kind`.
 *
 * `token` is UNIQUE, not the PK, because a physical device re-installs / hands the
 * same push token to a new account: `upsert` re-binds the row to the new owner and
 * bumps `last_seen_at` (see device-tokens repo). Dead tokens (Expo returns
 * `DeviceNotRegistered`) are DELETEd by the push service. FK cascades so deleting
 * a user reaps their registrations.
 * ------------------------------------------------------------------------- */

export const deviceTokens = pgTable(
  "device_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Expo push token; globally unique (one physical device → one row). */
    token: text("token").notNull(),
    /** Client OS — type-level constraint only, like `messages.kind`. */
    platform: text("platform", { enum: ["ios", "android"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    /** Bumped on every re-register so a token-reap job can prune stale devices. */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    /** Re-register / re-bind conflict target + guards duplicate device rows. */
    tokenUnique: uniqueIndex("device_tokens_token_unique").on(t.token),
    /** Fan-out: "all of this user's devices" for a push. */
    userIdIdx: index("device_tokens_user_id_idx").on(t.userId),
  }),
);

/* ---------------------------------------------------------------------------
 * ADR 0012 — DM calls. One row per call attempt; the control-plane record and
 * the live-call source of truth. A call runs in an EPHEMERAL LiveKit room
 * (`room_name = 'dmcall:<id>'`), NOT a `channels` row — media stays on LiveKit
 * and the single-session registry keys on this opaque string unchanged.
 *
 * `status`/`media` are plain `text` with a TYPE-LEVEL enum (like `messages.kind`
 * / `attachments.status`), never a pg enum. This is deliberate (plan §Wave 1
 * migrator note): the partial unique index below references the status literals
 * `'ringing'`/`'active'` in the SAME migration that creates the table, and a pg
 * enum would trip the single-transaction migrator's "unsafe use of new value"
 * guard. Plain text sidesteps that entirely and needs no `ALTER TYPE` dance.
 * ------------------------------------------------------------------------- */

export const dmCalls = pgTable(
  "dm_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * The DM this call belongs to (a `friend_groups` row, `kind='dm'`). Cascades
     * so deleting the DM reaps its call log. NB: DM membership is NOT proof of a
     * current friendship (a DM survives unfriend) — the mutual-friend gate is
     * re-checked server-side per request, never inferred from this FK.
     */
    dmId: uuid("dm_id")
      .notNull()
      .references(() => friendGroups.id, { onDelete: "cascade" }),
    /** Ephemeral LiveKit room, `dmcall:<id>`. Never a channel id. */
    roomName: text("room_name").notNull(),
    callerId: uuid("caller_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    calleeId: uuid("callee_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Initial intent (`CallMedia`); screen share is an in-call capability. */
    media: text("media", { enum: ["audio", "video"] }).notNull(),
    /**
     * Lifecycle (`CallStatus`). At most one row per DM is live
     * (`ringing`|`active`), enforced by the partial unique index below. Text,
     * not a pg enum — see the table header comment.
     */
    status: text("status", {
      enum: ["ringing", "active", "ended", "missed", "declined", "canceled", "upgraded"],
    })
      .notNull()
      .default("ringing"),
    /**
     * Set only when a third person upgraded the call into a new group (ADR 0012
     * §6). ON DELETE SET NULL: deleting that group keeps the historical call row.
     */
    upgradedToGroupId: uuid("upgraded_to_group_id").references(() => friendGroups.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    /** Ring deadline (`created_at + RING_TIMEOUT`); the accept guard rejects past it. */
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    /** Set on accept (status → active); null while ringing. */
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    /** Set on any terminal outcome; null while live. */
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    /**
     * At most ONE live call per DM (idempotent start; a second start returns the
     * existing call / 409). Partial on the two live statuses only, so terminal
     * rows (the whole call history) are never constrained. Predicate uses the
     * status LITERALS — safe because `status` is plain text, not a fresh enum.
     */
    oneLivePerDm: uniqueIndex("dm_calls_one_live_per_dm")
      .on(t.dmId)
      .where(sql`${t.status} in ('ringing', 'active')`),
    /** Per-DM call history, newest first (inline call log in the DM). */
    dmCreatedIdx: index("dm_calls_dm_id_created_at").on(t.dmId, t.createdAt.desc()),
    /**
     * "Which call is this USER in right now?" — the call-plane state resync
     * (`GET /dm-calls/active`, migration 0023). Two partial indexes because the
     * predicate is `caller_id = $1 OR callee_id = $1` and one btree cannot serve
     * an OR across two columns; Postgres bitmap-ors them.
     *
     * PARTIAL on the live statuses on purpose: live rows are a handful at any
     * instant while the call LOG grows forever, so these stay tiny and cheap to
     * maintain even though the endpoint is hit on every socket (re)connect.
     */
    liveCallerIdx: index("dm_calls_live_caller_id")
      .on(t.callerId)
      .where(sql`${t.status} in ('ringing', 'active')`),
    liveCalleeIdx: index("dm_calls_live_callee_id")
      .on(t.calleeId)
      .where(sql`${t.status} in ('ringing', 'active')`),
  }),
);

/* ---------------------------------------------------------------------------
 * Notification mutes (migration 0013). "Kanalı Sustur" / "Sunucuyu Sustur":
 * a per-user silence on ONE channel (`scope='channel'`, `target_id` = channels
 * id) or a whole server / group chat / DM (`scope='group'`, `target_id` =
 * friend_groups id). One row per (user, scope, target) — the composite PK — so
 * setting a mute UPSERTs and unmuting DELETEs.
 *
 * `target_id` is POLYMORPHIC (a channel id OR a friend_group id depending on
 * `scope`), so it carries NO foreign key — a single column cannot reference two
 * tables. A deleted channel/group therefore leaves a harmless orphan row: the
 * push filter simply never matches it and `listForUser` results the client does
 * not recognize are ignored. `ON DELETE CASCADE` on `user_id` still reaps a
 * deleted user's mutes.
 *
 * `scope`/`mode` are plain `text` with a TYPE-LEVEL enum (like `messages.kind`,
 * `dm_calls.status`), never a pg enum — keeps migration 0013 a single additive
 * `CREATE TABLE` with no `CREATE TYPE`, matching the dm_calls precedent.
 *
 * `until` is the auto-expiry instant (the 15m/1h/8h presets); NULL = indefinite.
 * An elapsed `until` is treated as unmuted by the push filter WITHOUT a delete
 * (a cheap `until IS NULL OR until > now()` predicate), so no reaper is needed.
 * ------------------------------------------------------------------------- */

export const notificationMutes = pgTable(
  "notification_mutes",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** `'channel'` → `target_id` is a channels id; `'group'` → a friend_groups id. */
    scope: text("scope", { enum: ["channel", "group"] }).notNull(),
    /** Polymorphic target id (see table header) — no FK by design. */
    targetId: uuid("target_id").notNull(),
    /** `'all'` silences everything; `'mentions'` lets direct @mentions through. */
    mode: text("mode", { enum: ["all", "mentions"] })
      .notNull()
      .default("all"),
    /** Auto-expiry instant; NULL = indefinite. Elapsed ⇒ treated as unmuted. */
    until: timestamp("until", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    /** Bumped on re-mute (mode/until change); null on first insert. */
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.scope, t.targetId] }),
    /** "all of this user's mutes" for the `GET /notification-mutes` list. */
    userIdIdx: index("notification_mutes_user_id_idx").on(t.userId),
  }),
);

/* ---------------------------------------------------------------------------
 * M18 — server structure, blocking, moderation audit log (migration 0019).
 * Every table here is ADDITIVE: no existing column changes meaning, and the two
 * new `users`/`channels` columns above are nullable, so production data is
 * untouched by the migration.
 * ------------------------------------------------------------------------- */

/**
 * Sidebar categories that group a SERVER's channels ("GENEL" / "SES" headers).
 * Purely organizational: a category carries NO permissions and
 * never affects channel visibility — that stays the M9 `channel_role_access`
 * model (ADR 0007). Membership lives on the nullable `channels.category_id`, so
 * an uncategorized channel keeps its pre-M18 top-level placement.
 */
export const channelCategories = pgTable(
  "channel_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => friendGroups.id, { onDelete: "cascade" }),
    /** 1..64 chars, validated at the API boundary. */
    name: text("name").notNull(),
    /** Sort order among the server's categories; ties broken by `created_at`. */
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    groupIdIdx: index("channel_categories_group_id_idx").on(t.groupId),
    /**
     * Composite-FK target so a future "category belongs to the same group as its
     * channel" constraint is expressible, mirroring `channels_id_group_id_unique`.
     */
    idGroupUnique: unique("channel_categories_id_group_id_unique").on(t.id, t.groupId),
  }),
);

/**
 * DIRECTIONAL user blocks (M18) — the table the `friendship_status` enum comment
 * has been promising since ADR 0010 §2: blocking is NEVER a third friendship
 * value, it is this separate row.
 *
 * One row per (blocker, blocked). Blocking is one-sided to WRITE but symmetric to
 * ENFORCE: nearly every guard asks "does a row exist in EITHER direction", so a
 * blocked user can neither reach nor be reached by the blocker (ADR 0017). Both
 * FKs cascade — deleting either account reaps the row.
 */
export const userBlocks = pgTable(
  "user_blocks",
  {
    blockerId: uuid("blocker_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    blockedId: uuid("blocked_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.blockerId, t.blockedId] }),
    /**
     * Reverse lookups: "who blocked ME" (the blocker leads the PK, so the blocked
     * side needs its own index). Both directions are read on every block check.
     */
    blockedIdIdx: index("user_blocks_blocked_id_idx").on(t.blockedId),
    /** You cannot block yourself — enforced in SQL, not only at the API boundary. */
    noSelfBlock: check("user_blocks_no_self", sql`${t.blockerId} <> ${t.blockedId}`),
  }),
);

/**
 * Moderation AUDIT LOG (M18) — one append-only row per successful kick / ban /
 * unban / voice-disconnect, written by the moderation endpoints. The `group_bans`
 * table records the CURRENT ban state; this records the HISTORY, including
 * actions (kick, voice-disconnect, unban) that leave no lasting state at all.
 *
 * `action` is plain `text` with a TYPE-LEVEL enum (like `messages.kind` and
 * `notification_mutes.scope`) so the migration stays a pure additive
 * `CREATE TABLE` with no `CREATE TYPE`, and a future action type needs no
 * migration. `actor_id` is ON DELETE SET NULL so purging a moderator's account
 * never destroys the record of what was done.
 */
export const moderationActions = pgTable(
  "moderation_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => friendGroups.id, { onDelete: "cascade" }),
    /** Who performed it; null once that account is hard-purged. */
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    /** Who it was performed on. */
    targetId: uuid("target_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    action: text("action", {
      enum: [
        "kick",
        "ban",
        "unban",
        "voice_disconnect",
        // Migration 0020: timeout applied / lifted early. Added with NO schema
        // change at all — this is exactly the "future action type needs no
        // migration" the plain-`text`-plus-TS-enum choice above was made for.
        "timeout",
        "timeout_remove",
      ],
    }).notNull(),
    /** Optional moderator note (≤512 chars at the API boundary), or NULL. */
    reason: text("reason"),
    /**
     * `timeout` only (migration 0020): when the mute was set to expire, so the
     * log line can state the duration. NULL for every other action.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    /**
     * The ONLY read path: "this server's log, newest first, keyset-paged".
     * A composite (group_id, created_at DESC, id DESC) index serves the whole
     * ORDER BY + cursor comparison as one range scan.
     */
    groupCreatedIdx: index("moderation_actions_group_created_idx").on(
      t.groupId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
  }),
);

// ---------------------------------------------------------------------------
// Private per-viewer annotations + ignore (migration 0020, ADR 0019)
//
// Three tables that all key on (viewer, target) and all cascade on either
// account's deletion. They look alike; they are NOT interchangeable, and that
// difference is the whole point of the ADR:
//
//   user_notes      private text ABOUT someone — read by exactly ONE endpoint
//   user_nicknames  private rename OF someone — read by many render paths
//   user_ignores    private "stop notifying me about this person"
//
// `user_notes` and `user_nicknames` stay SEPARATE tables despite an identical
// key, because the note is a single-reader secret while the nickname flows into
// rosters, message rows, DM lists and mention rendering. Keeping them apart makes
// "nothing outside the note endpoint selects from user_notes" a grep-checkable
// invariant, instead of a column-discipline rule every future join must remember.
// ---------------------------------------------------------------------------

/**
 * A private note one user keeps about another (ADR 0019 §1) — the "Not" box on
 * a profile card.
 *
 * **Only `viewer_id` may read a row.** No profile projection, no roster query, no
 * realtime payload and no moderation surface joins this table; the person a note
 * is ABOUT has no endpoint that can return it. Enforced by the API (a single
 * reader, `GET /users/:id/note`, always scoped to `viewer_id = me`) and asserted
 * by an integration test — a privacy rule with no test is just a promise.
 *
 * Clearing a note DELETES the row rather than storing an empty string, so "no
 * note" has exactly one representation.
 */
export const userNotes = pgTable(
  "user_notes",
  {
    /** The note's author and its ONLY reader. */
    viewerId: uuid("viewer_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Who the note is about. They can never see it. */
    targetId: uuid("target_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** ≤256 chars at the API boundary; stored raw, escaped at render (§28). */
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.viewerId, t.targetId] }),
    /**
     * NO reverse (`target_id`) index, unlike `user_blocks`. Deliberate: an index
     * on the target IS the access path "everything ever written about this
     * person", and nothing may run that query. Omitting it costs nothing (the
     * only read is by the full PK) and removes the tool.
     */
    noSelfNote: check("user_notes_no_self", sql`${t.viewerId} <> ${t.targetId}`),
  }),
);

/**
 * A private nickname one user gives another (ADR 0019 §2) — a per-viewer
 * "friend nickname". Visible ONLY to `viewer_id`; the target is never told, and
 * no other user's render path can reach this row.
 *
 * Distinct from `friend_group_members.nickname`, the per-SERVER nickname everyone
 * in that server sees. Name resolution order is: personal nickname → server
 * nickname → `users.display_name`.
 *
 * Clearing DELETES the row — the same "one representation of empty" rule.
 */
export const userNicknames = pgTable(
  "user_nicknames",
  {
    viewerId: uuid("viewer_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    targetId: uuid("target_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** ≤32 chars at the API boundary. Never empty — clearing removes the row. */
    nickname: text("nickname").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.viewerId, t.targetId] }),
    /** You cannot nickname yourself — change your display name instead. */
    noSelfNickname: check("user_nicknames_no_self", sql`${t.viewerId} <> ${t.targetId}`),
  }),
);

/**
 * A ONE-DIRECTIONAL, silent ignore (ADR 0019 §4): `ignorer_id` no longer wants to
 * be notified by `ignored_id`.
 *
 * Read ONLY in the ignorer's direction. There is deliberately no reverse index
 * and no symmetric primitive — the contrast with `user_blocks`, which has both —
 * because "who ignores me" is precisely the question this feature exists to leave
 * unanswerable. The ignored user's experience is bit-for-bit unchanged: their
 * messages send, deliver and persist exactly as before.
 */
export const userIgnores = pgTable(
  "user_ignores",
  {
    ignorerId: uuid("ignorer_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ignoredId: uuid("ignored_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ignorerId, t.ignoredId] }),
    /** You cannot ignore yourself. Enforced in SQL, not only at the boundary. */
    noSelfIgnore: check("user_ignores_no_self", sql`${t.ignorerId} <> ${t.ignoredId}`),
  }),
);
