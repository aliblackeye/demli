/**
 * The pure pieces behind watch-party search (M20 wave 2) — no DB, no network.
 *
 * These are small functions with disproportionate consequences: one builds a URL
 * that lands in an `<img src>` on every member's machine, one decides which day's
 * quota bucket a search is charged to, and one turns an external service's string
 * into a number a UI renders. Each is tested where it lives rather than through
 * the route, so a failure names the rule that broke.
 */

import { describe, expect, it } from "vitest";
import {
  parseIso8601DurationSeconds,
  WATCH_POSITION_MAX_SECONDS,
  WATCH_SEARCH_DAILY_UNIT_BUDGET,
  WATCH_SEARCH_PER_USER_PER_DAY,
  youtubeQuotaDayKey,
  youtubeThumbnailUrl,
  YOUTUBE_SEARCH_UNIT_COST,
} from "@demli/config";
import { InMemoryWatchSearchQuotaStore } from "@demli/db";
import { createWatchSearchService, WATCH_SEARCH_UNIT_COST } from "../modules/watch/index.js";
import type { WatchSearchResult } from "@demli/protocol";

describe("youtubeThumbnailUrl", () => {
  it("builds the URL from a validated id and nothing else", () => {
    expect(youtubeThumbnailUrl("dQw4w9WgXcQ")).toBe(
      "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg",
    );
  });

  it("refuses anything that is not an id, so no string can smuggle a host or a path", () => {
    // This value goes straight into an <img src>. The id gate is the only reason
    // that is safe, so it must hold for every shape an external response could
    // hand us.
    for (const value of [
      "",
      "short",
      "dQw4w9WgXcQQQQ",
      "../../evil",
      "dQw4w9WgXc/",
      "https://evil.test/x.gif",
      "dQw4w9Wg?cQ",
    ]) {
      expect(youtubeThumbnailUrl(value), value).toBeNull();
    }
  });
});

describe("parseIso8601DurationSeconds", () => {
  it("parses the shapes YouTube actually returns", () => {
    expect(parseIso8601DurationSeconds("PT3M33S")).toBe(213);
    expect(parseIso8601DurationSeconds("PT4M13S")).toBe(253);
    expect(parseIso8601DurationSeconds("PT1H2M3S")).toBe(3_723);
    expect(parseIso8601DurationSeconds("PT45S")).toBe(45);
    expect(parseIso8601DurationSeconds("PT2H")).toBe(7_200);
    expect(parseIso8601DurationSeconds("PT23H59M59S")).toBe(86_399);
    expect(parseIso8601DurationSeconds("P1D")).toBe(86_400);
  });

  it("returns null for a live stream, which has no duration", () => {
    // `P0D` is what a live broadcast answers. Reporting a confident 0 would put
    // "0:00" next to a stream that has been running for three hours — the one
    // case where showing nothing is strictly more truthful than showing a number.
    expect(parseIso8601DurationSeconds("P0D")).toBeNull();
    expect(parseIso8601DurationSeconds("PT0S")).toBeNull();
    expect(parseIso8601DurationSeconds("PT")).toBeNull();
    expect(parseIso8601DurationSeconds("P")).toBeNull();
  });

  it("refuses junk rather than guessing", () => {
    for (const value of ["", "3:33", "213", "PT3M33X", "-PT3M", "PT99999H", "PTM S"]) {
      expect(parseIso8601DurationSeconds(value), value).toBeNull();
    }
  });

  it("bounds the result by the same ceiling a playback position obeys", () => {
    // Over the ceiling is null, not a clamped number: a duration the position
    // schema would refuse must never be queued as display metadata, and silently
    // reporting "24:00:00" for a 3-day upload would be inventing a fact.
    expect(parseIso8601DurationSeconds("P9999D")).toBeNull();
    expect(parseIso8601DurationSeconds("P1DT2H")).toBeNull();
    expect(parseIso8601DurationSeconds("PT24H")).toBe(WATCH_POSITION_MAX_SECONDS);
  });
});

describe("youtubeQuotaDayKey", () => {
  it("rolls over at YouTube's reset, not at UTC midnight", () => {
    // Quota resets at midnight Pacific. 06:00 UTC is still the previous Pacific
    // day; 09:00 UTC is the next one. Counting on UTC days would reset our budget
    // hours before or after theirs.
    const beforeReset = Date.parse("2026-07-28T06:00:00.000Z");
    const afterReset = Date.parse("2026-07-28T09:00:00.000Z");
    expect(youtubeQuotaDayKey(beforeReset)).toBe("2026-07-27");
    expect(youtubeQuotaDayKey(afterReset)).toBe("2026-07-28");
  });

  it("is stable within a day and different across days", () => {
    const day = Date.parse("2026-07-28T12:00:00.000Z");
    expect(youtubeQuotaDayKey(day)).toBe(youtubeQuotaDayKey(day + 3_600_000));
    expect(youtubeQuotaDayKey(day)).not.toBe(youtubeQuotaDayKey(day + 24 * 3_600_000));
  });
});

describe("watch search service", () => {
  const results: WatchSearchResult[] = [
    {
      videoId: "dQw4w9WgXcQ",
      title: "A video",
      channelTitle: "A channel",
      durationSeconds: 213,
      thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg",
    },
  ];

  function makeService(overrides?: {
    onSearch?: () => Promise<WatchSearchResult[]>;
    quota?: InMemoryWatchSearchQuotaStore;
    now?: () => number;
  }): {
    service: ReturnType<typeof createWatchSearchService>;
    quota: InMemoryWatchSearchQuotaStore;
    calls: () => number;
  } {
    let calls = 0;
    const quota = overrides?.quota ?? new InMemoryWatchSearchQuotaStore();
    const service = createWatchSearchService({
      client: {
        search: async () => {
          calls += 1;
          return overrides?.onSearch ? overrides.onSearch() : results;
        },
      },
      quota,
      ...(overrides?.now ? { now: overrides.now } : {}),
    });
    return { service, quota, calls: () => calls };
  }

  it("charges one search plus one batched metadata call", () => {
    // The number the whole budget is sized against; if the client ever stops
    // batching durations this constant is where it will show up.
    expect(WATCH_SEARCH_UNIT_COST).toBe(YOUTUBE_SEARCH_UNIT_COST + 1);
    expect(WATCH_SEARCH_UNIT_COST).toBe(101);
  });

  it("spends quota once and then serves the same query from cache", async () => {
    const { service, quota, calls } = makeService();
    const dayKey = youtubeQuotaDayKey(Date.now());

    const first = await service.search({ userId: "u1", query: "hello" });
    expect(first).toMatchObject({ ok: true, cached: false });
    expect(await quota.unitsSpent(dayKey)).toBe(WATCH_SEARCH_UNIT_COST);

    // Normalized key: different case and spacing is the SAME search.
    const second = await service.search({ userId: "u1", query: "  HELLO " });
    expect(second).toMatchObject({ ok: true, cached: true });
    expect(calls()).toBe(1);
    expect(await quota.unitsSpent(dayKey)).toBe(WATCH_SEARCH_UNIT_COST);

    // …and a cache hit is free for a DIFFERENT user too, so one person's search
    // does not have to be paid for again by the next.
    const other = await service.search({ userId: "u2", query: "hello" });
    expect(other).toMatchObject({ ok: true, cached: true });
    expect(await quota.unitsSpent(dayKey)).toBe(WATCH_SEARCH_UNIT_COST);
  });

  it("caches an empty result, because 'nothing matches' is also an answer", async () => {
    const { service, calls } = makeService({ onSearch: async () => [] });
    await service.search({ userId: "u1", query: "zzzz" });
    await service.search({ userId: "u1", query: "zzzz" });
    expect(calls()).toBe(1);
  });

  it("expires the cache so a new upload appears the same evening", async () => {
    let clock = 1_000_000;
    const { service, calls } = makeService({ now: () => clock });
    await service.search({ userId: "u1", query: "hello" });
    clock += 9 * 60_000;
    await service.search({ userId: "u1", query: "hello" });
    expect(calls()).toBe(1);
    clock += 2 * 60_000;
    await service.search({ userId: "u1", query: "hello" });
    expect(calls()).toBe(2);
  });

  it("stops one user before they can spend the whole deployment's day", async () => {
    const { service, quota } = makeService();
    for (let i = 0; i < WATCH_SEARCH_PER_USER_PER_DAY; i++) {
      const res = await service.search({ userId: "u1", query: `query ${i}` });
      expect(res.ok, `search #${i}`).toBe(true);
    }
    expect(await service.search({ userId: "u1", query: "one more" })).toEqual({
      ok: false,
      reason: "per_user",
    });
    // Their neighbour is unaffected — that is the point of a PER-USER cap.
    expect((await service.search({ userId: "u2", query: "their own query" })).ok).toBe(true);

    // And the refusal cost nothing: exactly the allowed searches were charged.
    const dayKey = youtubeQuotaDayKey(Date.now());
    expect(await quota.unitsSpent(dayKey)).toBe(
      WATCH_SEARCH_UNIT_COST * (WATCH_SEARCH_PER_USER_PER_DAY + 1),
    );
  });

  it("refuses everyone once the shared daily budget is gone", async () => {
    const quota = new InMemoryWatchSearchQuotaStore();
    await quota.reserve({
      dayKey: youtubeQuotaDayKey(Date.now()),
      userId: "someone-else",
      unitCost: WATCH_SEARCH_DAILY_UNIT_BUDGET,
      dailyUnitBudget: WATCH_SEARCH_DAILY_UNIT_BUDGET,
      perUserPerDay: 1,
    });
    const { service, calls } = makeService({ quota });

    expect(await service.search({ userId: "u1", query: "anything" })).toEqual({
      ok: false,
      reason: "daily_budget",
    });
    // The budget is checked BEFORE the call, or it is not a budget.
    expect(calls()).toBe(0);
  });

  it("does NOT refund an upstream failure, because YouTube charged for it", async () => {
    const { service, quota } = makeService({
      onSearch: async () => {
        throw new Error("upstream exploded");
      },
    });
    const dayKey = youtubeQuotaDayKey(Date.now());

    expect(await service.search({ userId: "u1", query: "boom" })).toEqual({
      ok: false,
      reason: "upstream",
    });
    // Refunding here would let a client that reliably triggers upstream errors
    // burn our real quota without ever touching our budget.
    expect(await quota.unitsSpent(dayKey)).toBe(WATCH_SEARCH_UNIT_COST);

    // A failure is also not cached — the next attempt gets a real try.
    const { service: retryService, calls } = makeService();
    await retryService.search({ userId: "u1", query: "boom" });
    expect(calls()).toBe(1);
  });
});
