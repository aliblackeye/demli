/**
 * `userId → the instant their mute lapses` for one server, for members whose
 * timeout is in force RIGHT NOW (ADR 0019 §3).
 *
 * Built ONCE per surface, not once per row (§27): the roster is already in the
 * group-details cache, so this is a memo plus a single expiry timer (see
 * `useActiveTimeouts`) rather than a request. Consumers get a plain map lookup.
 *
 * Expiry is a clock comparison here exactly as it is on the server — the API
 * evaluates `timed_out_until` at query time with no sweeper, so a client that
 * only refreshed on a refetch would keep showing a mute that has already lapsed.
 */

import { useMemo } from "react";
import { useActiveTimeouts } from "@demli/app-ui";
import type { GroupId, UserId } from "@demli/types";
import { useGroupDetails } from "../queries/chat-queries";

export type TimedOutMembers = Record<UserId, string>;

/** Stable empty map so a server with no timeouts never churns its consumers. */
const EMPTY: TimedOutMembers = Object.freeze({});

/**
 * The timeouts currently in force in `groupId` (pass null outside a server — a
 * timeout is per-server, so DMs and flat group chats always get an empty map).
 */
export function useTimedOutMembers(groupId: GroupId | null): TimedOutMembers {
  const { data: details } = useGroupDetails(groupId);
  const members = details?.members;

  // `useActiveTimeouts` needs a stable array reference, and it wants the raw
  // `timedOutUntil` — the "is it still in force" decision is entirely its own.
  const bearers = useMemo(
    () => (members ?? []).map((m) => ({ id: m.userId, timedOutUntil: m.timedOutUntil })),
    [members],
  );
  const activeIds = useActiveTimeouts(bearers);

  return useMemo(() => {
    if (activeIds.size === 0) return EMPTY;
    const map: TimedOutMembers = {};
    for (const bearer of bearers) {
      if (bearer.timedOutUntil && activeIds.has(bearer.id)) map[bearer.id] = bearer.timedOutUntil;
    }
    return map;
  }, [bearers, activeIds]);
}
