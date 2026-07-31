/**
 * Role request bodies (ADR 0007) — create, update, member assignment.
 *
 * The permission bitfield's "no unknown bits" check stays on the API: the set of
 * defined permissions lives in `apps/api/src/lib/permissions.ts`, and a client
 * bundling the authoritative permission map would invite it to be treated as
 * authoritative. Here the field is bounded as a non-negative integer; the server
 * decides which bits exist.
 */

import { z } from "zod";
import { ROLE_ID_LIST_MAX, ROLE_NAME_MAX_LENGTH } from "@demli/config";
import { requireAtLeastOneField, hexColorField, uuidField } from "./common.js";
import { nameText, type TextField } from "./text.js";

/** Role name: 1..32, at least one visible character. */
export const roleNameField: TextField = nameText(ROLE_NAME_MAX_LENGTH);

/** `#rrggbb`, or `null` for "no colour". */
export const roleColorField = hexColorField.nullable();

/** A permission bitfield. Unknown-bit rejection is the API's job (see the file header). */
export const permissionBitsField = z.number().int().min(0);

/** A set of role ids (assignment set, channel access list). */
export const roleIdListField = z.array(uuidField).max(ROLE_ID_LIST_MAX);

/** `/groups/:groupId/roles/:roleId` routes. */
export const roleParamsSchema = z.object({ groupId: uuidField, roleId: uuidField });

/** `POST /groups/:groupId/roles`. */
export const createRoleBodySchema = z.object({
  name: roleNameField,
  color: roleColorField.optional(),
  permissions: permissionBitsField.optional(),
});

/** `PATCH /groups/:groupId/roles/:roleId`. */
export const updateRoleBodySchema = z
  .object({
    name: roleNameField.optional(),
    color: roleColorField.optional(),
    permissions: permissionBitsField.optional(),
  })
  .superRefine(requireAtLeastOneField);

/** `PUT /groups/:groupId/members/:userId/roles`. */
export const setMemberRolesBodySchema = z.object({ roleIds: roleIdListField });

export type CreateRoleBody = z.infer<typeof createRoleBodySchema>;
export type UpdateRoleBody = z.infer<typeof updateRoleBodySchema>;
export type SetMemberRolesBody = z.infer<typeof setMemberRolesBodySchema>;
