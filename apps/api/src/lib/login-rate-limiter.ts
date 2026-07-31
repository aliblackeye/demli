/**
 * Per-username login-failure throttle (security-review H1, second dimension).
 *
 * The @fastify/rate-limit on /auth/login keys on `request.ip`. That stops a
 * single IP from hammering, but it does NOT stop an account from being
 * brute-forced across many IPs (a botnet, or a single proxy IP whose bucket an
 * attacker deliberately fills to lock everyone out). This limiter adds a second
 * dimension keyed on the *username*: too many recent failed attempts for one
 * account are throttled regardless of source IP.
 *
 * In-memory and per-process — appropriate for the single-VPS topology. It is a
 * sliding window of failure timestamps; a successful login clears the account's
 * window so a legitimate user is never locked out by their own eventual success.
 */

/** Max failed attempts per username inside the window before throttling. */
export const LOGIN_MAX_FAILURES = 10;
/** Sliding window length for the per-username failure count. */
export const LOGIN_FAILURE_WINDOW_MS = 5 * 60 * 1000;
/** Safety cap: fully sweep the map if it grows past this many keys. */
const MAX_TRACKED_KEYS = 10_000;

export interface LoginRateLimiterOptions {
  maxFailures?: number;
  windowMs?: number;
}

export class LoginRateLimiter {
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly failures = new Map<string, number[]>();

  constructor(options: LoginRateLimiterOptions = {}) {
    this.maxFailures = options.maxFailures ?? LOGIN_MAX_FAILURES;
    this.windowMs = options.windowMs ?? LOGIN_FAILURE_WINDOW_MS;
  }

  /** True when the key already has >= maxFailures attempts inside the window. */
  isLimited(key: string, now: number = Date.now()): boolean {
    return this.recentFailures(key, now) >= this.maxFailures;
  }

  /** Record one failed attempt for the key. */
  recordFailure(key: string, now: number = Date.now()): void {
    if (this.failures.size > MAX_TRACKED_KEYS) this.sweep(now);
    const kept = this.prune(key, now);
    kept.push(now);
    this.failures.set(key, kept);
  }

  /** Clear the key's window — call on a successful login. */
  clear(key: string): void {
    this.failures.delete(key);
  }

  private recentFailures(key: string, now: number): number {
    return this.prune(key, now).length;
  }

  /** Drop timestamps outside the window for one key; returns the survivors. */
  private prune(key: string, now: number): number[] {
    const cutoff = now - this.windowMs;
    const kept = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
    if (kept.length === 0) this.failures.delete(key);
    else this.failures.set(key, kept);
    return kept;
  }

  /** Opportunistic full sweep to bound memory under a distinct-username flood. */
  private sweep(now: number): void {
    for (const key of this.failures.keys()) this.prune(key, now);
  }
}
