/**
 * YouTube Data API quota accounting for in-app watch-party search (M20 wave 2).
 *
 * Lives here, beside the watch-party session store, because it is the same kind
 * of thing: short-lived Redis counters with no schema and no migration. It is
 * NOT a rate limiter in the usual sense and must not be confused with one — the
 * per-route `@fastify/rate-limit` bucket protects OUR server from a hammering
 * client, while this protects a HARD EXTERNAL CEILING that no amount of our own
 * capacity can raise:
 *
 *   YouTube grants 10,000 units per project per day. `search.list` costs 100.
 *   That is ~100 searches per day for the ENTIRE deployment.
 *
 *     watch:ytquota:<dayKey>            = units spent today  (EX 2 days)
 *     watch:ytsearch:<dayKey>:<userId>  = searches by one user today (EX 2 days)
 *
 * ## Why Redis and not a process-local counter
 *
 * The unfurl service's per-user cap is process-local and that is correct there:
 * exceeding it costs one missing link preview. Exceeding THIS one costs every
 * member search for the rest of the calendar day, and a process-local counter
 * resets on every deploy — so a few deploys in an evening would silently let us
 * spend several times the budget. The counter has to outlive the process that
 * increments it.
 *
 * `dayKey` is computed by the caller (`youtubeQuotaDayKey`) in YouTube's reset
 * zone, so the key rolls over when their quota does. The 2-day expiry means a
 * yesterday counter disappears on its own; nothing has to sweep.
 */

import type { RedisClient } from "./client.js";

/** The verdict on one attempted search, before any external call is made. */
export interface WatchSearchBudgetDecision {
  allowed: boolean;
  /** Why it was refused; null when allowed. */
  reason: "daily_budget" | "per_user" | null;
}

export interface WatchSearchQuotaStore {
  /**
   * Reserve budget for ONE uncached search, atomically.
   *
   * Reserve, not "check then spend": the check and the increment are one
   * round-trip so two concurrent searches cannot both see room for the last
   * hundred units. A refusal does not consume anything, and a caller that is
   * refused must not call YouTube at all.
   */
  reserve(input: {
    dayKey: string;
    userId: string;
    /** Units this search will cost (search.list + the batched videos.list). */
    unitCost: number;
    /** Deployment-wide ceiling for the day. */
    dailyUnitBudget: number;
    /** Per-user search count ceiling for the day. */
    perUserPerDay: number;
  }): Promise<WatchSearchBudgetDecision>;

  /** Units spent so far today — for the capability flag and for diagnostics. */
  unitsSpent(dayKey: string): Promise<number>;
}

/** Two days: long enough that a counter outlives its day, short enough to self-clean. */
const COUNTER_TTL_SECONDS = 2 * 24 * 60 * 60;

export class RedisWatchSearchQuotaStore implements WatchSearchQuotaStore {
  constructor(
    private readonly redis: RedisClient,
    private readonly prefix = "watch",
  ) {}

  private unitsKey(dayKey: string): string {
    return `${this.prefix}:ytquota:${dayKey}`;
  }

  private userKey(dayKey: string, userId: string): string {
    return `${this.prefix}:ytsearch:${dayKey}:${userId}`;
  }

  async reserve(input: {
    dayKey: string;
    userId: string;
    unitCost: number;
    dailyUnitBudget: number;
    perUserPerDay: number;
  }): Promise<WatchSearchBudgetDecision> {
    const unitsKey = this.unitsKey(input.dayKey);
    const userKey = this.userKey(input.dayKey, input.userId);

    // Increment BOTH first, then judge, then refund on refusal. The alternative
    // — read, decide, increment — has a window in which N concurrent requests
    // all read the same "there is room" and all spend. Redis has no CAS we can
    // use across two keys without Lua, and a brief over-count that is refunded
    // milliseconds later is the safe direction to be wrong in: the worst case is
    // one search refused that could have been allowed, against a budget already
    // set 10% below the real ceiling.
    const spent = await this.redis.incrby(unitsKey, input.unitCost);
    await this.redis.expire(unitsKey, COUNTER_TTL_SECONDS);
    if (spent > input.dailyUnitBudget) {
      await this.redis.incrby(unitsKey, -input.unitCost);
      return { allowed: false, reason: "daily_budget" };
    }

    const userCount = await this.redis.incr(userKey);
    await this.redis.expire(userKey, COUNTER_TTL_SECONDS);
    if (userCount > input.perUserPerDay) {
      // Refund both: this user's attempt did not happen, and the units it
      // reserved a moment ago belong back in the shared pool.
      await this.redis.incrby(userKey, -1);
      await this.redis.incrby(unitsKey, -input.unitCost);
      return { allowed: false, reason: "per_user" };
    }

    return { allowed: true, reason: null };
  }

  async unitsSpent(dayKey: string): Promise<number> {
    const raw = await this.redis.get(this.unitsKey(dayKey));
    const value = Number(raw ?? 0);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }
}

/**
 * Single-process fallback, used when no Redis client is wired (tests, and a local
 * `pnpm dev:api` with no compose stack). Mirrors `InMemorySlowmodeStore`: correct
 * for one process, and honest that it forgets on restart — which is exactly why
 * it is not what production runs.
 */
export class InMemoryWatchSearchQuotaStore implements WatchSearchQuotaStore {
  private readonly units = new Map<string, number>();
  private readonly userCounts = new Map<string, number>();

  async reserve(input: {
    dayKey: string;
    userId: string;
    unitCost: number;
    dailyUnitBudget: number;
    perUserPerDay: number;
  }): Promise<WatchSearchBudgetDecision> {
    const spent = this.units.get(input.dayKey) ?? 0;
    if (spent + input.unitCost > input.dailyUnitBudget) {
      return { allowed: false, reason: "daily_budget" };
    }
    const userKey = `${input.dayKey}:${input.userId}`;
    const used = this.userCounts.get(userKey) ?? 0;
    if (used + 1 > input.perUserPerDay) {
      return { allowed: false, reason: "per_user" };
    }
    this.units.set(input.dayKey, spent + input.unitCost);
    this.userCounts.set(userKey, used + 1);
    return { allowed: true, reason: null };
  }

  async unitsSpent(dayKey: string): Promise<number> {
    return this.units.get(dayKey) ?? 0;
  }
}
