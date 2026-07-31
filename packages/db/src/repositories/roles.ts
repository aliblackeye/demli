import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type {
  GroupId,
  MemberRoleAssignment,
  PermissionBitfield,
  Role,
  RoleId,
  UserId,
} from "@demli/types";
import type { Db } from "../client.js";
import { toMemberRoleAssignment, toRole } from "../mappers.js";
import { memberRoles, roles } from "../schema.js";

/**
 * Roles CRUD + assignment for server-scoped groups (ADR 0007). Ownership and
 * the escalation guard (who may grant which bits) are enforced at the API
 * boundary — this layer only persists. Cross-server assignment is impossible at
 * the DB level via the (role_id, group_id) composite FK, so callers cannot
 * corrupt the graph even with a bad id.
 */
export function rolesRepo(db: Db) {
  return {
    /**
     * Create a role, appended after the group's current highest position (so a
     * fresh role sorts last by default). Pass `position` to override.
     */
    async create(input: {
      groupId: GroupId;
      name: string;
      color?: string | null;
      permissions?: PermissionBitfield;
      position?: number;
    }): Promise<Role> {
      return db.transaction(async (tx) => {
        let position = input.position;
        if (position === undefined) {
          const [top] = await tx
            .select({ position: roles.position })
            .from(roles)
            .where(eq(roles.groupId, input.groupId))
            .orderBy(desc(roles.position))
            .limit(1);
          position = (top?.position ?? -1) + 1;
        }
        const [row] = await tx
          .insert(roles)
          .values({
            groupId: input.groupId,
            name: input.name,
            color: input.color ?? null,
            permissions: input.permissions ?? 0,
            position,
          })
          .returning();
        if (!row) throw new Error("insert roles returned no row");
        return toRole(row);
      });
    },

    async findById(roleId: RoleId): Promise<Role | null> {
      const [row] = await db.select().from(roles).where(eq(roles.id, roleId)).limit(1);
      return row ? toRole(row) : null;
    },

    /** Roles of a group in display order (position, then creation). */
    async listForGroup(groupId: GroupId): Promise<Role[]> {
      const rows = await db
        .select()
        .from(roles)
        .where(eq(roles.groupId, groupId))
        .orderBy(asc(roles.position), asc(roles.createdAt));
      return rows.map(toRole);
    },

    /**
     * Patch mutable fields. Only provided keys are written; `color` accepts null
     * to clear it. Returns the updated role, or null if it no longer exists.
     */
    async update(
      roleId: RoleId,
      patch: {
        name?: string;
        color?: string | null;
        permissions?: PermissionBitfield;
        position?: number;
      },
    ): Promise<Role | null> {
      const set: Partial<typeof roles.$inferInsert> = {};
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.color !== undefined) set.color = patch.color;
      if (patch.permissions !== undefined) set.permissions = patch.permissions;
      if (patch.position !== undefined) set.position = patch.position;
      if (Object.keys(set).length === 0) return this.findById(roleId);
      const [row] = await db
        .update(roles)
        .set(set)
        .where(eq(roles.id, roleId))
        .returning();
      return row ? toRole(row) : null;
    },

    /** Delete a role; its member_roles + channel_role_access rows FK-cascade. */
    async delete(roleId: RoleId): Promise<boolean> {
      const rows = await db
        .delete(roles)
        .where(eq(roles.id, roleId))
        .returning({ id: roles.id });
      return rows.length > 0;
    },

    /**
     * Reorder a group's roles by writing `position = index` for each id in
     * `orderedRoleIds`. Scoped to the group (a foreign id is silently ignored),
     * so it can never move another server's roles. Returns the new ordering.
     */
    async reorder(groupId: GroupId, orderedRoleIds: RoleId[]): Promise<Role[]> {
      await db.transaction(async (tx) => {
        for (const [index, roleId] of orderedRoleIds.entries()) {
          await tx
            .update(roles)
            .set({ position: index })
            .where(and(eq(roles.id, roleId), eq(roles.groupId, groupId)));
        }
      });
      return this.listForGroup(groupId);
    },

    /**
     * Grant a single role to a member (idempotent). The composite FKs reject the
     * write if the user is not a member of `groupId` or the role is not this
     * group's — so a bad grant throws rather than corrupting state.
     */
    async assign(
      groupId: GroupId,
      userId: UserId,
      roleId: RoleId,
    ): Promise<MemberRoleAssignment> {
      await db
        .insert(memberRoles)
        .values({ groupId, userId, roleId })
        .onConflictDoNothing();
      const [row] = await db
        .select()
        .from(memberRoles)
        .where(and(eq(memberRoles.roleId, roleId), eq(memberRoles.userId, userId)))
        .limit(1);
      if (!row) throw new Error("assign: member_roles row missing after insert");
      return toMemberRoleAssignment(row);
    },

    /** Revoke a single role from a member. Returns true when a row was removed. */
    async unassign(userId: UserId, roleId: RoleId): Promise<boolean> {
      const rows = await db
        .delete(memberRoles)
        .where(and(eq(memberRoles.roleId, roleId), eq(memberRoles.userId, userId)))
        .returning({ roleId: memberRoles.roleId });
      return rows.length > 0;
    },

    /**
     * Replace a member's full role set within a group (the PUT semantics of
     * `/members/:userId/roles`). Clears then re-inserts atomically. Invalid role
     * ids fail the composite FK and roll the transaction back.
     */
    async setMemberRoles(
      groupId: GroupId,
      userId: UserId,
      roleIds: RoleId[],
    ): Promise<MemberRoleAssignment[]> {
      return db.transaction(async (tx) => {
        await tx
          .delete(memberRoles)
          .where(and(eq(memberRoles.groupId, groupId), eq(memberRoles.userId, userId)));
        if (roleIds.length === 0) return [];
        const rows = await tx
          .insert(memberRoles)
          .values(roleIds.map((roleId) => ({ groupId, userId, roleId })))
          .returning();
        return rows.map(toMemberRoleAssignment);
      });
    },

    /** Full Role objects a member holds in a group (display order). */
    async rolesForMember(groupId: GroupId, userId: UserId): Promise<Role[]> {
      const rows = await db
        .select({ role: roles })
        .from(memberRoles)
        .innerJoin(roles, eq(roles.id, memberRoles.roleId))
        .where(and(eq(memberRoles.groupId, groupId), eq(memberRoles.userId, userId)))
        .orderBy(asc(roles.position), asc(roles.createdAt));
      return rows.map((r) => toRole(r.role));
    },

    /** Just the role ids a member holds in a group. */
    async roleIdsForMember(groupId: GroupId, userId: UserId): Promise<RoleId[]> {
      const rows = await db
        .select({ roleId: memberRoles.roleId })
        .from(memberRoles)
        .where(and(eq(memberRoles.groupId, groupId), eq(memberRoles.userId, userId)));
      return rows.map((r) => r.roleId);
    },

    /**
     * Every assignment in a group. Lets the members endpoint build each member's
     * `roleIds` from one query instead of N per-member lookups.
     */
    async listAssignmentsForGroup(groupId: GroupId): Promise<MemberRoleAssignment[]> {
      const rows = await db
        .select()
        .from(memberRoles)
        .where(eq(memberRoles.groupId, groupId));
      return rows.map(toMemberRoleAssignment);
    },

    /**
     * Effective permission bitfield for a member = bitwise OR of every role they
     * hold in the group (0 when they hold none). Single aggregate query. The
     * owner bypass is NOT applied here — the API grants the owner everything
     * before consulting this.
     */
    async effectivePermissions(
      groupId: GroupId,
      userId: UserId,
    ): Promise<PermissionBitfield> {
      const [row] = await db
        .select({
          perms: sql<string>`coalesce(bit_or(${roles.permissions}), 0)`,
        })
        .from(memberRoles)
        .innerJoin(roles, eq(roles.id, memberRoles.roleId))
        .where(and(eq(memberRoles.groupId, groupId), eq(memberRoles.userId, userId)));
      return Number(row?.perms ?? 0);
    },

    /**
     * Users in a group holding ANY of `roleIds`. Handy for fan-out when an
     * access change must notify exactly the members who gain/lose a channel.
     */
    async userIdsWithAnyRole(groupId: GroupId, roleIds: RoleId[]): Promise<UserId[]> {
      if (roleIds.length === 0) return [];
      const rows = await db
        .selectDistinct({ userId: memberRoles.userId })
        .from(memberRoles)
        .where(and(eq(memberRoles.groupId, groupId), inArray(memberRoles.roleId, roleIds)));
      return rows.map((r) => r.userId);
    },
  };
}

export type RolesRepo = ReturnType<typeof rolesRepo>;
