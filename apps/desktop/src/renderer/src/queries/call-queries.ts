/**
 * TanStack Query hooks for DM call history (Voice-UX #2). Read-only — the call
 * lifecycle itself runs through the shared controller (src/lib/call-controller),
 * not this cache. Keyset-paged newest-first via the `before` cursor, mirroring
 * the channel-message infinite query so pages never overlap (§22/§27).
 */

import { useInfiniteQuery } from "@tanstack/react-query";
import { api, type RecentCallsPage } from "../lib/api-client";
import { queryKeys } from "../lib/query-client";

/** Server default is 25 (clamped 1..50); one page fills the visible list. */
const RECENT_CALLS_PAGE_SIZE = 25;

/**
 * The signed-in user's recent calls, newest-first, infinite-scrolled. Each page
 * is `{ calls, nextCursor }`; `getNextPageParam` feeds the opaque cursor back as
 * `before`. Flatten with `data.pages.flatMap((p) => p.calls)`.
 */
export function useRecentCalls() {
  return useInfiniteQuery({
    queryKey: queryKeys.recentCalls,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }): Promise<RecentCallsPage> =>
      api.getRecentCalls({ before: pageParam, limit: RECENT_CALLS_PAGE_SIZE }),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}
