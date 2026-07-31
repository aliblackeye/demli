/**
 * Shared authorization for M9 roles & permissions (ADR 0007). Every role,
 * channel-access, and channel-scoped endpoint routes through these helpers so
 * the owner-bypass, guest-deny, escalation-guard, and visibility rules live in
 * ONE place — never as inline conditionals scattered across routes.
 *
 * Rules (ADR 0007):
 * - The owner bypasses the bitfield entirely (grants everything).
 * - Guests hold no write permission and can never be assigned roles.
 * - Everyone else: effective permissions = bitwise OR of held roles.
 * - Escalation guard: a non-owner may only create/edit/assign roles whose bits
 *   are a subset of their own, and only the owner may hand out MANAGE_ROLES.
 * - Channel visibility: a restricted channel the caller's roles do not grant is
 *   answered as "not found" — its existence is never leaked.
 */

import type { FastifyInstance } from "fastify";
import type {
  Channel,
  ChannelId,
  FriendGroup,
  GroupId,
  MemberRole,
  PermissionBit,
  UserId,
} from "@demli/types";
import { PERMISSIONS, hasPermission } from "@demli/types";
import { ApiError } from "../errors.js";

/** Bitmask of every defined permission — the owner's effective set. */
export const ALL_PERMISSIONS: number = Object.values(PERMISSIONS).reduce(
  (acc, bit) => acc | bit,
  0,
);

export interface ServerAccess {
  group: FriendGroup;
  /** The caller's membership role in this server. */
  role: MemberRole;
}

/**
 * Resolve a SERVER (`kind === "server"`) the caller is a member of, or throw
 * 404. Non-members, missing groups, and flat group chats all answer the same
 * "Group not found." so neither membership nor kind is leaked (§28). The guard
 * for every role / invite-policy endpoint — flat chats have no roles.
 */
export async function loadServer(
  server: FastifyInstance,
  groupId: GroupId,
  userId: UserId,
): Promise<ServerAccess> {
  const membership = await server.repos.groups.getMembership(groupId, userId);
  if (!membership) throw new ApiError(404, "NOT_FOUND", "Group not found.");
  const group = await server.repos.groups.findById(groupId);
  if (!group || group.kind !== "server") {
    throw new ApiError(404, "NOT_FOUND", "Group not found.");
  }
  return { group, role: membership.role };
}

/**
 * True when the caller holds `bit`. Owner bypasses the bitfield; guests never
 * hold write permissions; everyone else is checked against the OR of their
 * roles.
 */
export async function hasPerm(
  server: FastifyInstance,
  groupId: GroupId,
  role: MemberRole,
  userId: UserId,
  bit: PermissionBit,
): Promise<boolean> {
  if (role === "owner") return true;
  if (role === "guest") return false;
  const bits = await server.repos.roles.effectivePermissions(groupId, userId);
  return hasPermission(bits, bit);
}

/** Throw 403 unless the caller holds `bit` (owner-bypass, guest-deny applied). */
export async function requirePerm(
  server: FastifyInstance,
  groupId: GroupId,
  role: MemberRole,
  userId: UserId,
  bit: PermissionBit,
  message = "You do not have permission to do this.",
): Promise<void> {
  if (!(await hasPerm(server, groupId, role, userId, bit))) {
    throw new ApiError(403, "FORBIDDEN", message);
  }
}

/**
 * The full permission set the caller can wield — the owner gets every bit, a
 * guest gets none, everyone else gets the OR of their roles. Basis for the
 * escalation guard.
 */
export async function actorBits(
  server: FastifyInstance,
  groupId: GroupId,
  role: MemberRole,
  userId: UserId,
): Promise<number> {
  if (role === "owner") return ALL_PERMISSIONS;
  if (role === "guest") return 0;
  return server.repos.roles.effectivePermissions(groupId, userId);
}

/**
 * Escalation guard: throw 403 unless the actor may create/edit/assign a role
 * carrying exactly `bits`. Owner may grant anything; a non-owner may only grant
 * a subset of their own bits, and MANAGE_ROLES is owner-only to distribute.
 */
export function assertGrantable(
  role: MemberRole,
  actor: number,
  bits: number,
): void {
  if (role === "owner") return;
  if ((bits & ~actor) !== 0) {
    throw new ApiError(
      403,
      "FORBIDDEN",
      "You cannot grant permissions you do not have yourself.",
    );
  }
  if ((bits & PERMISSIONS.MANAGE_ROLES) !== 0) {
    throw new ApiError(
      403,
      "FORBIDDEN",
      "Only the owner can grant the Manage Roles permission.",
    );
  }
}

export interface VisibleChannel {
  channel: Channel;
  /** The caller's membership role in the channel's group. */
  role: MemberRole;
  /**
   * The channel's explicit LiveKit room override (ADR 0012 §6), forwarded from
   * `channels.findWithMembership` — a SIBLING of the DTO, never a `Channel`
   * field, so it stays off the wire. The media token path resolves
   * `room = livekitRoom ?? channel.id`, which is what lets an upgraded group's
   * voice channel (and any reconnect) land in the ongoing call room. Null for
   * every ordinary channel; optional so mock repos that omit it read as "use the
   * channel id".
   */
  livekitRoom?: string | null;
  /**
   * The caller's timeout expiry in this channel's group (migration 0020),
   * forwarded raw from `channels.findWithMembership` — a past instant arrives
   * unchanged and `assertNotTimedOut` does the clock comparison.
   *
   * Carried on this struct so the message/reaction/voice gates cost no extra
   * query: the membership row was already read to resolve visibility. Optional so
   * mock repos that omit it read as "not timed out".
   */
  timedOutUntil?: Date | null;
}

/**
 * Resolve a channel the caller may SEE, or throw 404. Combines membership
 * (non-members / missing channels → 404) with the M9 visibility filter: a
 * restricted channel whose roles the caller lacks answers the SAME "Channel not
 * found." — a restricted channel never leaks its existence (ADR 0007). The
 * single guard for every channel-scoped HTTP read/write; the WS subscription
 * filter is necessary but not sufficient.
 */
export async function loadVisibleChannel(
  server: FastifyInstance,
  channelId: ChannelId,
  userId: UserId,
): Promise<VisibleChannel> {
  const access = await server.repos.channels.findWithMembership(channelId, userId);
  if (!access) throw new ApiError(404, "NOT_FOUND", "Channel not found.");
  const visible = await server.repos.channelAccess.canUserSeeChannel(
    access.channel.groupId,
    channelId,
    userId,
  );
  if (!visible) throw new ApiError(404, "NOT_FOUND", "Channel not found.");
  return {
    channel: access.channel,
    role: access.role,
    livekitRoom: access.livekitRoom,
    timedOutUntil: access.timedOutUntil,
  };
}
