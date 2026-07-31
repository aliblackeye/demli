/**
 * Queue arithmetic + display formatting for the mobile Watch Party sheet
 * (M20, mobile parity wave).
 *
 * ## Why this is a copy and not an import
 *
 * The desktop/web twin of this file is `packages/app-ui/src/components/watchQueue.ts`.
 * `@demli/app-ui` is a react-dom package — its barrel re-exports `./components`,
 * which pulls `react-dom`, `lucide-react` and Radix into the module graph — so
 * importing it from Metro would drag a DOM renderer into the APK to reach four
 * pure functions, and the package's `exports` map offers no deep path to take
 * instead (`.` and `./tokens.css`, nothing else).
 *
 * That trade is only acceptable because NOTHING here is a cross-machine
 * agreement. The values two clients must agree on — drift tolerance, the seek
 * cooldown, the backoff ladder, the embed origin — all live in
 * `@demli/client-core` and are IMPORTED by both surfaces, never copied: a
 * phone and a laptop that disagreed about those would fight over one playhead.
 * These four decide which button is drawn and how a duration reads. A divergence
 * here shows a move arrow one row too far; it cannot desynchronize a room, and
 * the server applies a reorder as a FULL desired order against whatever it is
 * holding, so even a stale list converges instead of corrupting.
 *
 * Every function works on `itemId` strings, never on positions — the queue moves
 * underneath us (the host's `watch.ended` pops the head, a `watch.queue_updated`
 * can land between the render that drew a row and the tap that moves it), and an
 * index computed from the drawn list would then name a different video than the
 * one under the finger. An id names the same video however the list shifted; if
 * it is gone, the operation is a no-op, which is the honest outcome.
 */

/** One step towards the front of the queue (-1) or towards the back (+1). */
export type WatchQueueMove = -1 | 1;

/**
 * Whether `itemId` can move `delta` — false at the ends, and false for an id that
 * is not in the list.
 *
 * The UI asks this so a move control at the edge is not RENDERED (§35), rather
 * than rendering one that silently does nothing.
 */
export function canMoveQueueItem(
  itemIds: readonly string[],
  itemId: string,
  delta: WatchQueueMove,
): boolean {
  const from = itemIds.indexOf(itemId);
  if (from === -1) return false;
  const to = from + delta;
  return to >= 0 && to < itemIds.length;
}

/**
 * `itemId` moved one slot in `delta`'s direction.
 *
 * Returns a copy of the input unchanged when the move is not possible, so a
 * caller can cheaply skip a pointless round trip to the gateway.
 */
export function moveQueueItem(
  itemIds: readonly string[],
  itemId: string,
  delta: WatchQueueMove,
): string[] {
  const from = itemIds.indexOf(itemId);
  if (from === -1) return [...itemIds];
  const to = from + delta;
  if (to < 0 || to >= itemIds.length) return [...itemIds];
  const next = [...itemIds];
  const [moved] = next.splice(from, 1);
  // `moved` is defined — `from` was found by indexOf — but the compiler cannot
  // know that, and a non-null assertion here would be the one place this file
  // stopped being provably total.
  if (moved === undefined) return [...itemIds];
  next.splice(to, 0, moved);
  return next;
}

/**
 * `h:mm:ss` / `m:ss`, or null when the duration is not something we can honestly
 * state.
 *
 * Null in, null out — a missing duration renders NOTHING rather than "0:00",
 * because a wrong number next to a title reads as fact. Negative and non-finite
 * values take the same path for the same reason.
 */
export function formatWatchDuration(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined) return null;
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.floor(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return hrs > 0 ? `${hrs}:${pad(mins)}:${pad(secs)}` : `${mins}:${pad(secs)}`;
}

/**
 * The three ways search can be unavailable, plus the catch-all.
 *
 * They are kept apart because they clear on completely different timescales and a
 * user's next move differs for each: `disabled` never clears (this deployment has
 * no API key — paste a link, forever), `quota` clears at midnight Pacific (paste a
 * link today), `unavailable` may clear in a minute (try again). One shared "search
 * failed" string would make all three look like the same transient blip, and two
 * of them are not (§26).
 */
export type WatchSearchFailure = "disabled" | "quota" | "unavailable" | "unknown";

/** Map an API error code onto the failure the user is actually looking at. */
export function watchSearchFailure(code: string | null | undefined): WatchSearchFailure {
  switch (code) {
    case "WATCH_SEARCH_DISABLED":
      return "disabled";
    case "WATCH_SEARCH_QUOTA":
      return "quota";
    case "WATCH_SEARCH_UNAVAILABLE":
      return "unavailable";
    default:
      return "unknown";
  }
}
