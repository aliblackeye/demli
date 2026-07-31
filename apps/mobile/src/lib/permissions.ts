/**
 * Client-side role/permission helpers (ADR 0007). Pure, RN-free. The mobile
 * mirror of the desktop renderer's lib/permissions.ts.
 *
 * IMPORTANT: every gate computed here is COSMETIC. The API is the sole
 * authority — it re-checks permissions, the escalation guard, and channel
 * visibility on every mutation (see apps/api/src/lib/permissions.ts). These
 * helpers only decide what to *show*, never what is *allowed*.
 */

import type { PermissionBitfield, Role, RoleId, UserId } from "@demli/types";
import { hasPermission, type PermissionBit } from "@demli/types";

/**
 * Effective permission bitfield for a member — the OR of every role they hold.
 * The owner bypass is the caller's responsibility (owners never go through this).
 */
export function effectivePermissions(
  roleIds: RoleId[] | undefined,
  rolesById: ReadonlyMap<RoleId, Role>,
): PermissionBitfield {
  let bits = 0;
  for (const id of roleIds ?? []) {
    const role = rolesById.get(id);
    if (role) bits |= role.permissions;
  }
  return bits;
}

/** True when `bits` grants `bit`, or `isOwner` (owners bypass the bitfield). */
export function can(
  isOwner: boolean,
  bits: PermissionBitfield,
  bit: PermissionBit,
): boolean {
  return isOwner || hasPermission(bits, bit);
}

/**
 * The member-name color for a member: the color of the highest-`position` role
 * they hold that carries a non-null color, or null (default text color).
 * Roles arrive pre-sorted by position from the API, but we don't rely on that.
 */
export function memberColor(
  roleIds: RoleId[] | undefined,
  rolesById: ReadonlyMap<RoleId, Role>,
): string | null {
  let best: Role | null = null;
  for (const id of roleIds ?? []) {
    const role = rolesById.get(id);
    if (!role || role.color === null) continue;
    if (best === null || role.position > best.position) best = role;
  }
  return best?.color ?? null;
}

/** Index a role list by id for O(1) lookups. */
export function indexRoles(roles: Role[] | undefined): Map<RoleId, Role> {
  return new Map((roles ?? []).map((role) => [role.id, role]));
}

/**
 * Build `userId → colorHex` for every member with a colored role. Members with
 * no colored role are omitted (callers fall back to the default text color).
 */
export function buildMemberColorMap(
  members: { userId: UserId; roleIds?: RoleId[] }[] | undefined,
  roles: Role[] | undefined,
): Map<UserId, string> {
  const rolesById = indexRoles(roles);
  const map = new Map<UserId, string>();
  for (const member of members ?? []) {
    const color = memberColor(member.roleIds, rolesById);
    if (color) map.set(member.userId, color);
  }
  return map;
}
