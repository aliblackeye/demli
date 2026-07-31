/**
 * Row → domain mappers. Domain types (from @demli/types) carry ISO-8601
 * strings; rows carry Date objects. All repositories go through these.
 */

import {
  isAdult,
  type BlockedUser,
  type Channel,
  type ChannelCategory,
  type ChannelId,
  type ChannelRoleAccess,
  type IgnoredUser,
  type ModerationAction,
  type ModerationActionType,
  type UserBlock,
  type UserIgnore,
  type UserNickname,
  type UserNicknameEntry,
  type UserNote,
  type DevicePreference,
  type Dm,
  type DmCall,
  type FriendGroup,
  type FriendGroupMember,
  type Friendship,
  type Group,
  type GroupBan,
  type Invite,
  type MemberRoleAssignment,
  type Message,
  type NotificationMute,
  type NotificationMuteMode,
  type NotificationMuteScope,
  type PresencePlatform,
  type Role,
  type Server,
  type User,
} from "@demli/types";
import type {
  channelCategories,
  channelRoleAccess,
  channels,
  devicePreferences,
  moderationActions,
  userBlocks,
  userIgnores,
  userNicknames,
  userNotes,
  deviceTokens,
  dmCalls,
  friendGroupMembers,
  friendGroups,
  friendships,
  groupBans,
  invites,
  memberRoles,
  messages,
  notificationMutes,
  roles,
  sessions,
  users,
} from "./schema.js";

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type GroupRow = typeof friendGroups.$inferSelect;
export type MemberRow = typeof friendGroupMembers.$inferSelect;
export type ChannelRow = typeof channels.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type InviteRow = typeof invites.$inferSelect;
export type DevicePreferenceRow = typeof devicePreferences.$inferSelect;
export type RoleRow = typeof roles.$inferSelect;
export type MemberRoleRow = typeof memberRoles.$inferSelect;
export type ChannelRoleAccessRow = typeof channelRoleAccess.$inferSelect;
export type FriendshipRow = typeof friendships.$inferSelect;
export type GroupBanRow = typeof groupBans.$inferSelect;
export type DeviceTokenRow = typeof deviceTokens.$inferSelect;
export type DmCallRow = typeof dmCalls.$inferSelect;
export type NotificationMuteRow = typeof notificationMutes.$inferSelect;
export type ChannelCategoryRow = typeof channelCategories.$inferSelect;
export type UserBlockRow = typeof userBlocks.$inferSelect;
export type ModerationActionRow = typeof moderationActions.$inferSelect;
export type UserNoteRow = typeof userNotes.$inferSelect;
export type UserNicknameRow = typeof userNicknames.$inferSelect;
export type UserIgnoreRow = typeof userIgnores.$inferSelect;

/** Client OS for a registered push device (task #46). */
export type DevicePlatform = "ios" | "android";

/**
 * A registered Expo push device (task #46). Backend-only shape (like
 * {@link Session}) — no protocol event carries it; the mobile client only ever
 * sends its token, never receives the row back in full.
 */
export interface DeviceToken {
  id: string;
  userId: string;
  token: string;
  platform: DevicePlatform;
  createdAt: string;
  lastSeenAt: string;
}

/**
 * Backend-only session shape (never exposed to clients — `tokenHash` in
 * particular must never leave the server). The M15-A metadata columns
 * (`deviceName`, `platform`, `lastSeenAt`) are safe to surface; the sessions
 * module projects them into a `SessionSummary` DTO that omits `tokenHash`.
 */
export interface Session {
  id: string;
  userId: string;
  tokenHash: string;
  /** Client-declared device label (M15-A); null when the client omitted it. */
  deviceName: string | null;
  /** Client surface the session was issued to (M15-A); null when undeclared. */
  platform: PresencePlatform | null;
  /** Last authenticated request instant (M15-A), ISO-8601. */
  lastSeenAt: string;
  createdAt: string;
  expiresAt: string;
}

/**
 * User plus the server-only auth/lifecycle fields — for auth flows ONLY, never
 * returned by the API. `passwordHash` is `null` for a Google-only account
 * (0010): the login handler must treat null as "no password set" and reject the
 * password path. `deletedAt`/`purgeAt` (M15) drive the frozen-account login gate:
 * a non-null `deletedAt` within the `purgeAt` window is reactivatable, past it is
 * rejected as invalid. None of these three fields is ever emitted on the wire.
 */
export type UserAuthRecord = User & {
  passwordHash: string | null;
  deletedAt: string | null;
  purgeAt: string | null;
};

const iso = (d: Date): string => d.toISOString();
const isoOrNull = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    // Always emitted (null when unset), per ADR 0010 §3. `friendCode` is
    // DELIBERATELY omitted here — it is me-only; use {@link toSelfUser}.
    bio: row.bio,
    // PUBLIC (M15) — the profile banner is shown on everyone's card. Always
    // emitted, null when unset.
    bannerUrl: row.bannerUrl,
    // Custom status (M18) — PUBLIC, always emitted. The expiry is applied HERE,
    // in the single mapper every user projection funnels through, so an elapsed
    // status can never reach the wire (no sweep job needed): both fields read as
    // null the moment `custom_status_expires_at` passes.
    ...customStatusFields(row),
    createdAt: iso(row.createdAt),
  };
}

/**
 * Project the two custom-status columns with the expiry already applied (M18).
 * Returns `{ customStatus: null, customStatusExpiresAt: null }` when the status
 * is unset OR its deadline has elapsed, so every caller of {@link toUser} gets
 * the same "expired reads as absent" semantics for free.
 */
function customStatusFields(
  row: UserRow,
  now: Date = new Date(),
): { customStatus: string | null; customStatusExpiresAt: string | null } {
  const expiresAt = row.customStatusExpiresAt;
  const expired = expiresAt !== null && expiresAt.getTime() <= now.getTime();
  if (row.customStatus === null || row.customStatus.length === 0 || expired) {
    return { customStatus: null, customStatusExpiresAt: null };
  }
  return { customStatus: row.customStatus, customStatusExpiresAt: isoOrNull(expiresAt) };
}

/**
 * `/users/me` projection: {@link toUser} plus the ME-ONLY fields — the private
 * `friendCode` (ADR 0010 §6), the raw `birthdate`, and the derived `isAdult`
 * gate (M15). Never use for another user — those must not leak. The protocol
 * `userSchema` also strips all three on the wire as a second guard.
 */
export function toSelfUser(row: UserRow, now: Date = new Date()): User {
  return {
    ...toUser(row),
    friendCode: row.friendCode,
    birthdate: row.birthdate,
    isAdult: isAdult(row.birthdate, now),
  };
}

export function toUserAuthRecord(row: UserRow): UserAuthRecord {
  return {
    ...toUser(row),
    passwordHash: row.passwordHash,
    deletedAt: isoOrNull(row.deletedAt),
    purgeAt: isoOrNull(row.purgeAt),
  };
}

export function toFriendship(row: FriendshipRow): Friendship {
  return {
    userA: row.userA,
    userB: row.userB,
    status: row.status,
    requestedBy: row.requestedBy,
    createdAt: iso(row.createdAt),
    updatedAt: isoOrNull(row.updatedAt),
  };
}

export function toGroupBan(row: GroupBanRow): GroupBan {
  return {
    groupId: row.groupId,
    userId: row.userId,
    bannedBy: row.bannedBy,
    reason: row.reason,
    createdAt: iso(row.createdAt),
  };
}

export function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.userId,
    tokenHash: row.tokenHash,
    deviceName: row.deviceName,
    // The column is `text` with a type-level enum; narrow back to the union.
    platform: row.platform as PresencePlatform | null,
    lastSeenAt: iso(row.lastSeenAt),
    createdAt: iso(row.createdAt),
    expiresAt: iso(row.expiresAt),
  };
}

export function toGroup(row: GroupRow): FriendGroup {
  return {
    id: row.id,
    name: row.name,
    iconUrl: row.iconUrl,
    bannerUrl: row.bannerUrl,
    ownerId: row.ownerId,
    kind: row.kind,
    systemChannelId: row.systemChannelId,
    invitePolicy: row.invitePolicy,
    createdAt: iso(row.createdAt),
  };
}

/** Same row shape as {@link toGroup}; named for server-facing call sites. */
export function toServer(row: GroupRow): Server {
  return toGroup(row);
}

/**
 * Flat-chat projection of a `friend_groups` row (`kind === "group"`) plus the
 * id of its single hidden text channel — the group's message stream. The
 * `kind` discriminant is dropped: a Group is always a group.
 */
export function toGroupChat(row: GroupRow, streamId: ChannelId): Group {
  return {
    id: row.id,
    name: row.name,
    iconUrl: row.iconUrl,
    ownerId: row.ownerId,
    streamId,
    createdAt: iso(row.createdAt),
  };
}

/**
 * DM projection (ADR 0010 §1) of a `friend_groups` row (`kind === "dm"`): its
 * single stream channel id and the OTHER member, resolved by the caller. The
 * `kind`, `name`, and `dm_key` are dropped — a DM's identity is the other
 * person, never a name/icon.
 */
export function toDm(row: GroupRow, streamId: ChannelId, participant: User): Dm {
  return {
    id: row.id,
    streamId,
    participant,
    createdAt: iso(row.createdAt),
  };
}

export function toMember(row: MemberRow): FriendGroupMember {
  return {
    groupId: row.groupId,
    userId: row.userId,
    role: row.role,
    // Migration 0020. `nickname` is PUBLIC to this server (unlike `user_nicknames`)
    // so it belongs on the member DTO every roster already ships.
    nickname: row.nickname,
    // Emitted RAW — a past instant is mapped through, not normalized to null.
    // Whether a member is currently muted is decided by comparing this against
    // the clock at the moment it matters, and the API's `isTimedOut` helper is
    // the ONE place that comparison lives. A mapper that silently nulled an
    // expired value would move an authorization decision into a display layer.
    timedOutUntil: isoOrNull(row.timedOutUntil),
    joinedAt: iso(row.joinedAt),
  };
}

export function toChannel(row: ChannelRow): Channel {
  return {
    id: row.id,
    groupId: row.groupId,
    kind: row.kind,
    name: row.name,
    description: row.description,
    maxParticipants: row.maxParticipants,
    slowmodeSeconds: row.slowmodeSeconds,
    audioBitrateKbps: row.audioBitrateKbps,
    // Age-restricted channel flag (M15); always emitted.
    nsfw: row.nsfw,
    position: row.position,
    // Sidebar category (M18); null = uncategorized (top-level list, pre-M18 look).
    categoryId: row.categoryId,
    createdAt: iso(row.createdAt),
  };
}

/** A `channel_categories` row → the {@link ChannelCategory} DTO (M18). */
export function toChannelCategory(row: ChannelCategoryRow): ChannelCategory {
  return {
    id: row.id,
    groupId: row.groupId,
    name: row.name,
    position: row.position,
    createdAt: iso(row.createdAt),
  };
}

/** A `user_blocks` row → the {@link UserBlock} DTO (M18). */
export function toUserBlock(row: UserBlockRow): UserBlock {
  return {
    blockerId: row.blockerId,
    blockedId: row.blockedId,
    createdAt: iso(row.createdAt),
  };
}

/** A blocked user for `GET /users/me/blocks` — the named user + when it happened. */
export function toBlockedUser(row: UserBlockRow, user: UserRow): BlockedUser {
  return { user: toUser(user), createdAt: iso(row.createdAt) };
}

/** A `moderation_actions` row → the {@link ModerationAction} DTO (M18). */
export function toModerationAction(row: ModerationActionRow): ModerationAction {
  return {
    id: row.id,
    groupId: row.groupId,
    actorId: row.actorId,
    targetId: row.targetId,
    action: row.action as ModerationActionType,
    reason: row.reason,
    /** Migration 0020: set for `timeout`, null for every other action. */
    expiresAt: isoOrNull(row.expiresAt),
    createdAt: iso(row.createdAt),
  };
}

// --- Private per-viewer annotations + ignore (migration 0020, ADR 0019) ------

/** A `user_notes` row → the {@link UserNote} DTO. Only its `viewerId` may see it. */
export function toUserNote(row: UserNoteRow): UserNote {
  return {
    viewerId: row.viewerId,
    targetId: row.targetId,
    body: row.body,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/** A `user_nicknames` row → the {@link UserNickname} DTO (private to the viewer). */
export function toUserNickname(row: UserNicknameRow): UserNickname {
  return {
    viewerId: row.viewerId,
    targetId: row.targetId,
    nickname: row.nickname,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/** A personal nickname + the user it renames, for the viewer's bulk sync. */
export function toUserNicknameEntry(row: UserNicknameRow, user: UserRow): UserNicknameEntry {
  return { user: toUser(user), nickname: row.nickname, updatedAt: iso(row.updatedAt) };
}

/** A `user_ignores` row → the {@link UserIgnore} DTO. */
export function toUserIgnore(row: UserIgnoreRow): UserIgnore {
  return {
    ignorerId: row.ignorerId,
    ignoredId: row.ignoredId,
    createdAt: iso(row.createdAt),
  };
}

/** An ignored user for `GET /users/me/ignores` — the named user + when it started. */
export function toIgnoredUser(row: UserIgnoreRow, user: UserRow): IgnoredUser {
  return { user: toUser(user), createdAt: iso(row.createdAt) };
}

export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    channelId: row.channelId,
    authorId: row.authorId,
    content: row.content,
    kind: row.kind,
    // Raw reply FK (null when not a reply, ADR 0011 §2). The human-readable
    // `replyTo` preview is built by enrichment (api + gateway) from this id, not
    // here — the mapper only carries the id through.
    replyToMessageId: row.replyToMessageId,
    createdAt: iso(row.createdAt),
    updatedAt: isoOrNull(row.updatedAt),
    deletedAt: isoOrNull(row.deletedAt),
  };
}

export function toInvite(row: InviteRow): Invite {
  return {
    id: row.id,
    groupId: row.groupId,
    code: row.code,
    createdBy: row.createdBy,
    expiresAt: isoOrNull(row.expiresAt),
    maxUses: row.maxUses,
    useCount: row.useCount,
    createdAt: iso(row.createdAt),
    targetChannelId: row.targetChannelId,
  };
}

export function toDevicePreference(row: DevicePreferenceRow): DevicePreference {
  return {
    userId: row.userId,
    inputDeviceId: row.inputDeviceId,
    outputDeviceId: row.outputDeviceId,
    inputVolume: row.inputVolume,
    outputVolume: row.outputVolume,
  };
}

export function toRole(row: RoleRow): Role {
  return {
    id: row.id,
    groupId: row.groupId,
    name: row.name,
    color: row.color,
    position: row.position,
    // `bigint({ mode: "number" })` already yields a number; coerce defensively
    // in case a driver hands back the aggregate/bigint as a string.
    permissions: Number(row.permissions),
    createdAt: iso(row.createdAt),
  };
}

export function toMemberRoleAssignment(row: MemberRoleRow): MemberRoleAssignment {
  return {
    groupId: row.groupId,
    userId: row.userId,
    roleId: row.roleId,
    assignedAt: iso(row.assignedAt),
  };
}

export function toChannelRoleAccess(row: ChannelRoleAccessRow): ChannelRoleAccess {
  return {
    channelId: row.channelId,
    roleId: row.roleId,
    groupId: row.groupId,
  };
}

export function toDeviceToken(row: DeviceTokenRow): DeviceToken {
  return {
    id: row.id,
    userId: row.userId,
    token: row.token,
    // The column is `text` with a type-level enum; narrow back to the union.
    platform: row.platform as DevicePlatform,
    createdAt: iso(row.createdAt),
    lastSeenAt: iso(row.lastSeenAt),
  };
}

/**
 * `dm_calls` row → {@link DmCall} DTO (ADR 0012). `media`/`status` are `text`
 * columns with a type-level enum, so they already narrow to `CallMedia`/
 * `CallStatus`. Timestamps become ISO strings; the three lifecycle timestamps
 * and `upgradedToGroupId` are null until their transition fires.
 */
export function toDmCall(row: DmCallRow): DmCall {
  return {
    id: row.id,
    dmId: row.dmId,
    roomName: row.roomName,
    callerId: row.callerId,
    calleeId: row.calleeId,
    media: row.media,
    status: row.status,
    upgradedToGroupId: row.upgradedToGroupId,
    createdAt: iso(row.createdAt),
    expiresAt: isoOrNull(row.expiresAt),
    startedAt: isoOrNull(row.startedAt),
    endedAt: isoOrNull(row.endedAt),
  };
}

/**
 * `notification_mutes` row → {@link NotificationMute} DTO (migration 0013).
 * `scope`/`mode` are `text` columns with a type-level enum, so they already
 * narrow to the domain unions. `until` is null for an indefinite mute; timestamps
 * become ISO strings at the boundary.
 */
export function toNotificationMute(row: NotificationMuteRow): NotificationMute {
  return {
    userId: row.userId,
    scope: row.scope as NotificationMuteScope,
    targetId: row.targetId,
    mode: row.mode as NotificationMuteMode,
    until: isoOrNull(row.until),
    createdAt: iso(row.createdAt),
    updatedAt: isoOrNull(row.updatedAt),
  };
}
