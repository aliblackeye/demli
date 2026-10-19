/**
 * Load state of a shell list (server details, DMs, group chats) derived from a
 * TanStack query result. Lives outside the provider component so it is unit
 * testable and the provider file exports components only.
 */
import type { GroupChatsStatus } from "@demli/app-ui";

/** The slice of a TanStack query result {@link listStatus} reads. */
interface ListQueryState {
  data: unknown;
  isError: boolean;
  isFetching: boolean;
}

/**
 * One rule for every shell list's load state, so the sidebars can never show
 * "nothing here" for a list that simply has not arrived:
 *   - data present → "ready" (a failed BACKGROUND refetch keeps the real rows)
 *   - no data, failed, not retrying → "error" (retry band)
 *   - otherwise (first fetch, or a retry in flight) → "pending" (skeleton)
 */
export function listStatus(query: ListQueryState): GroupChatsStatus {
  if (query.data !== undefined) return "ready";
  if (query.isError && !query.isFetching) return "error";
  return "pending";
}
