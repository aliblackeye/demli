/**
 * Which of the four states a screen that edits ONE fetched entity is in.
 *
 * The admin screens (channel settings, role editor, member roles) read a list
 * query and pick one entity out of it. "Not loading and no entity" used to mean
 * "it no longer exists" — which is a lie when the request failed: offline, or a
 * 5xx, the screen told an owner their channel was gone and offered only Back.
 *
 * The order is load-bearing:
 *   1. an entity in hand always wins — a background refetch that fails must not
 *      throw away a form the user is looking at (the cache still holds it);
 *   2. a failed request is an ERROR with a retry, never "not found";
 *   3. a first fetch in flight (including retry back-off) is LOADING;
 *   4. only a request that SUCCEEDED without the entity is MISSING.
 *
 * A disabled query (no id in the route) is neither fetching nor failed, so it
 * lands on MISSING — a broken link, which is what the user should be told.
 */
export type EntityLoadState = "ready" | "error" | "loading" | "missing";

export interface EntityQueryFlags {
  /** TanStack `isLoading`: no data yet AND a fetch is in flight. */
  isLoading: boolean;
  /** TanStack `isError`: the last fetch failed (stays true while a retry runs). */
  isError: boolean;
}

export function resolveEntityLoadState(query: EntityQueryFlags, hasEntity: boolean): EntityLoadState {
  if (hasEntity) return "ready";
  if (query.isError) return "error";
  if (query.isLoading) return "loading";
  return "missing";
}

/**
 * The same rule for a LIST (the server's roles): "empty" only after a request
 * that SUCCEEDED with no items. Server settings used to read `roles ?? []`, so
 * while the roles were still loading — or after the request failed — an owner
 * was told "no roles yet" and offered to create one.
 *
 * Cached data always wins (a failed background refetch keeps the list). A
 * disabled query (no group id) is neither loading nor failed and lands on
 * "empty", exactly like `resolveEntityLoadState`'s "missing".
 */
export type ListLoadState = "ready" | "empty" | "error" | "loading";

export function resolveListLoadState(
  query: EntityQueryFlags,
  list: readonly unknown[] | undefined,
): ListLoadState {
  if (list !== undefined) return list.length > 0 ? "ready" : "empty";
  if (query.isError) return "error";
  if (query.isLoading) return "loading";
  return "empty";
}
