/**
 * `userId → the name to render` for the CURRENT server, applying the ADR 0019
 * §2 precedence (private nickname → server nickname → displayName) exactly once
 * per surface instead of once per row.
 *
 * Both nickname layers are already in memory — the private map is a single
 * cached query and the server nicknames ride on the roster the sidebar loads
 * anyway — so this is a `useMemo` over two arrays, not a request. Building it
 * ONCE per provider and handing every row a plain string lookup is what keeps a
 * rename from turning into a per-row query or a per-row `resolveUserName` call
 * (§27).
 *
 * Only entries that actually OVERRIDE something appear in the map. A user with
 * no nickname anywhere is absent, so callers can keep their existing
 * `displayName` path as the fallback and the map stays small.
 */

import { useMemo } from "react";
import { resolveUserName } from "@demli/client-core";
import type { GroupId, UserId } from "@demli/types";
import { useGroupDetails } from "../queries/chat-queries";
import { usePrivateNicknames } from "../queries/social-queries";

export type NameOverrides = Record<UserId, string>;

/** Stable empty map so a surface with no overrides never churns its consumers. */
const EMPTY: NameOverrides = Object.freeze({});

/**
 * The name overrides in force for `groupId` (pass null outside a server — the
 * private layer still applies, because a private nickname follows the person
 * across every surface).
 */
export function useNameOverrides(groupId: GroupId | null): NameOverrides {
  const { data: privateNicknames } = usePrivateNicknames();
  const { data: details } = useGroupDetails(groupId);
  const members = details?.members;

  return useMemo(() => {
    const serverNicknames = new Map<UserId, string>();
    for (const member of members ?? []) {
      if (member.nickname) serverNicknames.set(member.userId, member.nickname);
    }
    const ids = new Set<UserId>([
      ...Object.keys(privateNicknames ?? {}),
      ...serverNicknames.keys(),
    ]);
    if (ids.size === 0) return EMPTY;

    const overrides: NameOverrides = {};
    for (const id of ids) {
      // No `displayName` here on purpose: this map holds only overrides, so a
      // resolution that falls through to the real name yields nothing and the
      // caller keeps its own displayName path.
      const name = resolveUserName({
        privateNickname: privateNicknames?.[id] ?? null,
        serverNickname: serverNicknames.get(id) ?? null,
      });
      if (name) overrides[id] = name;
    }
    return overrides;
  }, [privateNicknames, members]);
}
