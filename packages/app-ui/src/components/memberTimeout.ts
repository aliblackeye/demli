/**
 * Client-side timeout (mute) state — ADR 0019 §3.
 *
 * The server evaluates expiry AT QUERY TIME (no cron, no sweeper), so a
 * `timedOutUntil` instant in the past is indistinguishable from "not timed out".
 * The client must behave the same way, or a badge goes stale the moment a mute
 * lapses and only clears on the next refetch — the UI would then claim someone
 * is silenced while the server happily accepts their messages.
 *
 * Two pieces:
 *   - {@link activeTimeouts}: pure. Who is timed out AT a given instant, plus the
 *     next instant at which that answer changes.
 *   - {@link useActiveTimeouts}: ONE timer for the whole surface, armed at that
 *     next instant. Not one timer per row (§27) — a roster of fifty members with
 *     one mute arms exactly one timeout.
 */

import { useEffect, useMemo, useState } from "react";

/** Anything carrying the membership timeout column; both the roster row and the DTO fit. */
export interface TimeoutBearer {
  readonly id: string;
  readonly timedOutUntil?: string | null;
}

export interface TimeoutSnapshot {
  /** Ids timed out at the evaluated instant. */
  active: ReadonlySet<string>;
  /**
   * Epoch ms of the EARLIEST still-future expiry, or null when nothing is timed
   * out. The only instant at which {@link activeTimeouts} can return something
   * different without the input changing — so it is the only instant worth a timer.
   */
  nextExpiryAt: number | null;
}

/** Stable empty set so a surface with no timeouts never churns its consumers. */
const EMPTY: ReadonlySet<string> = new Set<string>();

/**
 * Who is timed out at `now`, and when that answer next changes.
 *
 * Fail-open on an unparseable instant, matching `isTimedOut` in `@demli/types`:
 * a client that cannot read the value must not invent a mute. Enforcement is
 * server-side regardless — this drives a badge, never a permission.
 */
export function activeTimeouts(members: readonly TimeoutBearer[], now: number): TimeoutSnapshot {
  let active: Set<string> | null = null;
  let nextExpiryAt: number | null = null;

  for (const member of members) {
    const until = member.timedOutUntil;
    if (until === null || until === undefined) continue;
    const at = Date.parse(until);
    if (Number.isNaN(at)) continue;
    // Expiry is a strict comparison against the clock — a lapsed instant reads
    // exactly like null, with no grace window in which a dead mute still shows.
    if (at <= now) continue;
    (active ??= new Set<string>()).add(member.id);
    if (nextExpiryAt === null || at < nextExpiryAt) nextExpiryAt = at;
  }

  return { active: active ?? EMPTY, nextExpiryAt };
}

/**
 * Small cushion past the expiry instant before re-evaluating, so a timer that
 * fires a hair early (clock granularity) does not need a second pass.
 */
const EXPIRY_SLACK_MS = 250;

/**
 * Reactive {@link activeTimeouts}: the set of currently timed-out ids, which
 * empties itself as mutes lapse — without a refetch and without a per-row timer.
 *
 * `members` must be a stable reference (memoize it at the call site) or the
 * effect re-arms on every render.
 */
export function useActiveTimeouts(members: readonly TimeoutBearer[]): ReadonlySet<string> {
  const [evaluatedAt, setEvaluatedAt] = useState(() => Date.now());

  const { active, nextExpiryAt } = useMemo(
    () => activeTimeouts(members, evaluatedAt),
    [members, evaluatedAt],
  );

  useEffect(() => {
    if (nextExpiryAt === null) return;
    // Re-read the clock here rather than trusting `evaluatedAt`: the component
    // may have been mounted (or backgrounded) for a while before this ran.
    const delay = Math.max(0, nextExpiryAt - Date.now()) + EXPIRY_SLACK_MS;
    const handle = window.setTimeout(() => setEvaluatedAt(Date.now()), delay);
    return () => window.clearTimeout(handle);
  }, [nextExpiryAt]);

  return active;
}

/**
 * "Muted until …" for a tooltip. Date + time, because every preset from 60
 * seconds to a week uses the same string and a date alone would render "today"
 * for the short ones.
 */
export function formatTimeoutUntil(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  };
  try {
    return new Intl.DateTimeFormat(locale, options).format(date);
  } catch {
    return new Intl.DateTimeFormat("en", options).format(date);
  }
}
