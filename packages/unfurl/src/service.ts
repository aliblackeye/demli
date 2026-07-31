/**
 * Unfurl service (M17). Turns a freshly-created message's content into link
 * previews WITHOUT blocking the send: {@link UnfurlService.unfurlMessage} is
 * called fire-and-forget from both message-create paths (REST in `apps/api`, WS
 * in `apps/realtime`) AFTER the message is persisted and broadcast.
 *
 * Pipeline per message: extract URLs (capped) → for each, an SSRF-guarded fetch
 * (short-TTL in-memory cache + per-user fetch cap) → OG parse → keep only cards
 * with real content → persist (replace) → publish `message.embeds_updated`
 * channel-scoped on the mutation bus, which the realtime gateway fans out to the
 * channel's visibility-filtered subscribers.
 *
 * Runs one instance per process; each process unfurls only the messages IT
 * created (REST→api, WS→realtime — no message is created in both), so the
 * process-local cache/rate-limit never double-unfurl the same message.
 */

import type { RealtimeMutationPublisher, Repositories } from "@demli/db";
import { serverEvent } from "@demli/protocol";
import type { MessageEmbed } from "@demli/types";
import {
  UNFURL_CACHE_TTL_MS,
  UNFURL_MAX_URLS_PER_MESSAGE,
  UNFURL_PER_USER_FETCHES_PER_MINUTE,
} from "./constants.js";
import { createGuardedFetcher, type GuardedFetcher } from "./fetcher.js";
import { parseOpenGraph, type ParsedEmbed } from "./parse.js";
import { extractUrls } from "./urls.js";

export interface UnfurlMessageInput {
  messageId: string;
  channelId: string;
  authorId: string;
  content: string;
}

export interface UnfurlService {
  /**
   * Extract → fetch → parse → persist → publish. Fire-and-forget: callers use it
   * as `void unfurl.unfurlMessage(...)`. Returns a promise that resolves when the
   * work completes (tests await it). NEVER throws — all failure is logged and
   * swallowed so a bad URL can never affect the already-sent message.
   */
  unfurlMessage(input: UnfurlMessageInput): Promise<void>;
}

export interface UnfurlServiceDeps {
  /** Only the embeds repo is used. */
  repos: Pick<Repositories, "messageEmbeds">;
  /**
   * Publishes `message.embeds_updated` for fan-out. Optional — when omitted the
   * embeds still persist (used by tests that assert the DB row, not the event).
   */
  mutationBus?: RealtimeMutationPublisher;
  /** The SSRF-guarded page fetcher. Default: {@link createGuardedFetcher}. */
  fetchPage?: GuardedFetcher;
  /** Monotonic-ish clock in ms (for cache TTL + rate window). Default: `Date.now`. */
  now?: () => number;
  log?: (message: string) => void;
  maxUrlsPerMessage?: number;
  cacheTtlMs?: number;
  perUserFetchesPerMinute?: number;
}

interface CacheEntry {
  value: ParsedEmbed | null;
  expiresAt: number;
}

interface RateWindow {
  count: number;
  windowStart: number;
}

const RATE_WINDOW_MS = 60_000;
/** Soft ceiling on cache entries; a sweep drops expired ones past this size. */
const CACHE_SOFT_MAX = 2_000;

export function createUnfurlService(deps: UnfurlServiceDeps): UnfurlService {
  const { repos, mutationBus } = deps;
  const fetchPage = deps.fetchPage ?? createGuardedFetcher({ log: deps.log });
  const now = deps.now ?? ((): number => Date.now());
  const log = deps.log ?? ((): void => undefined);
  const maxUrls = deps.maxUrlsPerMessage ?? UNFURL_MAX_URLS_PER_MESSAGE;
  const cacheTtlMs = deps.cacheTtlMs ?? UNFURL_CACHE_TTL_MS;
  const perUserPerMinute = deps.perUserFetchesPerMinute ?? UNFURL_PER_USER_FETCHES_PER_MINUTE;

  const cache = new Map<string, CacheEntry>();
  const rate = new Map<string, RateWindow>();

  /** Consume one per-user fetch token for the current minute; false when over cap. */
  function takeFetchToken(userId: string, at: number): boolean {
    const window = rate.get(userId);
    if (!window || at - window.windowStart >= RATE_WINDOW_MS) {
      rate.set(userId, { count: 1, windowStart: at });
      return true;
    }
    if (window.count >= perUserPerMinute) return false;
    window.count += 1;
    return true;
  }

  function sweepCacheIfLarge(at: number): void {
    if (cache.size < CACHE_SOFT_MAX) return;
    for (const [url, entry] of cache) {
      if (entry.expiresAt <= at) cache.delete(url);
    }
  }

  /** Resolve one URL to a parsed card (or null), honoring cache + rate limit. */
  async function resolveEmbed(userId: string, url: string): Promise<ParsedEmbed | null> {
    const at = now();
    const cached = cache.get(url);
    if (cached && cached.expiresAt > at) return cached.value;

    // Only real (cache-miss) fetches count against the per-user cap.
    if (!takeFetchToken(userId, at)) {
      log(`unfurl: per-user fetch cap reached for ${userId}; skipping ${url}`);
      return null;
    }

    let value: ParsedEmbed | null = null;
    const page = await fetchPage(url);
    if (page) {
      const parsed = parseOpenGraph(page.html, page.finalUrl);
      // Only keep a card that carries something worth showing.
      if (parsed.title || parsed.description || parsed.imageUrl) value = parsed;
    }
    sweepCacheIfLarge(at);
    cache.set(url, { value, expiresAt: now() + cacheTtlMs });
    return value;
  }

  async function unfurlMessage(input: UnfurlMessageInput): Promise<void> {
    try {
      const urls = extractUrls(input.content, maxUrls);
      if (urls.length === 0) return;

      const cards: Array<{ url: string; parsed: ParsedEmbed }> = [];
      for (const url of urls) {
        const parsed = await resolveEmbed(input.authorId, url);
        if (parsed) cards.push({ url, parsed });
      }
      if (cards.length === 0) return;

      const stored = await repos.messageEmbeds.replaceForMessage(
        input.messageId,
        cards.map(({ url, parsed }) => ({
          url,
          title: parsed.title,
          description: parsed.description,
          imageUrl: parsed.imageUrl,
          siteName: parsed.siteName,
        })),
      );
      if (stored.length === 0) return;

      await publish(input.channelId, input.messageId, stored);
    } catch (err) {
      log(
        `unfurl failed for message ${input.messageId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async function publish(
    channelId: string,
    messageId: string,
    embeds: MessageEmbed[],
  ): Promise<void> {
    if (!mutationBus) return;
    await mutationBus.publish({
      channelId,
      event: serverEvent.messageEmbedsUpdated({ channelId, messageId, embeds }),
    });
  }

  return { unfurlMessage };
}
