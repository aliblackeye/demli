/** Shared constants for the roles/members settings tabs (ADR 0007). */

import { useEffect } from "react";
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

/**
 * The 5 MVP permission bits with catalog KEYS for their copy, in display order.
 * Localized at render (RolesTab) so the list follows live locale switches.
 */
export const PERMISSION_ROWS = [
  {
    bit: "MANAGE_CHANNELS",
    labelKey: "desktop:permissions.manageChannels",
    descriptionKey: "desktop:permissions.manageChannelsDesc",
  },
  {
    bit: "MANAGE_MESSAGES",
    labelKey: "desktop:permissions.manageMessages",
    descriptionKey: "desktop:permissions.manageMessagesDesc",
  },
  {
    bit: "KICK_MEMBERS",
    labelKey: "desktop:permissions.kickMembers",
    descriptionKey: "desktop:permissions.kickMembersDesc",
  },
  {
    bit: "CREATE_INVITE",
    labelKey: "desktop:permissions.createInvite",
    descriptionKey: "desktop:permissions.createInviteDesc",
  },
  {
    bit: "MANAGE_ROLES",
    labelKey: "desktop:permissions.manageRoles",
    descriptionKey: "desktop:permissions.manageRolesDesc",
  },
] as const satisfies readonly {
  bit: PermissionName;
  labelKey: string;
  descriptionKey: string;
}[];

/**
 * How a tab with an editable draft talks to the dialog that hosts it: it
 * reports whether the draft is dirty (so the dialog can refuse to close or
 * switch tabs over it) and receives the dialog's `nudge` counter, bumped on
 * every refused attempt, to drive its unsaved-changes bar.
 */
export interface DraftGuard {
  onDirtyChange: (dirty: boolean) => void;
  nudge: number;
}

/** Report `dirty` to the host while mounted; clears it on unmount. */
export function useReportDirty(guard: DraftGuard | undefined, dirty: boolean): void {
  const onDirtyChange = guard?.onDirtyChange;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [onDirtyChange, dirty]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
}

/** Fallback dot colour for a role without one (data, not a theme colour). */
export const ROLE_COLOR_FALLBACK = "#95a5a6";

/** `#rrggbb` (case-insensitive) — the shape the role API stores. */
export const HEX_COLOR = /^#[0-9a-f]{6}$/i;
