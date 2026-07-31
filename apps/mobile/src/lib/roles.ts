/**
 * Shared constants for the mobile role editor / visibility screens (ADR 0007).
 * Mirrors the desktop renderer's server-settings/shared.ts so both platforms
 * offer the identical palette and permission set.
 */

import type { PermissionName } from "@demli/types";

/** Curated role-color swatches — premium, dark-first, avoids neon (CLAUDE.md §7). */
export const ROLE_COLORS = [
  "#f04747",
  "#f2711c",
  "#faa61a",
  "#f1c40f",
  "#43b581",
  "#2ecc71",
  "#1abc9c",
  "#3498db",
  "#5865f2",
  "#9b59b6",
  "#e91e63",
  "#95a5a6",
] as const;

/** Fallback dot color for a role that carries no color. */
export const ROLE_DOT_FALLBACK = "#95a5a6";

/** Max length of a role name, mirrored from the API validator. */
export const ROLE_NAME_MAX = 32;

/**
 * The 5 MVP permission bits with catalog KEYS for their copy, in display order.
 * Localized at render so the list follows live locale switches (ADR 0009).
 */
export const PERMISSION_ROWS = [
  {
    bit: "MANAGE_CHANNELS",
    labelKey: "mobile:permissions.manageChannels",
    descriptionKey: "mobile:permissions.manageChannelsDesc",
  },
  {
    bit: "MANAGE_MESSAGES",
    labelKey: "mobile:permissions.manageMessages",
    descriptionKey: "mobile:permissions.manageMessagesDesc",
  },
  {
    bit: "KICK_MEMBERS",
    labelKey: "mobile:permissions.kickMembers",
    descriptionKey: "mobile:permissions.kickMembersDesc",
  },
  {
    bit: "CREATE_INVITE",
    labelKey: "mobile:permissions.createInvite",
    descriptionKey: "mobile:permissions.createInviteDesc",
  },
  {
    bit: "MANAGE_ROLES",
    labelKey: "mobile:permissions.manageRoles",
    descriptionKey: "mobile:permissions.manageRolesDesc",
  },
] as const satisfies readonly {
  bit: PermissionName;
  labelKey: string;
  descriptionKey: string;
}[];
