/**
 * M9 roles & permissions endpoints (ADR 0007). Servers only — every route
 * 404s on a flat group chat (via {@link loadServer}). Authorization lives in
 * `../../lib/permissions.js`; routes never inline role conditionals.
 *
 * Routes:
 *   GET    /groups/:groupId/roles                     member
 *   POST   /groups/:groupId/roles                     owner ∨ MANAGE_ROLES (+ escalation)
 *   PATCH  /groups/:groupId/roles/:roleId             owner ∨ MANAGE_ROLES (+ escalation)
 *   DELETE /groups/:groupId/roles/:roleId             owner ∨ MANAGE_ROLES (+ escalation)
 *   PUT    /groups/:groupId/members/:userId/roles     owner ∨ MANAGE_ROLES (+ escalation, no guests)
 *   GET    /channels/:channelId/access                owner ∨ MANAGE_CHANNELS
 *   PUT    /channels/:channelId/access                owner ∨ MANAGE_CHANNELS
 *
 * Every mutation publishes its thin typed event on the group-scoped mutation
 * bus (role.*, member.roles_updated, channel.access_changed). The gateway
 * resync (roles-gateway, plan #4) consumes them; this module only publishes.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RealtimeMutationPublisher } from "@demli/db";
import { serverEvent, type ServerToClientEvent } from "@demli/protocol";
import type { Role } from "@demli/types";
import { PERMISSIONS } from "@demli/types";
import { ApiError, parseWith } from "../../errors.js";
import { requireUser } from "../../plugins/auth.js";
import {
  ALL_PERMISSIONS,
  actorBits,
  assertGrantable,
  loadServer,
  requirePerm,
} from "../../lib/permissions.js";
import { LIST_LIMIT, userRateLimit } from "../../lib/rate-limit.js";

/**
 * Shared budget for every role/access MUTATION below. Each one publishes a
 * group-scoped mutation, which makes the gateway re-derive the visible channel
 * set for every connected member and diff their subscriptions — by far the most
 * server-work-per-request of any admin action here. Role admin is a rare, human,
 * one-at-a-time activity, so 30/min is unreachable in real use while stopping a
 * compromised owner session from driving a resync storm.
 */
const ROLE_MUTATION_RATE_LIMIT = userRateLimit({ max: 30, timeWindow: "1 minute" });

/** Role name bounds (ADR 0007: 1..32 chars). */
const ROLE_NAME_MAX_LENGTH = 32;
/** Safety cap on role-id lists (assignment sets, access lists). */
const ROLE_ID_LIST_MAX = 100;

const groupParamsSchema = z.object({
  groupId: z.string().uuid("Invalid group id."),
});

const roleParamsSchema = z.object({
  groupId: z.string().uuid("Invalid group id."),
  roleId: z.string().uuid("Invalid role id."),
});

const memberParamsSchema = z.object({
  groupId: z.string().uuid("Invalid group id."),
  userId: z.string().uuid("Invalid user id."),
});

const channelParamsSchema = z.object({
  channelId: z.string().uuid("Invalid channel id."),
});

const nameSchema = z.string().trim().min(1, "Role name is required.").max(ROLE_NAME_MAX_LENGTH);
const colorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Color must be a #rrggbb hex string.")
  .nullable();
const permissionsSchema = z
  .number()
  .int("Permissions must be an integer bitfield.")
  .min(0)
  .refine((bits) => (bits & ~ALL_PERMISSIONS) === 0, {
    message: "Permissions contains an unknown bit.",
  });
const roleIdListSchema = z
  .array(z.string().uuid("Invalid role id."))
  .max(ROLE_ID_LIST_MAX);

const createRoleSchema = z.object({
  name: nameSchema,
  color: colorSchema.optional(),
  permissions: permissionsSchema.optional(),
});

const updateRoleSchema = z
  .object({
    name: nameSchema.optional(),
    color: colorSchema.optional(),
    permissions: permissionsSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "Provide at least one field to update.",
  });

const setMemberRolesSchema = z.object({
  roleIds: roleIdListSchema,
});

const setChannelAccessSchema = z.object({
  /** Empty list = public to all members. */
  roleIds: roleIdListSchema,
});

export async function registerRolesModule(
  server: FastifyInstance,
  mutationBus?: RealtimeMutationPublisher,
): Promise<void> {
  // -- Role listing --------------------------------------------------------
  server.get(
    "/groups/:groupId/roles",
    {
      preHandler: [server.authenticate],
      config: { rateLimit: userRateLimit(LIST_LIMIT) },
    },
    async (request) => {
      const user = requireUser(request);
      const { groupId } = parseWith(groupParamsSchema, request.params);
      await loadServer(server, groupId, user.id); // member ∨ 404
      return { roles: await server.repos.roles.listForGroup(groupId) };
    },
  );

  // -- Role create ---------------------------------------------------------
  server.post(
    "/groups/:groupId/roles",
    { preHandler: [server.authenticate], config: { rateLimit: ROLE_MUTATION_RATE_LIMIT } },
    async (request, reply) => {
      const user = requireUser(request);
      const { groupId } = parseWith(groupParamsSchema, request.params);
      const body = parseWith(createRoleSchema, request.body);

      const { role } = await loadServer(server, groupId, user.id);
      await requirePerm(
        server,
        groupId,
        role,
        user.id,
        PERMISSIONS.MANAGE_ROLES,
        "You do not have permission to manage roles.",
      );
      const bits = body.permissions ?? 0;
      assertGrantable(role, await actorBits(server, groupId, role, user.id), bits);

      const created = await server.repos.roles.create({
        groupId,
        name: body.name,
        color: body.color ?? null,
        permissions: bits,
      });
      await publishGroupEvent(mutationBus, serverEvent.roleCreated({ role: created }), groupId);
      return reply.status(201).send({ role: created });
    },
  );

  // -- Role update ---------------------------------------------------------
  server.patch(
    "/groups/:groupId/roles/:roleId",
    { preHandler: [server.authenticate], config: { rateLimit: ROLE_MUTATION_RATE_LIMIT } },
    async (request) => {
      const user = requireUser(request);
      const { groupId, roleId } = parseWith(roleParamsSchema, request.params);
      const body = parseWith(updateRoleSchema, request.body);

      const { role } = await loadServer(server, groupId, user.id);
      await requirePerm(
        server,
        groupId,
        role,
        user.id,
        PERMISSIONS.MANAGE_ROLES,
        "You do not have permission to manage roles.",
      );

      const existing = await requireGroupRole(server, groupId, roleId);
      const bits = await actorBits(server, groupId, role, user.id);
      // Cannot touch a role carrying a bit you lack, nor raise it above your bits.
      assertGrantable(role, bits, existing.permissions);
      if (body.permissions !== undefined) {
        assertGrantable(role, bits, body.permissions);
      }

      const updated = await server.repos.roles.update(roleId, body);
      if (!updated) throw new ApiError(404, "NOT_FOUND", "Role not found.");
      await publishGroupEvent(mutationBus, serverEvent.roleUpdated({ role: updated }), groupId);
      return { role: updated };
    },
  );

  // -- Role delete ---------------------------------------------------------
  server.delete(
    "/groups/:groupId/roles/:roleId",
    { preHandler: [server.authenticate], config: { rateLimit: ROLE_MUTATION_RATE_LIMIT } },
    async (request, reply) => {
      const user = requireUser(request);
      const { groupId, roleId } = parseWith(roleParamsSchema, request.params);

      const { role } = await loadServer(server, groupId, user.id);
      await requirePerm(
        server,
        groupId,
        role,
        user.id,
        PERMISSIONS.MANAGE_ROLES,
        "You do not have permission to manage roles.",
      );

      const existing = await requireGroupRole(server, groupId, roleId);
      // Cannot delete a role carrying a bit you lack (owner bypasses).
      assertGrantable(role, await actorBits(server, groupId, role, user.id), existing.permissions);

      await server.repos.roles.delete(roleId);
      await publishGroupEvent(mutationBus, serverEvent.roleDeleted({ groupId, roleId }), groupId);
      return reply.status(204).send();
    },
  );

  // -- Member role assignment (replace-all) --------------------------------
  server.put(
    "/groups/:groupId/members/:userId/roles",
    { preHandler: [server.authenticate], config: { rateLimit: ROLE_MUTATION_RATE_LIMIT } },
    async (request) => {
      const user = requireUser(request);
      const { groupId, userId: targetUserId } = parseWith(memberParamsSchema, request.params);
      const body = parseWith(setMemberRolesSchema, request.body);

      const { role } = await loadServer(server, groupId, user.id);
      await requirePerm(
        server,
        groupId,
        role,
        user.id,
        PERMISSIONS.MANAGE_ROLES,
        "You do not have permission to manage roles.",
      );

      const target = await server.repos.groups.getMembership(groupId, targetUserId);
      if (!target) throw new ApiError(404, "NOT_FOUND", "Member not found.");
      if (target.role === "guest") {
        throw new ApiError(403, "FORBIDDEN", "Guests cannot be assigned roles.");
      }

      // Every requested role must belong to this server.
      const byId = new Map((await server.repos.roles.listForGroup(groupId)).map((r) => [r.id, r]));
      const requested = dedupe(body.roleIds);
      for (const id of requested) {
        if (!byId.has(id)) throw new ApiError(404, "NOT_FOUND", "Role not found.");
      }

      // Escalation guard: only roles whose membership actually changes are
      // gated, and each must be grantable by the actor — so a non-owner can
      // neither add nor strip a role above their own bits.
      const current = new Set(await server.repos.roles.roleIdsForMember(groupId, targetUserId));
      const next = new Set(requested);
      const bits = await actorBits(server, groupId, role, user.id);
      for (const [id, r] of byId) {
        const changed = current.has(id) !== next.has(id);
        if (changed) assertGrantable(role, bits, r.permissions);
      }

      await server.repos.roles.setMemberRoles(groupId, targetUserId, requested);
      const roleIds = await server.repos.roles.roleIdsForMember(groupId, targetUserId);
      await publishGroupEvent(
        mutationBus,
        serverEvent.memberRolesUpdated({ groupId, userId: targetUserId, roleIds }),
        groupId,
      );
      return { roleIds };
    },
  );

  // -- Channel access (visibility) -----------------------------------------
  server.get(
    "/channels/:channelId/access",
    {
      preHandler: [server.authenticate],
      config: { rateLimit: userRateLimit(LIST_LIMIT) },
    },
    async (request) => {
      const user = requireUser(request);
      const { channelId } = parseWith(channelParamsSchema, request.params);
      await loadManageableChannelGroup(server, channelId, user.id);
      return { roleIds: await server.repos.channelAccess.roleIdsForChannel(channelId) };
    },
  );

  server.put(
    "/channels/:channelId/access",
    { preHandler: [server.authenticate], config: { rateLimit: ROLE_MUTATION_RATE_LIMIT } },
    async (request) => {
      const user = requireUser(request);
      const { channelId } = parseWith(channelParamsSchema, request.params);
      const body = parseWith(setChannelAccessSchema, request.body);

      const { groupId } = await loadManageableChannelGroup(server, channelId, user.id);

      // Every access role must belong to this server (composite FK also guards
      // it, but a friendly 404 beats a raw constraint error).
      const requested = dedupe(body.roleIds);
      if (requested.length > 0) {
        const groupRoleIds = new Set(
          (await server.repos.roles.listForGroup(groupId)).map((r) => r.id),
        );
        for (const id of requested) {
          if (!groupRoleIds.has(id)) throw new ApiError(404, "NOT_FOUND", "Role not found.");
        }
      }

      await server.repos.channelAccess.setChannelRoles(groupId, channelId, requested);
      await publishGroupEvent(
        mutationBus,
        serverEvent.channelAccessChanged({ groupId, channelId }),
        groupId,
      );
      return { roleIds: requested };
    },
  );
}

/** Load a group role, or 404 when it does not belong to this server. */
async function requireGroupRole(
  server: FastifyInstance,
  groupId: string,
  roleId: string,
): Promise<Role> {
  const role = await server.repos.roles.findById(roleId);
  if (!role || role.groupId !== groupId) {
    throw new ApiError(404, "NOT_FOUND", "Role not found.");
  }
  return role;
}

/**
 * Resolve a channel the caller may MANAGE the access of: server-kind + member,
 * then owner ∨ MANAGE_CHANNELS. Deliberately does NOT require the caller to be
 * able to SEE the channel — otherwise a manager could not re-open a channel
 * they restricted themselves out of (ADR 0007 / plan §3). Returns its groupId.
 */
async function loadManageableChannelGroup(
  server: FastifyInstance,
  channelId: string,
  userId: string,
): Promise<{ groupId: string }> {
  const access = await server.repos.channels.findWithMembership(channelId, userId);
  if (!access) throw new ApiError(404, "NOT_FOUND", "Channel not found.");
  const group = await server.repos.groups.findById(access.channel.groupId);
  if (!group || group.kind !== "server") {
    throw new ApiError(404, "NOT_FOUND", "Channel not found.");
  }
  await requirePerm(
    server,
    group.id,
    access.role,
    userId,
    PERMISSIONS.MANAGE_CHANNELS,
    "You do not have permission to manage channels.",
  );
  return { groupId: group.id };
}

/**
 * Fan a group-scoped role/access event out on the mutation bus. Best-effort:
 * the DB write is the source of truth, so a failed publish never fails the
 * request (the publisher itself swallows and logs). The gateway routes it to
 * the group's connections and resyncs subscriptions (roles-gateway, plan #4).
 */
async function publishGroupEvent(
  bus: RealtimeMutationPublisher | undefined,
  event: ServerToClientEvent,
  groupId: string,
): Promise<void> {
  await bus?.publish({ groupId, event });
}

function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}
