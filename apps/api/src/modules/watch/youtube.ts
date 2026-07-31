/**
 * YouTube Data API v3 client for in-app watch-party search (M20 wave 2).
 *
 * The API KEY never leaves this process. That is the entire reason this endpoint
 * exists instead of the clients calling YouTube themselves: a key shipped inside
 * an Electron bundle or an APK is a key anyone can extract and spend, and the
 * quota it spends is ours (CLAUDE.md §28).
 *
 * ## Two calls, and why the second one is worth it
 *
 *   search.list  → 100 quota units, returns id + title + channel, NO duration
 *   videos.list  →   1 quota unit, returns duration for a BATCH of ids
 *
 * Duration is what tells someone whether they are queueing a four-minute song or
 * a three-hour stream, so it is worth one unit — but only batched. Fifteen
 * separate lookups would cost fifteen units and buy exactly the same answer. The
 * second call is also allowed to FAIL without taking the search with it: results
 * with `durationSeconds: null` are still a usable picker, and refusing the whole
 * search over missing metadata would waste the 100 units already spent.
 *
 * ## Nothing in the response is trusted
 *
 * It is an external service, and its answers land in an `<img src>` and a list
 * row on every member's machine. So:
 *
 *  - every `videoId` is re-checked with `parseYouTubeVideoId` — the same gate a
 *    pasted link passes — and a result that fails it is DROPPED, not repaired;
 *  - `thumbnailUrl` is BUILT BY US from that validated id (`youtubeThumbnailUrl`),
 *    never taken from the response, so no externally-controlled URL is ever
 *    rendered;
 *  - `title` / `channelTitle` are stripped of control, zero-width and bidi
 *    characters and bounded, so one row cannot span several lines or reorder
 *    itself against its neighbours.
 *
 * ## The fetch seam
 *
 * `fetchJson` is injectable so every rule above is testable with no network. The
 * default is a real `fetch` against `https://www.googleapis.com` — and it is
 * exercised by a test that stands up a local HTTP server and points the default
 * implementation at it, because a seam that is only ever mocked proves nothing
 * about the transport underneath it (the unfurl `lookup` regression taught this
 * the expensive way).
 */

import {
  isYouTubeVideoId,
  parseIso8601DurationSeconds,
  sanitizeWatchDisplayText,
  WATCH_QUEUE_TITLE_MAX_LENGTH,
  WATCH_SEARCH_MAX_RESULTS,
  youtubeThumbnailUrl,
} from "@demli/config";
import type { WatchSearchResult } from "@demli/protocol";

/** Where the Data API lives. Not configurable — a redirectable base URL would be a hole. */
export const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";

/** How long one upstream call may take before we give up on it. */
export const YOUTUBE_REQUEST_TIMEOUT_MS = 6_000;

/** Longest upstream body we will read. A Data API page is a few tens of KB. */
export const YOUTUBE_MAX_RESPONSE_BYTES = 512 * 1024;

/** One upstream response, already decoded. */
export interface YouTubeJsonResponse {
  status: number;
  /** Parsed JSON body, or null when the body was absent/unparseable/oversized. */
  body: unknown;
}

/** The single injectable seam: one GET, returning status + parsed JSON. */
export type YouTubeFetchJson = (url: string) => Promise<YouTubeJsonResponse>;

export interface YouTubeClient {
  /**
   * Search, then batch-resolve durations. Returns at most
   * `WATCH_SEARCH_MAX_RESULTS` normalized rows. Throws only when the SEARCH call
   * itself fails — a failed duration lookup degrades to `durationSeconds: null`.
   */
  search(query: string): Promise<WatchSearchResult[]>;
}

/** Raised when the upstream search call could not be completed. */
export class YouTubeSearchError extends Error {
  constructor(
    message: string,
    /** Upstream HTTP status, or null for a transport/timeout failure. */
    readonly upstreamStatus: number | null,
  ) {
    super(message);
    this.name = "YouTubeSearchError";
  }
}

/**
 * The default seam: one real `fetch` with a timeout and a body-size cap.
 *
 * `redirect: "error"` is deliberate. We are sending an API key in a query string
 * to a host we hardcoded; following a redirect would hand that key to whatever
 * host the redirect named. There is no legitimate redirect on this endpoint.
 */
export function createDefaultFetchJson(options?: {
  timeoutMs?: number;
  maxBytes?: number;
}): YouTubeFetchJson {
  const timeoutMs = options?.timeoutMs ?? YOUTUBE_REQUEST_TIMEOUT_MS;
  const maxBytes = options?.maxBytes ?? YOUTUBE_MAX_RESPONSE_BYTES;

  return async (url: string): Promise<YouTubeJsonResponse> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "error",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      const text = await response.text();
      if (text.length > maxBytes) {
        return { status: response.status, body: null };
      }
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      return { status: response.status, body };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Narrow an unknown value to a record without pretending we know its fields. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Pull `{ videoId, title, channelTitle }` out of one `search.list` item, or null
 * when it is not a usable video row (a channel/playlist hit, a malformed entry,
 * or an id that does not pass our own video-id gate).
 */
function parseSearchItem(
  raw: unknown,
): { videoId: string; title: string; channelTitle: string } | null {
  const item = asRecord(raw);
  if (!item) return null;

  const id = asRecord(item["id"]);
  const videoId = id ? asString(id["videoId"]) : null;
  // The one non-negotiable check: an id we did not verify never becomes a URL.
  if (videoId === null || !isYouTubeVideoId(videoId)) return null;

  const snippet = asRecord(item["snippet"]);
  const title = sanitizeWatchDisplayText(
    asString(snippet?.["title"]) ?? "",
    WATCH_QUEUE_TITLE_MAX_LENGTH,
  );
  const channelTitle = sanitizeWatchDisplayText(
    asString(snippet?.["channelTitle"]) ?? "",
    WATCH_QUEUE_TITLE_MAX_LENGTH,
  );
  // A row with no readable title is not a row a person can pick from.
  if (title === null) return null;

  return { videoId, title, channelTitle: channelTitle ?? "" };
}

/** Map videoId → duration in seconds from one batched `videos.list` response. */
function parseDurations(body: unknown): Map<string, number> {
  const durations = new Map<string, number>();
  const root = asRecord(body);
  const items = root?.["items"];
  if (!Array.isArray(items)) return durations;

  for (const raw of items) {
    const item = asRecord(raw);
    const videoId = asString(item?.["id"]);
    if (videoId === null || !isYouTubeVideoId(videoId)) continue;
    const details = asRecord(item?.["contentDetails"]);
    const iso = asString(details?.["duration"]);
    if (iso === null) continue;
    const seconds = parseIso8601DurationSeconds(iso);
    if (seconds !== null) durations.set(videoId, seconds);
  }
  return durations;
}

export interface YouTubeClientDeps {
  apiKey: string;
  fetchJson?: YouTubeFetchJson;
  maxResults?: number;
  log?: (message: string) => void;
}

export function createYouTubeClient(deps: YouTubeClientDeps): YouTubeClient {
  const fetchJson = deps.fetchJson ?? createDefaultFetchJson();
  const maxResults = deps.maxResults ?? WATCH_SEARCH_MAX_RESULTS;
  const log = deps.log ?? ((): void => undefined);

  function buildUrl(path: string, params: Record<string, string>): string {
    const url = new URL(`${YOUTUBE_API_BASE}/${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    // Appended last and never logged: `buildUrl`'s output is only ever passed to
    // the fetch seam, and the error paths below report a STATUS, never a URL.
    url.searchParams.set("key", deps.apiKey);
    return url.toString();
  }

  async function search(query: string): Promise<WatchSearchResult[]> {
    let response: YouTubeJsonResponse;
    try {
      response = await fetchJson(
        buildUrl("search", {
          part: "snippet",
          type: "video",
          // Embeddable-only: a video that refuses embedding is one the whole room
          // would fail to play, so offering it would be offering a dead result.
          videoEmbeddable: "true",
          // Syndicated: playable outside youtube.com — the same requirement.
          videoSyndicated: "true",
          safeSearch: "moderate",
          maxResults: String(maxResults),
          q: query,
        }),
      );
    } catch (err) {
      // Transport, timeout, or a refused redirect. The message is ours; the
      // upstream's is logged, not returned (§26).
      log(`youtube search transport failure: ${err instanceof Error ? err.message : String(err)}`);
      throw new YouTubeSearchError("Search is temporarily unavailable.", null);
    }

    if (response.status !== 200) {
      log(`youtube search failed with status ${response.status}`);
      throw new YouTubeSearchError("Search is temporarily unavailable.", response.status);
    }

    const root = asRecord(response.body);
    const items = root?.["items"];
    if (!Array.isArray(items)) return [];

    const parsed: Array<{ videoId: string; title: string; channelTitle: string }> = [];
    const seen = new Set<string>();
    for (const raw of items) {
      const item = parseSearchItem(raw);
      // De-duplicated: the same video appearing twice in one page would be two
      // identical rows the user cannot tell apart.
      if (!item || seen.has(item.videoId)) continue;
      seen.add(item.videoId);
      parsed.push(item);
      if (parsed.length >= maxResults) break;
    }
    if (parsed.length === 0) return [];

    const durations = await fetchDurations(parsed.map((item) => item.videoId));

    return parsed.map((item) => ({
      videoId: item.videoId,
      title: item.title,
      channelTitle: item.channelTitle,
      durationSeconds: durations.get(item.videoId) ?? null,
      // Built from the validated id, never taken from the response. Non-null by
      // construction — `isYouTubeVideoId` already passed — but the `?? ""` keeps
      // this honest rather than asserting.
      thumbnailUrl: youtubeThumbnailUrl(item.videoId) ?? "",
    }));
  }

  /**
   * One batched metadata call. Never throws: durations are a nicety, the 100
   * units for the search are already spent, and a picker without runtimes still
   * works. A failure logs and yields an empty map.
   */
  async function fetchDurations(videoIds: string[]): Promise<Map<string, number>> {
    try {
      const response = await fetchJson(
        buildUrl("videos", {
          part: "contentDetails",
          id: videoIds.join(","),
          maxResults: String(videoIds.length),
        }),
      );
      if (response.status !== 200) {
        log(`youtube videos.list failed with status ${response.status}`);
        return new Map();
      }
      return parseDurations(response.body);
    } catch (err) {
      log(`youtube videos.list failure: ${err instanceof Error ? err.message : String(err)}`);
      return new Map();
    }
  }

  return { search };
}
