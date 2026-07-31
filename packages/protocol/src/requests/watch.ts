/**
 * Watch-party HTTP contract (M20 wave 2, ADR 0016 revisited).
 *
 * Two read-only endpoints, both served by `apps/api/src/modules/watch`:
 *
 *   GET /watch/capabilities                    → {@link WatchCapabilities}
 *   GET /watch/search?channelId=…&q=…          → {@link WatchSearchResponse}
 *
 * Everything about the queue itself is a WebSocket event (`schemas.ts`); search
 * is HTTP because it is a request/response lookup against an external service
 * with a hard daily quota, not a broadcast — putting it on the socket would give
 * it the socket's fan-out semantics and none of the caching a plain GET gets for
 * free.
 *
 * ## The capability endpoint exists so there is no dead button
 *
 * The search feature is OFF whenever the deployment has no `YOUTUBE_API_KEY`, and
 * a client cannot discover that by trying: a 503 arrives only after the user has
 * typed a query and pressed something, which is the definition of a control that
 * looks pressable and does nothing (§35). {@link WatchCapabilities} is the answer
 * — one cheap authenticated call at the moment the panel opens, and a client with
 * `searchEnabled: false` renders the paste-a-link path INSTEAD of the search box,
 * not a disabled version of it.
 */

import { z } from "zod";
import { WATCH_SEARCH_QUERY_MAX_LENGTH } from "@demli/config";
import { uuidField } from "./common.js";

/**
 * `GET /watch/search` query.
 *
 * `channelId` is required and is not decoration: search is authorized against a
 * channel the caller can SEE (and which is a voice channel — the only place a
 * watch party can exist), so an authenticated stranger cannot use our API key as
 * a free YouTube proxy.
 */
export const watchSearchQuerySchema = z.object({
  channelId: uuidField,
  q: z.string().trim().min(1).max(WATCH_SEARCH_QUERY_MAX_LENGTH),
});

export type WatchSearchQuery = z.infer<typeof watchSearchQuerySchema>;

/**
 * One normalized search hit.
 *
 * Normalized means: `videoId` has passed the same `parseYouTubeVideoId` gate a
 * pasted link passes (a result whose id fails it is DROPPED, not repaired — the
 * response came from outside and gets no more trust than a client does),
 * `thumbnailUrl` is built by us from that id rather than taken from the response,
 * and `title`/`channelTitle` are stripped of control characters and bounded.
 *
 * `durationSeconds` is null when the follow-up metadata lookup did not answer for
 * this video (it is a second API call and is allowed to fail without taking the
 * search with it) or when the video is a live stream, which has no duration.
 */
export interface WatchSearchResult {
  videoId: string;
  title: string;
  channelTitle: string;
  durationSeconds: number | null;
  thumbnailUrl: string;
}

export interface WatchSearchResponse {
  results: WatchSearchResult[];
}

/**
 * What this deployment can do for watch parties.
 *
 * One flag today, an object rather than a bare boolean because the next
 * capability (another provider, or server-side metadata for pasted links) must be
 * addable without changing the shape a shipped client already parses.
 */
export interface WatchCapabilities {
  /**
   * True when in-app YouTube search is configured AND has budget. False means the
   * client offers ONLY the paste-a-link path — no search box, no disabled
   * control.
   */
  searchEnabled: boolean;
}
