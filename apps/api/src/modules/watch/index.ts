/**
 * Watch-party HTTP module (M20 wave 2, ADR 0016 revisited).
 *
 *   GET /watch/capabilities                → { searchEnabled }
 *   GET /watch/search?channelId=…&q=…      → { results: WatchSearchResult[] }
 *
 * The queue itself is entirely a WebSocket concern (`apps/realtime`); the only
 * thing HTTP owns here is SEARCH, because it is a request/response lookup against
 * an external service with a hard daily quota rather than anything broadcast.
 *
 * ## Why "browse YouTube inside the app" is not what this is
 *
 * The founder asked for a browser embedded in the watch-party panel. That is not
 * buildable safely and it is not buildable at all: `youtube.com` sends
 * `X-Frame-Options: SAMEORIGIN` and refuses to be framed, so the only way to get
 * a real browser in there is an Electron `<webview>` — which would punch straight
 * through the single-host `frame-src` CSP and the `will-frame-navigate` lock that
 * were added specifically to contain this feature (ADR 0016 §Security). So the
 * browsing happens in OUR UI against this endpoint, and the sandbox stays shut.
 *
 * ## Authorization
 *
 * Session + `loadVisibleChannel` + "it is a voice channel". The channel is not
 * decoration: without it, any authenticated account is a free YouTube proxy
 * spending our key's quota. With it, a caller must be a member who can SEE a
 * voice channel — the only place a watch party can exist.
 *
 * ## Disabled is a first-class state
 *
 * No `YOUTUBE_API_KEY` ⇒ the search route answers 503 and, more importantly,
 * `/watch/capabilities` answers `searchEnabled: false` so the client renders the
 * paste-a-link path INSTEAD of a search box. A control that looks pressable and
 * does nothing is exactly what §35 forbids, and "the user finds out by typing a
 * query and pressing enter" is that control.
 */

import type { FastifyInstance } from "fastify";
import { watchSearchQuerySchema, type WatchCapabilities } from "@demli/protocol";
import type { WatchSearchQuotaStore } from "@demli/db";
import { ApiError, parseWith } from "../../errors.js";
import { loadVisibleChannel } from "../../lib/permissions.js";
import { requireUser } from "../../plugins/auth.js";
import { createWatchSearchService, type WatchSearchService } from "./search-service.js";
import { createYouTubeClient, type YouTubeFetchJson } from "./youtube.js";
import { LIST_LIMIT, userRateLimit } from "../../lib/rate-limit.js";

export * from "./youtube.js";
export * from "./search-service.js";

export interface WatchModuleOptions {
  /** Absent/empty ⇒ search is DISABLED (503 + `searchEnabled: false`). */
  apiKey?: string | undefined;
  /** Daily quota accounting. Redis-backed in production. */
  quota: WatchSearchQuotaStore;
  /** Test seam for the upstream HTTP call. */
  fetchJson?: YouTubeFetchJson;
  /** Fully-built service; tests inject this to bypass client construction. */
  service?: WatchSearchService;
  log?: (message: string) => void;
}

export async function registerWatchModule(
  server: FastifyInstance,
  options: WatchModuleOptions,
): Promise<void> {
  const apiKey = options.apiKey?.trim();
  const service: WatchSearchService | null =
    options.service ??
    (apiKey
      ? createWatchSearchService({
          client: createYouTubeClient({
            apiKey,
            ...(options.fetchJson ? { fetchJson: options.fetchJson } : {}),
            ...(options.log ? { log: options.log } : {}),
          }),
          quota: options.quota,
          ...(options.log ? { log: options.log } : {}),
        })
      : null);

  /**
   * What this deployment can do. Authenticated (it describes OUR configuration,
   * which is nobody's business anonymously) but deliberately un-rate-limited and
   * channel-free: it is a constant read, it spends no quota, and a client calls
   * it once when the panel opens. Rate-limiting the very call whose answer keeps
   * clients from hammering the expensive route would be backwards.
   */
  server.get(
    "/watch/capabilities",
    {
      preHandler: [server.authenticate],
      config: { rateLimit: userRateLimit(LIST_LIMIT) },
    },
    async (): Promise<WatchCapabilities> => ({ searchEnabled: service !== null }),
  );

  server.get(
    "/watch/search",
    {
      preHandler: [server.authenticate],
      // The FIRST of two limits, and the cheap one: it protects our own server
      // from a client that fires a request per keystroke. The real ceiling —
      // YouTube's 10,000 units a day — is enforced inside the service, because it
      // is shared across everyone and survives restarts, which a per-route bucket
      // is not and does not. 10 per 10 seconds sits above any human typing with a
      // debounce and far below anything that could drain a day's budget alone.
      config: {
        rateLimit: userRateLimit({ max: 10, timeWindow: "10 seconds" }),
      },
    },
    async (request) => {
      const user = requireUser(request);
      const { channelId, q } = parseWith(watchSearchQuerySchema, request.query);

      // An invisible or foreign channel answers 404 (never 403), so this route is
      // not an existence oracle for restricted channels — the same rule the pins
      // and messages routes follow.
      const access = await loadVisibleChannel(server, channelId, user.id);
      if (access.channel.kind !== "voice") {
        throw new ApiError(
          400,
          "INVALID_CHANNEL",
          "Watch party search is only available in voice channels.",
        );
      }

      if (!service) {
        throw new ApiError(
          503,
          "WATCH_SEARCH_DISABLED",
          "Video search is not configured on this server. Paste a YouTube link instead.",
        );
      }

      const outcome = await service.search({ userId: user.id, query: q });
      if (outcome.ok) return { results: outcome.results };

      // Three refusals, three messages. A user who has personally searched 25
      // times today needs to hear something different from one who arrived after
      // the whole server ran out, and both need something different from "YouTube
      // is not answering" — the first two clear at midnight, the third may clear
      // in a minute.
      if (outcome.reason === "per_user") {
        throw new ApiError(
          429,
          "WATCH_SEARCH_QUOTA",
          "You have used today's video searches. Paste a YouTube link, or try again tomorrow.",
        );
      }
      if (outcome.reason === "daily_budget") {
        throw new ApiError(
          429,
          "WATCH_SEARCH_QUOTA",
          "Video search has reached today's limit for this server. Paste a YouTube link instead.",
        );
      }
      throw new ApiError(
        503,
        "WATCH_SEARCH_UNAVAILABLE",
        "Video search is temporarily unavailable. Paste a YouTube link instead.",
      );
    },
  );
}
