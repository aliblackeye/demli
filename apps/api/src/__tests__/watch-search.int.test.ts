/**
 * Watch-party search API (M20 wave 2, ADR 0016 revisited) — real routes, real
 * Postgres, real auth. The YouTube call itself is the ONLY thing mocked, and it
 * is mocked at the `fetchJson` seam so everything above it — authorization,
 * channel-kind gating, normalization, caching, the quota budget, and the
 * disabled state — runs for real.
 *
 * The default seam (an actual `fetch` over the wire) has its own test in
 * `watch-search-fetch.int.test.ts`, against a local HTTP server. A seam that is
 * only ever mocked proves nothing about the transport underneath it — that
 * lesson cost us a shipped-and-broken unfurl path once already.
 *
 * Covered:
 *  1. NO API KEY ⇒ `/watch/capabilities` says `searchEnabled: false` and the
 *     search route answers 503 — the client can hide the box instead of offering
 *     one that cannot work (§35);
 *  2. a normal search returns normalized rows: our own thumbnail URL, parsed
 *     durations, sanitized titles;
 *  3. results whose videoId does not pass OUR gate are DROPPED, not repaired —
 *     the response came from outside and gets no more trust than a client;
 *  4. an identical query is served from cache and spends NO quota;
 *  5. the per-user daily cap and the deployment-wide budget both refuse, with
 *     DIFFERENT codes/messages from an upstream failure;
 *  6. an upstream failure is a 503 the user can act on, never a stack trace;
 *  7. a non-member cannot search a channel they cannot see (404, not 403), and a
 *     TEXT channel is refused — this endpoint is not a general YouTube proxy.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  applyMigrations,
  createDb,
  createRepositories,
  InMemoryWatchSearchQuotaStore,
  type DbClient,
  type Repositories,
  type WatchSearchQuotaStore,
} from "@demli/db";
import {
  WATCH_SEARCH_DAILY_UNIT_BUDGET,
  WATCH_SEARCH_PER_USER_PER_DAY,
  youtubeQuotaDayKey,
} from "@demli/config";
import type { WatchSearchResult } from "@demli/protocol";
import { buildApp } from "../app.js";
import { loadEnv } from "../env.js";
import type { YouTubeJsonResponse } from "../modules/watch/index.js";
import { refuseToSkipIfRequired } from "@demli/db/testing";

const DATABASE_URL =
  process.env["DATABASE_URL"] ?? "postgresql://postgres:postgres@localhost:5432/demli";

async function isDbUp(): Promise<boolean> {
  const { sql, close } = createDb(DATABASE_URL, { max: 1 });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await close();
  }
}

const dbUp = await isDbUp();
if (!dbUp) {
  refuseToSkipIfRequired("postgres");
  console.warn("[watch-search.int.test] DATABASE unreachable — skipping integration tests");
}

/** One `search.list` item, in the shape the real API returns it. */
function searchItem(videoId: string, title: string, channelTitle = "Some Channel"): unknown {
  return {
    id: { kind: "youtube#video", videoId },
    snippet: {
      title,
      channelTitle,
      // Present in the real response and deliberately IGNORED by our normalizer;
      // an externally-controlled URL never becomes an <img src> on a member's
      // machine. The test below asserts the URL we return is not this one.
      thumbnails: { medium: { url: "https://evil.test/tracker.gif" } },
    },
  };
}

describe.skipIf(!dbUp)("M20 watch-party search API", () => {
  let client: DbClient;
  let repos: Repositories;

  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const password = "correct-horse-9";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  /** Every URL the seam was asked for, so quota spend is observable. */
  let requestedUrls: string[] = [];
  /** Per-path canned responses; a test swaps these to drive a scenario. */
  let searchResponse: () => YouTubeJsonResponse;
  let videosResponse: () => YouTubeJsonResponse;

  function fetchJson(url: string): Promise<YouTubeJsonResponse> {
    requestedUrls.push(url);
    if (url.includes("/youtube/v3/search")) return Promise.resolve(searchResponse());
    return Promise.resolve(videosResponse());
  }

  function resetSeam(): void {
    requestedUrls = [];
    searchResponse = () => ({
      status: 200,
      body: {
        items: [
          searchItem("dQw4w9WgXcQ", "Never Gonna Give You Up"),
          searchItem("9bZkp7q19f0", "PSY - GANGNAM STYLE"),
        ],
      },
    });
    videosResponse = () => ({
      status: 200,
      body: {
        items: [
          { id: "dQw4w9WgXcQ", contentDetails: { duration: "PT3M33S" } },
          { id: "9bZkp7q19f0", contentDetails: { duration: "PT4M13S" } },
        ],
      },
    });
  }

  /**
   * A fresh app on a fresh quota store. Each scenario gets its own so the
   * process-local search cache and the daily counters cannot leak between tests.
   */
  async function makeApp(options?: {
    apiKey?: string | undefined;
    quota?: WatchSearchQuotaStore;
  }): Promise<FastifyInstance> {
    const apiKey = options && "apiKey" in options ? options.apiKey : "test-key";
    return buildApp({
      repos,
      env: loadEnv({ DATABASE_URL, ...(apiKey ? { YOUTUBE_API_KEY: apiKey } : {}) }),
      watchSearchQuota: options?.quota ?? new InMemoryWatchSearchQuotaStore(),
      logger: false,
    });
  }

  /** The same app, with the upstream HTTP call replaced by the canned seam. */
  async function makeSeamApp(quota?: WatchSearchQuotaStore): Promise<FastifyInstance> {
    return buildApp({
      repos,
      env: loadEnv({ DATABASE_URL, YOUTUBE_API_KEY: "test-key" }),
      watchSearchQuota: quota ?? new InMemoryWatchSearchQuotaStore(),
      watchFetchJson: fetchJson,
      logger: false,
    });
  }

  async function register(
    app: FastifyInstance,
    username: string,
  ): Promise<{ token: string; id: string }> {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { username, password, displayName: username },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { token: string; user: { id: string } };
    return { token: body.token, id: body.user.id };
  }

  let ownerToken: string;
  let ownerId: string;
  /** Authenticated, but in no shared server — the "not a free proxy" case. */
  let outsiderToken: string;
  /** A second MEMBER of the same server, for the per-user isolation assertion. */
  let outsiderMemberToken: string;
  let voiceChannelId: string;
  let textChannelId: string;

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);

    // Fixture app: only used to create the accounts/server/channels the scenarios
    // below reuse. Each scenario builds its own app for its own quota + cache.
    const fixture = await makeApp();
    const owner = await register(fixture, `ws_own_${suffix}`);
    ownerToken = owner.token;
    ownerId = owner.id;
    const outsider = await register(fixture, `ws_out_${suffix}`);
    outsiderToken = outsider.token;
    const member = await register(fixture, `ws_mem_${suffix}`);
    outsiderMemberToken = member.token;

    const group = await fixture.inject({
      method: "POST",
      url: "/groups",
      headers: auth(ownerToken),
      payload: { name: "Cinema Crew" },
    });
    expect(group.statusCode).toBe(201);
    const groupId = group.json().group.id as string;

    // The second member joins via a real invite, so their visibility of the
    // voice channel is established the same way a real member's is.
    const invite = await fixture.inject({
      method: "POST",
      url: `/groups/${groupId}/invites`,
      headers: auth(ownerToken),
      payload: {},
    });
    expect(invite.statusCode).toBe(201);
    const redeem = await fixture.inject({
      method: "POST",
      url: `/invites/${invite.json().invite.code as string}/redeem`,
      headers: auth(outsiderMemberToken),
    });
    expect(redeem.statusCode).toBe(200);

    const voice = await fixture.inject({
      method: "POST",
      url: `/groups/${groupId}/channels`,
      headers: auth(ownerToken),
      payload: { name: "cinema", kind: "voice" },
    });
    expect(voice.statusCode).toBe(201);
    voiceChannelId = voice.json().channel.id as string;

    const text = await fixture.inject({
      method: "POST",
      url: `/groups/${groupId}/channels`,
      headers: auth(ownerToken),
      payload: { name: "chat", kind: "text" },
    });
    expect(text.statusCode).toBe(201);
    textChannelId = text.json().channel.id as string;

    await fixture.close();
  });

  afterAll(async () => {
    await client?.close();
  });

  const search = (app: FastifyInstance, token: string, q: string, channelId = voiceChannelId) =>
    app.inject({
      method: "GET",
      url: `/watch/search?channelId=${channelId}&q=${encodeURIComponent(q)}`,
      headers: auth(token),
    });

  it("reports the feature OFF and refuses cleanly when no API key is configured", async () => {
    const app = await makeApp({ apiKey: undefined });
    try {
      const caps = await app.inject({
        method: "GET",
        url: "/watch/capabilities",
        headers: auth(ownerToken),
      });
      expect(caps.statusCode).toBe(200);
      // The whole point: the client learns this BEFORE rendering a search box, so
      // it renders the paste-a-link path instead of a control that cannot work.
      expect(caps.json()).toEqual({ searchEnabled: false });

      const res = await search(app, ownerToken, "anything");
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe("WATCH_SEARCH_DISABLED");
      // The refusal names the fallback rather than dead-ending.
      expect(res.json().error.message).toContain("link");
    } finally {
      await app.close();
    }
  });

  it("reports the feature ON when a key is configured", async () => {
    const app = await makeApp();
    try {
      const caps = await app.inject({
        method: "GET",
        url: "/watch/capabilities",
        headers: auth(ownerToken),
      });
      expect(caps.json()).toEqual({ searchEnabled: true });
      // It describes our configuration, so it is not anonymous.
      const anon = await app.inject({ method: "GET", url: "/watch/capabilities" });
      expect(anon.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("normalizes results and never echoes the upstream thumbnail URL", async () => {
    resetSeam();
    const withSeam = await makeSeamApp();
    try {
      const res = await search(withSeam, ownerToken, "never gonna");
      expect(res.statusCode).toBe(200);
      const results = res.json().results as WatchSearchResult[];
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({
        videoId: "dQw4w9WgXcQ",
        title: "Never Gonna Give You Up",
        channelTitle: "Some Channel",
        durationSeconds: 213,
        // Built by US from the validated id. The upstream response offered
        // `https://evil.test/tracker.gif` and it did not survive.
        thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg",
      });
      expect(JSON.stringify(results)).not.toContain("evil.test");
      expect(results[1]?.durationSeconds).toBe(253);

      // One search call plus ONE batched duration lookup — not one per result.
      expect(requestedUrls.filter((u) => u.includes("/search")).length).toBe(1);
      expect(requestedUrls.filter((u) => u.includes("/videos")).length).toBe(1);
      // The key goes upstream and nowhere else.
      expect(requestedUrls.every((u) => u.includes("key=test-key"))).toBe(true);
      expect(res.payload).not.toContain("test-key");
    } finally {
      await withSeam.close();
    }
  });

  it("drops results our own video-id gate refuses, instead of repairing them", async () => {
    resetSeam();
    searchResponse = () => ({
      status: 200,
      body: {
        items: [
          searchItem("dQw4w9WgXcQ", "A real one"),
          // Wrong length, path traversal, a channel hit with no videoId, and a
          // duplicate of a row we already have. None may become a row.
          searchItem("tooshort", "Bad length"),
          searchItem("../../etc/pas", "Traversal"),
          { id: { kind: "youtube#channel", channelId: "UC123" }, snippet: { title: "A channel" } },
          searchItem("dQw4w9WgXcQ", "The same video again"),
          // A row with no readable title is not something a person can pick.
          searchItem("9bZkp7q19f0", "   "),
        ],
      },
    });
    const app = await makeSeamApp();
    try {
      const res = await search(app, ownerToken, "mixed bag");
      const results = res.json().results as WatchSearchResult[];
      expect(results.map((r) => r.videoId)).toEqual(["dQw4w9WgXcQ"]);
      expect(res.payload).not.toContain("etc/pas");
    } finally {
      await app.close();
    }
  });

  it("survives a failed duration lookup with durationSeconds: null", async () => {
    resetSeam();
    // The 100 units for the search are already spent; refusing the whole search
    // over a 1-unit metadata call would waste them for nothing.
    videosResponse = () => ({ status: 500, body: null });
    const app = await makeSeamApp();
    try {
      const res = await search(app, ownerToken, "no durations");
      expect(res.statusCode).toBe(200);
      const results = res.json().results as WatchSearchResult[];
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.durationSeconds === null)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("serves an identical query from cache without spending quota", async () => {
    resetSeam();
    const quota = new InMemoryWatchSearchQuotaStore();
    const app = await makeSeamApp(quota);
    try {
      const dayKey = youtubeQuotaDayKey(Date.now());
      const first = await search(app, ownerToken, "Never Gonna");
      expect(first.statusCode).toBe(200);
      // 100 for search.list + 1 for the batched videos.list.
      expect(await quota.unitsSpent(dayKey)).toBe(101);
      const upstreamAfterFirst = requestedUrls.length;

      // Same query, different capitalization and spacing — the same search.
      const second = await search(app, ownerToken, "  never   gonna  ");
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual(first.json());
      // No new upstream call, and not one more unit spent.
      expect(requestedUrls.length).toBe(upstreamAfterFirst);
      expect(await quota.unitsSpent(dayKey)).toBe(101);
    } finally {
      await app.close();
    }
  });

  it("refuses when the user's own daily allowance is spent", async () => {
    resetSeam();
    const quota = new InMemoryWatchSearchQuotaStore();
    const dayKey = youtubeQuotaDayKey(Date.now());
    // Spent directly rather than through the route, because the per-session
    // limiter (10 / 10 s) correctly cuts in long before 25 searches — that
    // layering is the design, so reaching the daily cap over HTTP would mean
    // sitting out several rate-limit windows to prove something the service
    // test already proves exhaustively. What is under test HERE is the mapping:
    // a per-user refusal must reach the client as an actionable 429.
    for (let i = 0; i < WATCH_SEARCH_PER_USER_PER_DAY; i++) {
      const reserved = await quota.reserve({
        dayKey,
        userId: ownerId,
        unitCost: 101,
        dailyUnitBudget: WATCH_SEARCH_DAILY_UNIT_BUDGET,
        perUserPerDay: WATCH_SEARCH_PER_USER_PER_DAY,
      });
      expect(reserved.allowed, `pre-spend #${i}`).toBe(true);
    }

    const app = await makeSeamApp(quota);
    try {
      const over = await search(app, ownerToken, "one too many");
      expect(over.statusCode).toBe(429);
      expect(over.json().error.code).toBe("WATCH_SEARCH_QUOTA");
      // It names the fallback rather than dead-ending, and it is clearly the
      // PERSONAL limit rather than the server-wide one.
      expect(over.json().error.message).toContain("link");
      expect(over.json().error.message).toContain("You");
      // Nothing was asked of YouTube.
      expect(requestedUrls).toHaveLength(0);

      // Another member is unaffected — that is what makes it a per-USER cap.
      const other = await search(app, outsiderMemberToken, "their own query");
      expect(other.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("refuses when the deployment-wide daily budget is gone", async () => {
    resetSeam();
    const quota = new InMemoryWatchSearchQuotaStore();
    // Pre-spend the whole day against a DIFFERENT user, so this is the shared
    // ceiling refusing and not a personal one — the two clear the same way but
    // mean different things to the person reading the message.
    await quota.reserve({
      dayKey: youtubeQuotaDayKey(Date.now()),
      userId: "someone-else",
      unitCost: WATCH_SEARCH_DAILY_UNIT_BUDGET,
      dailyUnitBudget: WATCH_SEARCH_DAILY_UNIT_BUDGET,
      perUserPerDay: 1,
    });

    const app = await makeSeamApp(quota);
    try {
      const res = await search(app, ownerToken, "anything at all");
      expect(res.statusCode).toBe(429);
      expect(res.json().error.code).toBe("WATCH_SEARCH_QUOTA");
      // Nothing was asked of YouTube: the budget is checked BEFORE the call, or
      // it would not be a budget.
      expect(requestedUrls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("answers an upstream failure with a usable 503, never a stack trace", async () => {
    resetSeam();
    searchResponse = () => ({ status: 403, body: { error: { message: "quotaExceeded" } } });
    const app = await makeSeamApp();
    try {
      const res = await search(app, ownerToken, "boom");
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe("WATCH_SEARCH_UNAVAILABLE");
      // The upstream's own words never reach the user (§26).
      expect(res.payload).not.toContain("quotaExceeded");
    } finally {
      await app.close();
    }
  });

  it("is not a free YouTube proxy: channel visibility and kind both gate it", async () => {
    resetSeam();
    const app = await makeSeamApp();
    try {
      // Anonymous.
      const anon = await app.inject({
        method: "GET",
        url: `/watch/search?channelId=${voiceChannelId}&q=hello`,
      });
      expect(anon.statusCode).toBe(401);

      // Authenticated, but not a member of that server: 404, never 403, so the
      // route is not an existence oracle for channels.
      const stranger = await search(app, outsiderToken, "hello");
      expect(stranger.statusCode).toBe(404);

      // A TEXT channel: a watch party cannot exist there, so neither can its
      // search — this is the gate that stops any account from spending our key.
      const text = await search(app, ownerToken, "hello", textChannelId);
      expect(text.statusCode).toBe(400);
      expect(text.json().error.code).toBe("INVALID_CHANNEL");

      // Not one upstream call was made for any of the three.
      expect(requestedUrls).toHaveLength(0);

      // A blank query never reaches the service either.
      const blank = await app.inject({
        method: "GET",
        url: `/watch/search?channelId=${voiceChannelId}&q=%20%20`,
        headers: auth(ownerToken),
      });
      expect(blank.statusCode).toBe(400);
      expect(requestedUrls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("rate limits a client that fires a request per keystroke", async () => {
    resetSeam();
    const app = await makeSeamApp();
    try {
      const codes: number[] = [];
      for (let i = 0; i < 15; i++) {
        const res = await search(app, ownerToken, `typing ${i}`);
        codes.push(res.statusCode);
      }
      // The per-session bucket (10 / 10 s) cuts in before the daily allowance
      // does, which is the point: the cheap limiter protects the expensive one.
      expect(codes.filter((code) => code === 429).length).toBeGreaterThan(0);
      expect(codes.filter((code) => code === 200).length).toBeLessThanOrEqual(10);
    } finally {
      await app.close();
    }
  }, 30_000);
});
