/**
 * Watch-party search service (M20 wave 2) — everything between "a member typed a
 * query" and "we spend YouTube quota".
 *
 * Three gates stand in front of the upstream call, in this order, because each
 * one is cheaper than the next:
 *
 *  1. **Cache** (process-local, 10 min). A cache hit spends NO quota and is not
 *     counted against anyone's daily allowance — the realistic pattern is one
 *     person re-running a query while deciding, and charging them for that would
 *     be charging them for hesitating.
 *  2. **Budget reservation** (Redis, atomic). Reserved BEFORE the call, so two
 *     concurrent searches cannot both spend the last hundred units. Both the
 *     deployment-wide daily budget and the per-user daily cap live here.
 *  3. **The upstream call itself.**
 *
 * The budget is the load-bearing one and it is worth being explicit about why it
 * is not just a rate limit: YouTube grants 10,000 units per project per day and a
 * search costs 100. That is ~100 searches per DAY for everyone using this
 * deployment, combined — a ceiling no amount of our own capacity can raise, and
 * one that fails hard rather than degrading when it is reached. So the endpoint
 * refuses at a budget we set 10% BELOW theirs, and the client falls back to
 * pasting a link, which never needed a key at all.
 */

import {
  WATCH_SEARCH_CACHE_TTL_MS,
  WATCH_SEARCH_DAILY_UNIT_BUDGET,
  WATCH_SEARCH_PER_USER_PER_DAY,
  YOUTUBE_SEARCH_UNIT_COST,
  YOUTUBE_VIDEOS_UNIT_COST,
  youtubeQuotaDayKey,
} from "@demli/config";
import type { WatchSearchQuotaStore } from "@demli/db";
import type { WatchSearchResult } from "@demli/protocol";
import { YouTubeSearchError, type YouTubeClient } from "./youtube.js";

/** Units one uncached search really costs us: the search plus the batched lookup. */
export const WATCH_SEARCH_UNIT_COST = YOUTUBE_SEARCH_UNIT_COST + YOUTUBE_VIDEOS_UNIT_COST;

export type WatchSearchOutcome =
  | { ok: true; results: WatchSearchResult[]; cached: boolean }
  | { ok: false; reason: "daily_budget" | "per_user" | "upstream" };

export interface WatchSearchService {
  search(input: { userId: string; query: string }): Promise<WatchSearchOutcome>;
}

export interface WatchSearchServiceDeps {
  client: YouTubeClient;
  quota: WatchSearchQuotaStore;
  now?: () => number;
  cacheTtlMs?: number;
  dailyUnitBudget?: number;
  perUserPerDay?: number;
  log?: (message: string) => void;
}

interface CacheEntry {
  results: WatchSearchResult[];
  expiresAt: number;
}

/** Soft ceiling on cache entries; expired ones are swept once it is reached. */
const CACHE_SOFT_MAX = 500;

/**
 * Cache key for a query. Lowercased and whitespace-collapsed so "Never Gonna" and
 * "never  gonna" are one entry rather than two charges for the same search.
 */
export function searchCacheKey(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

export function createWatchSearchService(deps: WatchSearchServiceDeps): WatchSearchService {
  const now = deps.now ?? ((): number => Date.now());
  const log = deps.log ?? ((): void => undefined);
  const cacheTtlMs = deps.cacheTtlMs ?? WATCH_SEARCH_CACHE_TTL_MS;
  const dailyUnitBudget = deps.dailyUnitBudget ?? WATCH_SEARCH_DAILY_UNIT_BUDGET;
  const perUserPerDay = deps.perUserPerDay ?? WATCH_SEARCH_PER_USER_PER_DAY;

  const cache = new Map<string, CacheEntry>();

  function sweepCacheIfLarge(at: number): void {
    if (cache.size < CACHE_SOFT_MAX) return;
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= at) cache.delete(key);
    }
  }

  async function search(input: {
    userId: string;
    query: string;
  }): Promise<WatchSearchOutcome> {
    const at = now();
    const key = searchCacheKey(input.query);

    const cached = cache.get(key);
    if (cached && cached.expiresAt > at) {
      return { ok: true, results: cached.results, cached: true };
    }

    const decision = await deps.quota.reserve({
      dayKey: youtubeQuotaDayKey(at),
      userId: input.userId,
      unitCost: WATCH_SEARCH_UNIT_COST,
      dailyUnitBudget,
      perUserPerDay,
    });
    if (!decision.allowed) {
      return { ok: false, reason: decision.reason ?? "daily_budget" };
    }

    let results: WatchSearchResult[];
    try {
      results = await deps.client.search(input.query);
    } catch (err) {
      // The reservation is NOT refunded. YouTube charges for a call it answered
      // with an error just as it charges for one it answered with results, so
      // refunding here would let a client that reliably triggers upstream errors
      // spend our real quota without ever touching our budget.
      log(
        `watch search failed: ${
          err instanceof YouTubeSearchError
            ? `upstream ${err.upstreamStatus ?? "transport"}`
            : err instanceof Error
              ? err.message
              : String(err)
        }`,
      );
      return { ok: false, reason: "upstream" };
    }

    sweepCacheIfLarge(at);
    // Empty results are cached too: "nothing matches that" is an answer, and
    // re-charging 101 units to say it again is the opposite of caching.
    cache.set(key, { results, expiresAt: now() + cacheTtlMs });
    return { ok: true, results, cached: false };
  }

  return { search };
}
