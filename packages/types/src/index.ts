/**
 * Shared domain types — MVP primitives.
 *
 * These are the single source of truth for domain shapes across
 * desktop, api, and realtime. Realtime event payloads live in
 * @demli/protocol and reference these types.
 */

export type UserId = string;
export type GroupId = string;
export type ChannelId = string;
export type MessageId = string;
export type InviteId = string;
export type RoleId = string;
export type AttachmentId = string;
export type CustomEmojiId = string;

export type MemberRole = "owner" | "member" | "guest";

/**
 * Discriminates the three shapes a `friend_groups` row can take:
 * - `"server"` — the multi-channel space (the original FriendGroup concept).
 * - `"group"`  — a lightweight flat chat that owns exactly one hidden text
 *   channel; that channel's id is the group's message stream. See {@link Group}.
 * - `"dm"`     — a direct-message pair (ADR 0010 §1): exactly two members owning
 *   exactly one hidden text channel, reusing the group-chat pipeline. See
 *   {@link Dm}. Never surfaced in `/groups` or `/group-chats`; it has its own
 *   `/dms` list.
 */
export type FriendGroupKind = "server" | "group" | "dm";

/**
 * A user's presence status.
 *
 * - `online`      — connected and available (green dot).
 * - `idle`        — connected but away (amber dot). Manual pick, distinct from any
 *   future auto-away: a manual choice always wins.
 * - `dnd`         — Do Not Disturb (red dot). Still fully connected/visible to
 *   peers, but the OWNER's client silences notification sounds/toasts and
 *   suppresses the forced incoming-call overlay (renderer-side gating).
 * - `invisible`   — the user stays connected with full access, but peers see them
 *   as `offline` (gray). The masking lives server-side in
 *   {@link publicPresenceStatus}; the user's own client keeps the real value.
 * - `offline`     — no live connection. Derived, never chosen.
 *
 * `dnd` + `invisible` are additive: prior readers only knew online/idle/offline,
 * and `invisible` is masked to `offline` on the wire, so the only genuinely new
 * value a peer can receive is `dnd`.
 */
export type PresenceStatus = "online" | "idle" | "dnd" | "invisible" | "offline";

/**
 * The statuses a user may deliberately pick from the status picker. `offline` is
 * never selectable (derived from having no live connection); `invisible` IS
 * selectable (connected but projected to peers as offline).
 */
export type SelectablePresenceStatus = "online" | "idle" | "dnd" | "invisible";

/** Picker order: Online, Idle, Do Not Disturb, Invisible. */
export const SELECTABLE_PRESENCE_STATUSES: readonly SelectablePresenceStatus[] = [
  "online",
  "idle",
  "dnd",
  "invisible",
];

/**
 * Project a user's REAL status to what OTHER users are allowed to see. Only
 * `invisible` is masked — it always reads as `offline` to peers — while every
 * other status (including `dnd`, a visible red dot) passes through unchanged.
 * Pure and dependency-free: the SINGLE source of the masking rule, shared by the
 * realtime gateway's live broadcast and its handshake snapshot.
 */
export function publicPresenceStatus(status: PresenceStatus): PresenceStatus {
  return status === "invisible" ? "offline" : status;
}

/**
 * Priority order used by {@link derivePresenceStatus} — HIGHEST first. Exported
 * for tests/docs; the rule itself is the function below.
 */
const PRESENCE_DERIVATION_ORDER: readonly PresenceStatus[] = [
  "invisible",
  "dnd",
  "online",
  "idle",
];

/**
 * Reduce the statuses declared by a user's LIVE CONNECTIONS to the one status
 * the account presents (ADR 0020). The single source of the derivation rule,
 * shared by the realtime gateway's `PresenceStore` (the writer) and
 * `RedisPresenceReader` (the API's reader) so the two can never drift.
 *
 * Presence is per-CONNECTION because the inputs are: the desktop's auto-away
 * timer decides "idle" from THIS machine's input devices, and it has no idea a
 * phone is wide awake. Deriving the account status from every live connection is
 * what makes "desktop idle + phone active" answer `online` instead of the
 * pre-ADR-0017 bug where the last writer's stale `idle` outlived its device.
 *
 * Priority (first match wins over all live declarations):
 * 1. `invisible` — a PRIVACY declaration, so it is never overridden. If any live
 *    device says invisible, the account is invisible (and {@link
 *    publicPresenceStatus} then masks it to `offline` for peers). Deriving
 *    "online" here because a second device is active would UNMASK a user who
 *    deliberately asked to be hidden — the one failure mode worth ranking above
 *    everything else.
 * 2. `dnd` — a deliberate "do not disturb me" declaration about the HUMAN, not
 *    the device. Picked on the phone during a meeting, it must also hold on the
 *    desktop, so any live device declaring it wins over derived availability
 *    (the founder's rule "manuel seçim otomatiği ezer", one level up).
 * 3. `online` — availability: ANY live connection that is actually available
 *    makes the user available.
 * 4. `idle` — only when EVERY live connection is idle is the user idle.
 *
 * Availability (`online`/`idle`) is therefore per-device, while intent
 * (`dnd`/`invisible`) is effectively account-wide for as long as any live device
 * declares it. Nothing here outlives the connections it came from: a status with
 * no live socket behind it is exactly the ghost this model removes, so intent is
 * re-asserted by each client on connect rather than persisted server-side.
 *
 * An unrecognized value (an old/garbage record) is ignored. An EMPTY bag yields
 * `online`: callers only reach this with at least one live connection, and a
 * connection that never declared a status is available by default — the
 * pre-status behavior. `offline` is NOT derivable here; it means "no live
 * connections at all" and is decided by the caller before calling.
 */
export function derivePresenceStatus(
  declared: Iterable<string | null | undefined>,
): PresenceStatus {
  const seen = new Set<string>();
  for (const value of declared) {
    if (value === "invisible") return "invisible"; // highest priority, stop early
    if (typeof value === "string") seen.add(value);
  }
  for (const candidate of PRESENCE_DERIVATION_ORDER) {
    if (seen.has(candidate)) return candidate;
  }
  return "online";
}

/**
 * The kind of client a user is connected from, surfaced on presence so the UI
 * can distinguish a mobile-only presence (phone indicator) from a desktop one
 * (plain dot). Optional everywhere on the wire — pre-platform clients never send
 * it and readers treat its absence as "unknown / desktop-style dot". When a user
 * has several live connections the gateway reports the DOMINANT one: desktop wins
 * over mobile — you are "on desktop" whenever a desktop client is open, even with
 * a phone also connected.
 */
export type PresencePlatform = "desktop" | "mobile";

/**
 * Who may create invites for a server (ADR 0007, servers only).
 * - `"members"` — default, back-compat: owner + members create invites; guests
 *   never. This is exactly the pre-M9 behavior.
 * - `"roles"`   — only the owner and members holding `CREATE_INVITE`.
 */
export type InvitePolicy = "members" | "roles";

export interface User {
  id: UserId;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  /**
   * Short self-description shown on the profile card (ADR 0010 §3). Max 280
   * chars, plain text: escaped exactly like message content (§28), never
   * rendered as HTML/markdown. Optional so older fixtures keep compiling; the
   * server always emits it (null when unset).
   */
  bio?: string | null;
  /**
   * The user's renewable friend code (ADR 0010 §2), 8 chars of the invite
   * base32 alphabet, displayed grouped (`XXXX-XXXX`). PRESENT ONLY on the
   * caller's own record (`/users/me`) — never emitted for other users and
   * never carried in realtime events (the wire `userSchema` in
   * @demli/protocol deliberately omits it and strips it on parse).
   */
  friendCode?: string;
  /**
   * Profile banner image URL (M15). PUBLIC — shown on the profile card to
   * everyone, so it rides the public `User` DTO and realtime events (the wire
   * `userSchema` carries it, exactly like `avatarUrl`/`bio`). Optional +
   * back-compat (mapper always emits it; null when unset). A GIF or still image;
   * validated + stored server-side (`POST /users/me/banner`).
   */
  bannerUrl?: string | null;
  /**
   * Date of birth as an ISO `YYYY-MM-DD` string (M15). ME-ONLY, like
   * {@link friendCode}: present ONLY on the caller's own `/users/me` record and
   * never leaked to other users or carried in realtime events (the wire
   * `userSchema` omits it and strips it on parse). Null when the user never
   * supplied one (every pre-M15 account). The raw DOB is deliberately not public
   * — peers only ever see the derived {@link isAdult} gate, never the birthdate.
   */
  birthdate?: string | null;
  /**
   * Derived age gate (M15): true iff the caller is 18+ computed from
   * {@link birthdate}. ME-ONLY (present on `/users/me` only). A null/unset
   * birthdate yields `false` (conservative — an unverified age is treated as a
   * minor). This is the value the NSFW-channel client gate reads; the raw
   * birthdate stays private. See {@link isAdult}.
   */
  isAdult?: boolean;
  /**
   * Free-text "custom status" line shown under the name on the profile card and
   * in the member list (M18). ≤128 chars, PLAIN TEXT — stored raw and escaped
   * exactly like message content at render time (§28), never rendered as
   * HTML/markdown. Null when unset OR when {@link customStatusExpiresAt} has
   * already elapsed (the mapper applies the expiry, so a stale status never
   * reaches the wire even before a sweep). Optional + additive: the mapper always
   * emits it, so every server response carries it.
   */
  customStatus?: string | null;
  /**
   * ISO instant the {@link customStatus} auto-clears ("for 30 minutes", "today"),
   * or null for an indefinite one. Emitted only while the status itself is live;
   * an elapsed value reads as no status at all.
   */
  customStatusExpiresAt?: string | null;
  createdAt: string;
}

/**
 * The legal-adult age gate for the NSFW feature (M15). Pure and dependency-free
 * — the SINGLE source of the 18+ rule, shared by the `/users/me` mapper and any
 * caller that must gate age-restricted content.
 *
 * `birthdate` is an ISO `YYYY-MM-DD` string (the shape stored in Postgres and
 * carried in {@link User.birthdate}). A null/undefined/malformed value returns
 * `false` — an unknown age is treated conservatively as a minor, never as an
 * adult. The comparison is done in UTC so it is deterministic regardless of the
 * server's local timezone.
 */
export function isAdult(
  birthdate: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!birthdate) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthdate);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Reject an impossible calendar date (e.g. 2000-13-40) — never treat garbage
  // as a valid adult DOB.
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  let age = now.getUTCFullYear() - year;
  const nowMonth = now.getUTCMonth() + 1;
  const nowDay = now.getUTCDate();
  if (nowMonth < month || (nowMonth === month && nowDay < day)) age--;
  return age >= 18;
}

/**
 * Public projection of a login session for the "active sessions" screen (M15-A).
 * Deliberately OMITS the token hash — the backend `Session` shape carries it but
 * it must never leave the server. `GET /sessions` returns one of these per
 * unexpired session the caller owns, with `current` flagging the session that
 * made the request (the one the client should not offer to close as "another
 * device").
 */
export interface SessionSummary {
  id: string;
  /** Client-declared device label; null when the client did not send one. */
  deviceName: string | null;
  /** Client surface the session was issued to; null when undeclared. */
  platform: PresencePlatform | null;
  /** Last time this session authenticated a request (ISO-8601). */
  lastSeenAt: string;
  /** When the session was issued (ISO-8601). */
  createdAt: string;
  /** True for the session that made THIS request. */
  current: boolean;
}

export interface FriendGroup {
  id: GroupId;
  name: string;
  iconUrl: string | null;
  /**
   * Servers only: the banner image shown behind the sidebar header (M20). Null =
   * no banner, and the header renders exactly as it did before one existed —
   * never an empty box (§35). Optional (not omitted by the server — the mapper
   * always emits it) for the same reason `systemChannelId` and `invitePolicy`
   * are: a field added after the fact must not break older fixtures that build a
   * FriendGroup without it.
   */
  bannerUrl?: string | null;
  ownerId: UserId;
  kind: FriendGroupKind;
  /**
   * Servers only: the text channel receiving system messages (member
   * joined/left). Auto-set to the server's first text channel; null = off.
   * Always null for kind === "group". Optional (not omitted by the server —
   * the mapper always emits it) so older client fixtures keep compiling.
   */
  systemChannelId?: ChannelId | null;
  /**
   * Servers only: who may create invites (ADR 0007). Optional (the mapper
   * always emits it — older client fixtures keep compiling) and defaults to
   * `"members"` when absent, preserving pre-M9 behavior. Always `"members"`
   * for kind === "group".
   */
  invitePolicy?: InvitePolicy;
  createdAt: string;
}

/**
 * A "Server" is the multi-channel space — the original FriendGroup with
 * `kind === "server"`. Alias kept so server-facing code reads intentionally.
 */
export type Server = FriendGroup;

/**
 * A "Group" is a lightweight flat chat: a `friend_groups` row with
 * `kind === "group"` that owns exactly one auto-created hidden text channel.
 * `streamId` is that channel's id — the group reuses the entire channel-scoped
 * message + realtime pipeline unchanged. A group is never presented as a set of
 * channels; clients treat it as a single conversation keyed by `streamId`.
 */
export interface Group {
  id: GroupId;
  name: string;
  iconUrl: string | null;
  ownerId: UserId;
  /** The single hidden text channel that carries this group's messages. */
  streamId: ChannelId;
  createdAt: string;
}

export interface FriendGroupMember {
  groupId: GroupId;
  userId: UserId;
  role: MemberRole;
  /**
   * Servers only: the custom roles this member holds (ADR 0007). Additive on
   * top of the `role` baseline; guests always hold none. Optional (the members
   * mapper always emits it — omitting keeps older fixtures compiling) and an
   * absent value means "no roles", identical to `[]`.
   */
  roleIds?: RoleId[];
  /**
   * Per-server nickname (migration 0020, ADR 0019). Visible to EVERYONE in this
   * server — the PUBLIC server nickname, not the private per-viewer one
   * (`UserNickname`). Null/absent ⇒ render the user's `displayName`.
   *
   * Optional so pre-0020 fixtures keep compiling; the members mapper always
   * emits it.
   */
  nickname?: string | null;
  /**
   * ISO instant this member's timeout (mute) expires, or null when they are not
   * timed out (migration 0020, ADR 0019). A member is timed out while this is in
   * the FUTURE — expiry is evaluated at query time, so a past value is
   * indistinguishable from null and no sweeper is needed.
   *
   * While timed out the member cannot send messages, add reactions or join voice
   * in THIS server; the enforcement is server-side on every one of those paths,
   * and this field only lets the UI show the state.
   */
  timedOutUntil?: string | null;
  joinedAt: string;
}

/** Membership row for a {@link Group}; identical shape to a server member. */
export type GroupMember = FriendGroupMember;

/**
 * A permanent ban of a user from a server (`kind === "server"` only). One row
 * per (group, user): a ban outlives the membership it removed, so a banned user
 * cannot rejoin — the invite-redeem path re-checks this table server-side and
 * refuses (§28). Kick removes membership WITHOUT a ban row; ban does both.
 *
 * `bannedBy` is the moderator who issued it, or `null` when that account was
 * later deleted (the ban stands — a deleted moderator must not resurrect access).
 * `reason` is optional free text shown in the ban list, escaped like message
 * content at render (§28). Flat group chats and DMs never use bans.
 */
export interface GroupBan {
  groupId: GroupId;
  userId: UserId;
  /** The moderator who issued the ban; null once that account is deleted. */
  bannedBy: UserId | null;
  /** Optional moderator note; null when none was given. */
  reason: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Roles & permissions (ADR 0007 — servers only, additive over the member enum)
// ---------------------------------------------------------------------------

/**
 * Permission bits are stored in Postgres as a `bigint` but carried in memory
 * and over the wire as a plain JS `number`. The MVP defines 5 bits (max value
 * 31); JSON cannot represent a `bigint`, and JS numbers are exact integers up
 * to 2^53 − 1 — decades of headroom before the bitfield could overflow. If a
 * future model ever needs more than 53 bits, revisit with a string-encoded
 * bigint on the DTO (ADR 0007, alternative 4).
 */
export type PermissionBitfield = number;

/**
 * The minimal permission set (ADR 0007). Named constants only — never magic
 * numbers in callers (CLAUDE.md §23). Effective permissions are the bitwise OR
 * of every role a member holds; the owner bypasses the bitfield entirely and
 * guests can hold no roles.
 */
export const PERMISSIONS = {
  /** Create/edit/delete/reorder channels, set slowmode, set visibility. */
  MANAGE_CHANNELS: 1 << 0,
  /** Delete or moderate other members' messages. */
  MANAGE_MESSAGES: 1 << 1,
  /** Remove members from the server (never the owner). */
  KICK_MEMBERS: 1 << 2,
  /** Create invites when the group's `invitePolicy` is `"roles"`. */
  CREATE_INVITE: 1 << 3,
  /** Role CRUD + assignment; granting this bit is owner-only (escalation guard). */
  MANAGE_ROLES: 1 << 4,
  /**
   * Change ANOTHER member's per-server nickname (migration 0020, ADR 0019).
   * Setting your OWN nickname needs no bit — every member may do that.
   *
   * A new bit rather than a reuse of `KICK_MEMBERS`: gating a cosmetic, fully
   * reversible action behind the power to REMOVE people would force an owner to
   * hand out a destructive permission in order to delegate a harmless one. That
   * is backwards, and it is the exact escalation the bitfield exists to prevent.
   */
  MANAGE_NICKNAMES: 1 << 5,
} as const;

/** A permission bit name, e.g. `"MANAGE_CHANNELS"`. */
export type PermissionName = keyof typeof PERMISSIONS;

/** A single permission bit value drawn from {@link PERMISSIONS}. */
export type PermissionBit = (typeof PERMISSIONS)[PermissionName];

/**
 * True when every bit in `bit` is set in `bitfield`. Pure bitfield test — the
 * owner bypass is the caller's responsibility, not encoded here. Pass a single
 * {@link PERMISSIONS} value (callers combine multiple with `|` before calling).
 */
export function hasPermission(bitfield: PermissionBitfield, bit: PermissionBit): boolean {
  return (bitfield & bit) === bit;
}

/**
 * True when a member timeout (migration 0020, ADR 0019 §3) is still in force.
 *
 * Lives HERE, beside {@link hasPermission}, for the same reason that one does:
 * it is a pure domain rule that more than one process has to agree on. The API
 * and the WS gateway both gate writes on it, and they are separate deployables —
 * a copy in each would be two rules that merely look alike, and the first time
 * one of them rounded differently a mute would hold on one transport and not the
 * other. One function, imported by both.
 *
 * Accepts `Date | string` because the value arrives as a `Date` from a repository
 * and as an ISO string from a DTO. An unparseable value reads as NOT timed out:
 * a corrupt column must never mute someone permanently with no way to appeal.
 */
export function isTimedOut(timedOutUntil: Date | string | null | undefined): boolean {
  if (timedOutUntil === null || timedOutUntil === undefined) return false;
  const until =
    timedOutUntil instanceof Date ? timedOutUntil.getTime() : Date.parse(timedOutUntil);
  if (Number.isNaN(until)) return false;
  return until > Date.now();
}

/**
 * A custom role within a server (`kind === "server"` only). Grants capabilities
 * additively over the member baseline; flat groups never use roles.
 */
export interface Role {
  id: RoleId;
  groupId: GroupId;
  name: string;
  /** Member-name color as `"#rrggbb"`, or null for the default text color. */
  color: string | null;
  /** Display order only — the MVP has no permission hierarchy (ADR 0007). */
  position: number;
  permissions: PermissionBitfield;
  createdAt: string;
}

/**
 * A single (role, member) grant within a server (ADR 0007). Assignments are
 * additive — a member's effective permissions are the OR of every role they
 * hold. Guests can hold none.
 */
export interface MemberRoleAssignment {
  groupId: GroupId;
  userId: UserId;
  roleId: RoleId;
  assignedAt: string;
}

/**
 * A (channel, role) visibility grant (ADR 0007). A channel with zero rows is
 * public to all members; one or more rows restrict it to the owner plus members
 * holding at least one listed role.
 */
export interface ChannelRoleAccess {
  channelId: ChannelId;
  roleId: RoleId;
  groupId: GroupId;
}

export type ChannelKind = "text" | "voice";

/**
 * The channel kinds that carry a TEXT CHAT (M20).
 *
 * Both kinds do. A voice channel is a room with a conversation attached, not a
 * media socket with a name: you drop a link while three people are talking, you
 * read what was said before you joined, and nobody has to leave for #general to
 * do it. Before M20 every write path spelled this as an inline `kind !== "text"`
 * in four separate files (REST send, WS send, attachment upload, slowmode), so
 * "who may be written to" was defined four times and could drift three ways.
 *
 * This constant is that definition, once. Read paths deliberately do NOT consult
 * it — history, search, pins and reactions were already kind-agnostic and stay
 * that way, so a channel is readable exactly when it is VISIBLE (ADR 0007). The
 * only thing a kind decides is whether a WRITE is accepted at all; everything
 * after that (visibility, roles, timeout, blocks, slowmode, NSFW) is identical
 * for both kinds by construction.
 */
export const CHAT_CAPABLE_CHANNEL_KINDS: readonly ChannelKind[] = ["text", "voice"];

/**
 * True when messages/attachments may be posted to a channel of this kind
 * ({@link CHAT_CAPABLE_CHANNEL_KINDS}) and slowmode may be configured on it.
 *
 * Kept as a function rather than an inline comparison so that every refusal in
 * the API and the WS gateway is answering the SAME question — a gate on one
 * transport is a gate on neither (the desktop client speaks both).
 */
export function isChatCapableChannel(kind: ChannelKind): boolean {
  return CHAT_CAPABLE_CHANNEL_KINDS.includes(kind);
}

export interface Channel {
  id: ChannelId;
  groupId: GroupId;
  kind: ChannelKind;
  name: string;
  position: number;
  /** Optional channel topic/description shown in headers and settings. */
  description?: string | null;
  /**
   * Voice channels only: soft cap on concurrent participants. Null/undefined
   * means no limit. Enforcing it against `text` channels is rejected server-side.
   */
  maxParticipants?: number | null;
  /**
   * Chat-capable channels ({@link CHAT_CAPABLE_CHANNEL_KINDS} — text AND voice
   * since M20): minimum seconds between messages per non-owner member.
   * 0/undefined = off. The server always emits it; owners are exempt.
   */
  slowmodeSeconds?: number;
  /**
   * Voice channels only: preferred audio bitrate in kbps. Null/undefined means
   * the media default. Setting it on `text` channels is rejected server-side.
   */
  audioBitrateKbps?: number | null;
  /**
   * Servers only: true when the channel has ≥1 `channel_role_access` row, i.e.
   * it is visible only to the owner and members holding a listed role (ADR
   * 0007). Absent/false = public to all members (pre-M9 behavior). This is a
   * display hint (lock icon); the authoritative access list stays behind
   * `GET /channels/:id/access`. The API only ever emits channels the caller
   * can see, so a visible restricted channel simply renders the lock.
   */
  restricted?: boolean;
  /**
   * Age-restricted (NSFW) channel flag (M15). When true the
   * client shows the age-gate prompt and image attachments are NOT NSFW-screened
   * on upload; when false (the default, every pre-M15 channel) the media
   * moderation seam blocks NSFW image attachments (`nsfw_content_blocked`).
   * Optional + back-compat (mapper always emits it; absent reads as `false`).
   */
  nsfw?: boolean;
  /**
   * The {@link ChannelCategory} this channel is filed under (M18), or null for an
   * UNCATEGORIZED channel — which stays in the sidebar's top-level list exactly
   * as before. Optional + additive (the mapper always emits it; absent reads as
   * null), so every pre-M18 channel is unaffected.
   */
  categoryId?: CategoryId | null;
  createdAt: string;
}

/**
 * "user"   — a regular message typed by a person (the default).
 * "system" — server-generated notice (member joined/left) posted to a server's
 *            system channel; `authorId` is the affected user.
 */
export type MessageKind = "user" | "system";

/**
 * One entry of a message's aggregated reaction summary (ADR 0011 §1): a distinct
 * emoji, how many people reacted with it, and whether the viewer is one of them.
 * Built per page (grouped `count(*)` + `bool_or(user = viewer)`), never one row
 * per reaction — the pill shows `emoji count` and highlights when `reactedByMe`.
 */
export interface MessageReactionSummary {
  /**
   * The reaction key: a single unicode emoji, or a `:name:` custom-emoji
   * shortcode (M17) the client resolves to that group's emoji image.
   */
  emoji: string;
  count: number;
  reactedByMe: boolean;
}

/**
 * A lightweight, denormalized preview of the message a reply quotes (ADR 0011
 * §2). Batch-built (one `WHERE id IN (…)` per page) and attached to the replying
 * message so a quote renders with no extra fetch. Carries only `authorId` (not
 * the whole user) — the client resolves the name from its users map.
 */
export interface MessageReplyPreview {
  id: MessageId;
  authorId: UserId;
  /** First `REPLY_PREVIEW_MAX` chars of the target content; blank when deleted. */
  content: string;
  kind: MessageKind;
  /** True when the quoted message is soft-deleted — render a "deleted" stub. */
  deleted: boolean;
}

/**
 * A link-preview (unfurl) card for one URL found in a message's `content` (M17).
 * Built ASYNCHRONOUSLY server-side after the message is created — the send never
 * blocks on it — by fetching the URL through an SSRF guard and parsing its
 * OpenGraph / `<meta>` tags. Delivered to clients via the `message.embeds_updated`
 * realtime event and joined onto message pages on GET.
 *
 * Every field except `url`/`fetchedAt` is nullable: a page may expose only some
 * of the OpenGraph set, and a card is only ever persisted when it carries at
 * least a title, description, or image (an all-null card is dropped, never
 * stored). This is purely presentational metadata — the client renders it as
 * text/image, NEVER as trusted markup.
 */
export interface MessageEmbed {
  /** The exact http(s) URL from the message content that this card previews. */
  url: string;
  /** `og:title` (falling back to `<title>`); null when the page exposed none. */
  title: string | null;
  /** `og:description` (falling back to `<meta name="description">`); null if absent. */
  description: string | null;
  /** Absolute http(s) `og:image` URL; null when absent or not a safe absolute URL. */
  imageUrl: string | null;
  /** `og:site_name` (e.g. "GitHub"); null when absent. */
  siteName: string | null;
  /** ISO instant the preview was fetched. */
  fetchedAt: string;
}

export interface Message {
  id: MessageId;
  channelId: ChannelId;
  authorId: UserId;
  content: string;
  /**
   * Optional so client-built optimistic entries can omit it (implied "user");
   * server-mapped rows always carry it.
   */
  kind?: MessageKind;
  /**
   * Media attachments hanging off this message (0..N, ADR 0008). Optional and
   * backward-compatible: text-only messages and older client fixtures omit it,
   * which reads identically to an empty list. Carries metadata only — the signed
   * read URL is NEVER part of the message; clients fetch short-lived URLs from
   * the dedicated attachments endpoint (see {@link Attachment}).
   */
  attachments?: Attachment[];
  /**
   * This message's aggregated reactions (ADR 0011 §1), one entry per distinct
   * emoji. Built by page enrichment, NOT the row mapper. Optional and
   * backward-compatible: absent/empty read identically, so text-only messages
   * and pre-M14 fixtures are unchanged.
   */
  reactions?: MessageReactionSummary[];
  /**
   * The raw id of the message this one replies to (ADR 0011 §2), or null when it
   * is not a reply. Set at send time and immutable. This is the persisted FK the
   * mapper carries; the human-readable {@link replyTo} preview is built from it
   * by enrichment. Optional so optimistic client entries can omit it.
   */
  replyToMessageId?: MessageId | null;
  /**
   * The denormalized preview of the quoted message (ADR 0011 §2), built by page
   * enrichment from {@link replyToMessageId}. `null`/absent when this message is
   * not a reply, or when the target was hard-deleted (the self-FK is `SET NULL`).
   * Optional and backward-compatible.
   */
  replyTo?: MessageReplyPreview | null;
  /**
   * Link-preview (unfurl) cards for URLs in {@link content} (M17). Built by the
   * async unfurl service AFTER the message is created (SSRF-guarded fetch + OG
   * parse) and delivered via the `message.embeds_updated` event; also joined onto
   * GET message pages. Optional and backward-compatible: a message with no
   * unfurlable URL omits it, which reads identically to an empty list. Never set
   * by the row mapper — grafted on by page enrichment / the embeds updated event.
   */
  embeds?: MessageEmbed[];
  /**
   * True when this message is currently pinned in its channel (M17). Built by
   * page enrichment from the `message_pins` join, NOT the row mapper — the pin is
   * a separate row, so a message's own record never changes when it is (un)pinned.
   * Optional and backward-compatible: absent reads identically to `false`, so
   * pre-M17 fixtures and the realtime `message.created` (never pinned at send
   * time) are unchanged. The `message.pinned` / `message.unpinned` events flip it
   * on the client's cached copy.
   */
  pinned?: boolean;
  createdAt: string;
  updatedAt: string | null;
  deletedAt: string | null;
}

/**
 * One entry of a channel's pin board (M17) — the message plus WHO pinned it and
 * WHEN. The pin metadata lives here rather than on {@link Message} because it
 * belongs to the pin row, not the message: unpinning and re-pinning a message
 * yields a new `pinnedAt` while the message itself is untouched.
 *
 * Returned by `GET /channels/:channelId/pins`, which is deliberately
 * UN-paginated: `PINS_MAX_PER_CHANNEL` caps a channel's board at 50, so the whole
 * list is one bounded read (§27).
 */
export interface PinnedMessage {
  /** The pinned message, enriched exactly like a message page entry. */
  message: Message;
  /** The member who pinned it. */
  pinnedBy: UserId;
  /** ISO instant the pin was created. */
  pinnedAt: string;
}

// ---------------------------------------------------------------------------
// Custom emoji (M17) — per-group emoji referenced in message content as
// `:name:`.
// ---------------------------------------------------------------------------

/**
 * A custom emoji belonging to one group. Metadata ONLY — the image URL is not a
 * field here, exactly like {@link Attachment}: emoji images live behind
 * short-lived signed read URLs minted per request by the batch emoji-URL
 * endpoint, so a durable, cacheable emoji record never carries a URL that expires
 * (and never carries the storage path, which must not leave the API).
 *
 * `name` is stored lowercased and is unique per group, so `:name:` in message
 * content resolves to at most one emoji within the group the message lives in.
 * Custom emoji are deliberately NOT global: an emoji reference is resolved
 * against the message's OWN group, so a name means whatever that group defined
 * and nothing leaks across groups.
 */
export interface CustomEmoji {
  id: CustomEmojiId;
  groupId: GroupId;
  /** Lowercased `[a-z0-9_]{2,32}` shortcode, unique within the group. */
  name: string;
  /** Whitelisted image MIME (`image/png` or `image/webp`); no SVG (§28). */
  mime: string;
  sizeBytes: number;
  /** The member who uploaded it. */
  createdBy: UserId;
  createdAt: string;
}

/**
 * A short-lived signed read URL for one custom emoji, returned by the batch
 * `POST /groups/:groupId/emojis/urls` endpoint — the SOLE source of renderable
 * emoji image URLs, mirroring `AttachmentUrl` (ADR 0008 §2). Clients mint these
 * for the emoji actually on screen and re-request when `urlExpiresAt` passes.
 */
export interface CustomEmojiUrl {
  emojiId: CustomEmojiId;
  url: string;
  /** ISO instant at which `url` stops working and must be re-requested. */
  urlExpiresAt: string;
}

// ---------------------------------------------------------------------------
// Media attachments (ADR 0008 — M10, images / audio / video on messages)
// ---------------------------------------------------------------------------

/**
 * The attachment media kinds. Exposed as a runtime tuple (not just a type) so
 * the API can iterate the set and @demli/config's `ATTACHMENT_LIMITS` can be
 * asserted to cover exactly these kinds. Order is not significant.
 */
export const ATTACHMENT_KINDS = ["image", "video", "audio"] as const;

export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/**
 * A media file attached to a {@link Message} (ADR 0008). This is the
 * client-facing shape: it carries only metadata needed to render a placeholder
 * of the right kind/aspect ratio.
 *
 * Two fields are deliberately ABSENT and must never be added here:
 * - `storagePath` — the bucket object key is server-internal; leaking it would
 *   expose the storage layout. It stays inside the API.
 * - a signed read URL — access URLs are short-lived (~1 h) and minted per
 *   request after the channel-visibility check (ADR 0008 §2). They are fetched
 *   from the batch attachments-URL endpoint, not baked into this durable shape,
 *   so a cached `Attachment` never carries a stale or leaked URL.
 */
export interface Attachment {
  id: AttachmentId;
  /** The message this attachment is linked to; null during the upload window. */
  messageId: MessageId | null;
  /** Denormalized owning channel — drives authz + cleanup before link. */
  channelId: ChannelId;
  uploaderId: UserId;
  kind: AttachmentKind;
  /** Exact whitelisted MIME (see `ATTACHMENT_LIMITS` in @demli/config). */
  mime: string;
  /** Byte size, validated server-side against the per-kind cap. */
  sizeBytes: number;
  /** Pixel width for image/video; null for audio. */
  width: number | null;
  /** Pixel height for image/video; null for audio. */
  height: number | null;
  /** Duration in ms for audio/video; null for image. */
  durationMs: number | null;
  createdAt: string;
}

export interface Invite {
  id: InviteId;
  groupId: GroupId;
  code: string;
  createdBy: UserId;
  expiresAt: string | null;
  maxUses: number | null;
  useCount: number;
  createdAt: string;
  /**
   * Optional CHANNEL this invite points at (migration 0021). NULL — every
   * pre-0021 invite and every plain "join my server" link — means the invite
   * targets the server itself and behaves exactly as before.
   *
   * The link format does NOT change: one deep-link shape, `…/invite/<code>`.
   * The target rides on the invite ROW, so redeeming resolves it server-side.
   * `ON DELETE SET NULL`: deleting the channel must never kill the invite, it
   * only drops the destination and the link degrades to a server invite.
   */
  targetChannelId: ChannelId | null;
}

/**
 * Where an invite drops the joiner after they are inside the server: the
 * channel the inviter picked. `kind` lets the client decide what "arriving"
 * means — a text channel just opens, a voice channel opens with its join
 * affordance (the founder's flow: first press joins the server and lands on the
 * channel, the next press enters the room).
 *
 * Resolved per-VIEWER and honestly: `null` whenever this viewer would not be
 * able to see the channel (ADR 0007 role restriction), whenever the channel was
 * deleted, or whenever the invite never had a target. A destination the viewer
 * cannot reach is a dead redirect, so it is never advertised (§35).
 */
export interface InviteTargetChannel {
  id: ChannelId;
  name: string;
  kind: ChannelKind;
}

/**
 * Rich card for an invite link pasted into chat (`GET /invites/:code/preview`).
 * Read-only: previewing NEVER consumes an invite use.
 *
 * - `kind` — server invite vs. group-DM link (the same `invites` row serves
 *   both; a DM can never be previewed).
 * - `onlineCount` — publicly-online members (invisible users are masked to
 *   offline, exactly like {@link publicPresenceStatus}); `null` when the
 *   presence store cannot be read — the client hides the line rather than
 *   showing a made-up number.
 * - `createdAt` — the GROUP's creation date (ISO), not the invite's.
 * - `groupId` — only disclosed when `alreadyMember` (for "open server"
 *   navigation); a non-member gets `null` so the preview leaks nothing the
 *   redeem flow would not.
 * - `targetChannel` — the channel this invite lands on, or `null`. For a
 *   non-member the answer is what they WOULD see right after joining (a
 *   role-restricted channel is invisible to a brand-new role-less member, so it
 *   reads `null`); for an existing member it is their real visibility. The card
 *   therefore never promises a destination the join cannot deliver.
 */
export interface InvitePreview {
  code: string;
  kind: "server" | "group";
  groupName: string;
  groupIconUrl: string | null;
  memberCount: number;
  onlineCount: number | null;
  createdAt: string;
  alreadyMember: boolean;
  groupId: GroupId | null;
  targetChannel: InviteTargetChannel | null;
}

export interface Presence {
  userId: UserId;
  status: PresenceStatus;
  updatedAt: string;
}

export interface MediaSession {
  roomId: string;
  channelId: ChannelId;
  participants: UserId[];
  startedAt: string;
}

export interface DevicePreference {
  userId: UserId;
  inputDeviceId: string | null;
  outputDeviceId: string | null;
  inputVolume: number;
  outputVolume: number;
}

// ---------------------------------------------------------------------------
// Social layer (ADR 0010 — friendships, DMs, profiles)
// ---------------------------------------------------------------------------

/**
 * A DM's id IS its `friend_groups` row id (`kind === "dm"`). Alias kept so
 * DM-facing signatures read intentionally.
 */
export type DmId = GroupId;

/**
 * Lifecycle of a {@link Friendship} row: `"pending"` (request sent, awaiting
 * the addressee) or `"accepted"`. Decline, cancel, and unfriend DELETE the row
 * — there is no "declined"/"removed" state to leak intent. Blocking is
 * deferred and will be a separate directional `user_blocks` table, never a
 * third status here (ADR 0010 §2).
 */
export type FriendshipStatus = "pending" | "accepted";

/**
 * The relationship between two users — exactly one row per unordered pair,
 * stored canonically: `userA < userB` (uuid total order, DB-enforced via
 * `CHECK (user_a < user_b)`, which also forbids self-friendship).
 * `requestedBy` names the side that sent the request; the OTHER side is the
 * addressee and the only one allowed to accept.
 */
export interface Friendship {
  userA: UserId;
  userB: UserId;
  status: FriendshipStatus;
  requestedBy: UserId;
  createdAt: string;
  updatedAt: string | null;
}

/**
 * A direct-message conversation (ADR 0010 §1): a `friend_groups` row with
 * `kind === "dm"`, exactly two members, owning exactly one hidden text
 * channel. `streamId` is that channel — a DM reuses the entire channel-scoped
 * message + realtime pipeline unchanged, exactly like {@link Group}.
 * `participant` is the OTHER member, resolved server-side relative to the
 * caller: a DM's identity is the other person, never a name/icon. Closing a
 * DM only hides the caller's copy (`hidden_at`); history is never destroyed.
 */
export interface Dm {
  id: DmId;
  streamId: ChannelId;
  participant: User;
  createdAt: string;
}

/**
 * The viewer→target relationship as shown on a profile card:
 * - `"none"`     — no friendship row; the card offers "Add friend".
 * - `"incoming"` — the target requested the viewer; the card offers "Accept".
 * - `"outgoing"` — the viewer requested the target; the card offers "Cancel".
 * - `"friends"`  — accepted; the card enables "Message" (idempotent POST /dms).
 */
export type ProfileFriendshipStatus = "none" | "incoming" | "outgoing" | "friends";

/**
 * A server the viewer and the profile's target BOTH belong to — the "Mutual
 * servers" row on a profile card. Deliberately a minimal projection (identity +
 * icon), never the full {@link FriendGroup}: the card only needs to name and
 * badge the space, and the target's private per-server data must never ride
 * along (§28).
 */
export interface MutualServer {
  id: GroupId;
  name: string;
  iconUrl: string | null;
}

/**
 * Context-aware profile card, `GET /users/:id/profile?groupId=` (ADR 0010 §3).
 * `roles` is present ONLY when `groupId` names a `kind === "server"` space
 * that BOTH the viewer and the target belong to — a stranger's card, or a
 * server the viewer is not in, never leaks that server's roles.
 *
 * `mutualServers` lists the `kind === "server"` spaces the viewer shares with
 * the target and is present ONLY on ANOTHER user's card (never the viewer's own
 * — you are not "mutual" with yourself). Additive/optional so older fixtures and
 * the self card keep compiling; the server omits it for the self case.
 */
export interface UserProfile {
  user: User;
  friendship: ProfileFriendshipStatus;
  roles?: Role[];
  mutualServers?: MutualServer[];
  /**
   * True when the VIEWER has blocked the target (M18) — the card renders
   * "Unblock" instead of "Message"/"Add friend". Deliberately one-directional:
   * whether the TARGET blocked the viewer is never exposed, because telling
   * someone they have been blocked is exactly the information a block is meant to
   * withhold (§28). Optional + additive; the server always emits it for another
   * user's card.
   */
  blocked?: boolean;
}

// ---------------------------------------------------------------------------
// DM calls (ADR 0012 — private 1-1 voice / video / screen, group upgrade)
// ---------------------------------------------------------------------------

/**
 * A DM call's id — a fresh uuid per call attempt, and the seed of its LiveKit
 * room name (`dmcall:<CallId>`). A plain string alias like every other id in
 * this module ({@link UserId}, {@link GroupId}, …): callers pass uuids, and the
 * protocol `dmCallSchema` mirrors it as `z.string()` so the compile-time
 * schema-vs-domain sync checks (see @demli/protocol) hold.
 */
export type CallId = string;

/**
 * The media a call is STARTED with (ADR 0012 §4). Screen share is an in-call
 * capability, never a distinct call kind — a `"audio"` call can start a screen
 * share exactly like a voice channel can. Video calls simply publish a camera
 * track from the start.
 */
export type CallMedia = "audio" | "video";

/**
 * Lifecycle of a {@link DmCall} row (ADR 0012 §7). At most one row per DM is
 * "live" (`ringing` | `active`), enforced by a partial unique index.
 * - `ringing`   — invite sent, awaiting the callee (bounded by `expiresAt`).
 * - `active`    — accepted; media flowing (`startedAt` set).
 * - `ended`     — a participant hung up (`endedAt` set).
 * - `missed`    — ring timed out with no accept.
 * - `declined`  — the callee rejected the invite.
 * - `canceled`  — the caller withdrew before an accept.
 * - `upgraded`  — a third person was added; the call moved into a new group and
 *   `upgradedToGroupId` links it. Media never dropped for the two originals.
 */
export type CallStatus =
  | "ringing"
  | "active"
  | "ended"
  | "missed"
  | "declined"
  | "canceled"
  | "upgraded";

/**
 * Why a call ended, carried by the `call.ended` event (ADR 0012 §4). One event
 * collapses every terminal path (mirroring how `friend.removed` collapses
 * decline/cancel/unfriend): the recipient always knows its own role, so the
 * callee that gets `"canceled"` stops ringing and the caller that gets
 * `"declined"` shows "declined". `"upgraded"` is the non-terminal-for-media
 * case — the call log row closes but the two originals keep talking in the new
 * group.
 */
export type CallEndReason =
  | "declined"
  | "canceled"
  | "timeout"
  | "hung_up"
  | "busy"
  | "failed"
  | "upgraded";

/**
 * What a ring is FOR (ADR 0012 §4/§6). A discriminated union so the SAME
 * `call.invite` covers both a fresh DM call and the group-upgrade ring:
 * - `"dm"`    — a 1-1 call in the DM `dmId`.
 * - `"group"` — the upgrade ring to a third person: join `voiceChannelId` in the
 *   freshly created `groupId`. That voice channel's LiveKit room is the ongoing
 *   call's room, so accepting lands the invitee in the live call.
 */
export type CallTarget =
  | { kind: "dm"; dmId: DmId }
  | { kind: "group"; groupId: GroupId; voiceChannelId: ChannelId };

/**
 * A DM call attempt — the persisted control-plane record and the live-call
 * source of truth (ADR 0012 §7). One row per attempt; the `dm_calls` partial
 * unique index guarantees at most one live (`ringing`|`active`) row per DM.
 *
 * `roomName` is the ephemeral LiveKit room (`dmcall:<id>`), NOT a `channels`
 * row — media runs there and the single-session registry keys on it unchanged.
 * `upgradedToGroupId` is set only when the call upgraded into a group. Timestamps
 * are ISO-8601 strings at the boundary (null until the corresponding transition:
 * `startedAt` on accept, `endedAt` on any terminal outcome).
 */
export interface DmCall {
  id: CallId;
  dmId: DmId;
  /** Ephemeral LiveKit room name, `dmcall:<id>`. Never a channel id. */
  roomName: string;
  callerId: UserId;
  calleeId: UserId;
  media: CallMedia;
  status: CallStatus;
  /** The group a call was upgraded into (ADR 0012 §6); null otherwise. */
  upgradedToGroupId: GroupId | null;
  createdAt: string;
  /** Ring deadline (`createdAt + RING_TIMEOUT`); null once no longer ringing. */
  expiresAt: string | null;
  /** Set when the call is accepted (status → active); null while ringing. */
  startedAt: string | null;
  /** Set on any terminal outcome; null while live. */
  endedAt: string | null;
}

/**
 * What a {@link NotificationMute} silences:
 * - `"channel"` — one text channel; `targetId` is a `channels` row id.
 * - `"group"`   — a whole server / group chat / DM; `targetId` is a
 *   `friend_groups` row id. A group mute covers every channel under it unless a
 *   more-specific channel mute overrides it.
 */
export type NotificationMuteScope = "channel" | "group";

/**
 * How hard a {@link NotificationMute} silences a target — two levels:
 * - `"all"`      — no message/mention push, unread badge suppressed entirely.
 * - `"mentions"` — only direct `@mention` notifications pass; plain messages are
 *   silenced and only a mention badge shows.
 *
 * DM-call rings (`call.invite`) are NEVER affected by either mode — a call
 * always rings.
 */
export type NotificationMuteMode = "all" | "mentions";

/**
 * A per-user notification mute on a channel or a whole group/server (the
 * "Kanalı Sustur" / "Sunucuyu Sustur" actions). One row per (user, scope, target); setting a
 * mute upserts, unmuting deletes. Precedence when both apply to a channel: the
 * channel-scope row wins over the group-scope row (most specific).
 *
 * `until` is the ISO instant the mute auto-expires (the "15 min / 1 h / 8 h"
 * presets); `null` means indefinite. An elapsed `until` is treated as unmuted
 * everywhere (the push filter and the clients ignore it) without a delete.
 */
export interface NotificationMute {
  userId: UserId;
  scope: NotificationMuteScope;
  /** A `channels` id (scope="channel") or a `friend_groups` id (scope="group"). */
  targetId: string;
  mode: NotificationMuteMode;
  /** ISO auto-expiry instant, or `null` for an indefinite mute. */
  until: string | null;
  createdAt: string;
  updatedAt: string | null;
}

// ---------------------------------------------------------------------------
// M18 — server structure (channel categories), blocking, moderation audit log
// ---------------------------------------------------------------------------

/** A `channel_categories` row id (migration 0019). */
export type CategoryId = string;

/**
 * A sidebar CATEGORY that groups a server's channels ("GENEL", "SES", …).
 * Servers only (`kind === "server"`); flat group chats and DMs own
 * exactly one hidden stream channel and never have categories.
 *
 * Categories are PURELY ORGANIZATIONAL: they carry no permissions of their own
 * and never affect channel visibility, which stays the M9 `channel_role_access`
 * model (ADR 0007). Membership is the nullable `Channel.categoryId` — a channel
 * with none stays in the top-level list, so every pre-M18 server renders exactly
 * as before.
 */
export interface ChannelCategory {
  id: CategoryId;
  groupId: GroupId;
  /** 1..64 chars, validated at the API boundary. */
  name: string;
  /** Sort order among the server's categories (ascending, ties broken by id). */
  position: number;
  createdAt: string;
}

/**
 * A DIRECTIONAL block: `blockerId` has blocked `blockedId` (M18). Blocking is
 * one-sided by construction — each side may block independently — but almost
 * every ENFORCEMENT point treats a block as symmetric ("a block exists in either
 * direction"), so a blocked user can neither reach nor be reached by the blocker.
 *
 * Surfaces a block cuts (see ADR 0017): DM sends both ways, friend requests,
 * mention/message pushes, message search + channel history in shared servers,
 * add-by-username, DM calls, and group-DM invite redemption.
 */
export interface UserBlock {
  blockerId: UserId;
  blockedId: UserId;
  createdAt: string;
}

/** A blocked user as returned by `GET /users/me/blocks` — the row + who it names. */
export interface BlockedUser {
  user: User;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Private per-viewer annotations + ignore (migration 0020, ADR 0019)
// ---------------------------------------------------------------------------

/**
 * A private note one user keeps about another (`user_notes`).
 *
 * **Only `viewerId` may ever read this.** It is not part of any profile, roster,
 * message or realtime projection, and the person it is ABOUT has no endpoint
 * that returns it — that is the whole feature, not a nice-to-have. The `viewerId`
 * field exists on the DTO only because the repository returns rows; the API never
 * hands a note to anyone but its author (ADR 0019 §1).
 */
export interface UserNote {
  viewerId: UserId;
  targetId: UserId;
  /** ≤256 chars, stored raw and escaped at render time like message content. */
  body: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A private nickname one user gives another (`user_nicknames`) — a per-viewer
 * "friend nickname". Visible ONLY to `viewerId`; the target is never
 * told and never sees it.
 *
 * Distinct from {@link FriendGroupMember.nickname}, which is the per-SERVER
 * nickname everyone in that server sees. Display precedence for a name is:
 * personal nickname → server nickname → `displayName` (ADR 0019 §2).
 */
export interface UserNickname {
  viewerId: UserId;
  targetId: UserId;
  /** ≤32 chars. Never null in a stored row — clearing deletes the row. */
  nickname: string;
  createdAt: string;
  updatedAt: string;
}

/** A personal nickname hydrated with the user it renames, for bulk client sync. */
export interface UserNicknameEntry {
  user: User;
  nickname: string;
  updatedAt: string;
}

/**
 * A ONE-DIRECTIONAL, silent ignore: `ignorerId` no longer wants to be notified
 * by `ignoredId` (`user_ignores`, migration 0020).
 *
 * Deliberately NOT a block (ADR 0019 §4). A block is symmetric, severs the
 * friendship, refuses sends with a `BLOCKED` error, and hides history
 * server-side. An ignore does none of that: the ignored user notices nothing at
 * all — their messages still send, still deliver, still appear in history. What
 * changes is only on the ignorer's side: no push, no in-app mention alert, and
 * the client collapses their message rows.
 */
export interface UserIgnore {
  ignorerId: UserId;
  ignoredId: UserId;
  createdAt: string;
}

/** An ignored user as returned by `GET /users/me/ignores` — the row + who it names. */
export interface IgnoredUser {
  user: User;
  createdAt: string;
}

/**
 * The moderation actions recorded in the audit log (M18). Deliberately a closed
 * string union rather than a pg enum, so migration 0019 stays a pure additive
 * `CREATE TABLE` with no `CREATE TYPE`, and a future action needs no migration.
 */
export type ModerationActionType =
  | "kick"
  | "ban"
  | "unban"
  | "voice_disconnect"
  // Migration 0020 (ADR 0019): a timeout applied, and a timeout lifted early.
  // Two values, not one: "who muted them" and "who let them back in" are
  // different accountability questions, and a log that answers only the first
  // cannot explain why a 24-hour timeout ended after ten minutes.
  | "timeout"
  | "timeout_remove";

/**
 * One entry in a server's moderation audit log (`moderation_actions`). Written
 * by the moderation endpoints on EVERY successful action; readable by
 * owner ∨ KICK_MEMBERS via `GET /groups/:groupId/moderation-log`.
 *
 * `actorId` is nullable so purging a moderator's account never destroys the
 * record of what was done (ON DELETE SET NULL, mirroring `group_bans.banned_by`).
 */
export interface ModerationAction {
  id: string;
  groupId: GroupId;
  /** Who performed it; null once that account is hard-purged. */
  actorId: UserId | null;
  /** Who it was performed on. */
  targetId: UserId;
  action: ModerationActionType;
  /** Optional moderator note (≤512 chars), or null. */
  reason: string | null;
  /**
   * `timeout` only: the ISO instant the mute was set to expire, so the log line
   * can read "timed out until 18:40" rather than just "timed out" (migration
   * 0020). Null for every other action.
   */
  expiresAt: string | null;
  createdAt: string;
}

/** A moderation-log entry hydrated with the actor/target user records for display. */
export interface ModerationActionEntry {
  action: ModerationAction;
  actor: User | null;
  target: User | null;
}
