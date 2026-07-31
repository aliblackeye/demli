/**
 * Per-session throttle for the `sessions.last_seen_at` bump (M15-A).
 *
 * The auth middleware runs on EVERY authenticated request; writing
 * `last_seen_at` each time would put a needless UPDATE on the hot path (§27).
 * This gate answers "has enough time passed to write again for this session?"
 * from a small in-process map, so at most one bump per `windowMs` per session
 * touches Postgres. It is a freshness optimization, never a correctness
 * boundary: the API is a single process, and a lost entry only means one extra
 * (harmless) write. Mirrors the in-memory `LoginRateLimiter` /
 * `InMemorySlowmodeStore` precedents rather than reaching for Redis.
 */
export class LastSeenThrottle {
  private readonly lastTouchedMs = new Map<string, number>();

  constructor(
    private readonly windowMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
    /** Prune the map once it grows past this many sessions (memory guard). */
    private readonly maxEntries = 10_000,
  ) {}

  /**
   * Returns true (and records "now") when `sessionId` has not been touched
   * within the window — the caller should write `last_seen_at`. Returns false
   * when a bump happened recently — the caller should skip the write.
   */
  shouldTouch(sessionId: string): boolean {
    const t = this.now();
    const prev = this.lastTouchedMs.get(sessionId);
    if (prev !== undefined && t - prev < this.windowMs) return false;
    if (this.lastTouchedMs.size >= this.maxEntries) this.prune(t);
    this.lastTouchedMs.set(sessionId, t);
    return true;
  }

  /** Drop entries whose window has fully elapsed; they can only return true. */
  private prune(nowMs: number): void {
    for (const [id, ts] of this.lastTouchedMs) {
      if (nowMs - ts >= this.windowMs) this.lastTouchedMs.delete(id);
    }
  }
}
