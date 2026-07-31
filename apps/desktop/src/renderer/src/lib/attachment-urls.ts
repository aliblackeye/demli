/**
 * Signed read-URL layer for attachments (ADR 0008 §2).
 *
 * The message DTO carries metadata only; playable/renderable URLs are minted,
 * per-viewer and short-lived (~1 h), by the batch `getAttachmentUrls` endpoint.
 * This module:
 *
 * - BATCHES per-channel requests inside a microtask window, so N tiles entering
 *   the viewport at once cost ONE HTTP call (chunked at the server's 100-id cap).
 * - CACHES each URL in memory and treats it as stale ~50 min in (well before the
 *   server TTL), so a long-open channel silently re-signs before a URL dies.
 * - exposes `useAttachmentUrl`, which fetches lazily (the tile passes
 *   `enabled` only once it nears the viewport) and re-signs on a timer while
 *   mounted, keeping the currently-shown image up until the fresh URL lands.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { AttachmentUrl } from "@demli/protocol";
import type { AttachmentId } from "@demli/types";
import { api } from "./api-client";

/** Collect requests fired in the same tick into one batch. */
const BATCH_WINDOW_MS = 16;
/** Server caps a batch at 100 ids (ADR 0008 API). */
const MAX_BATCH = 100;
/** Re-sign this long before the server's stated expiry. */
const REFRESH_MARGIN_MS = 60_000;
/** Never trust a cached URL longer than this, even if the server says 1 h. */
const MAX_CACHE_MS = 50 * 60_000;

interface CacheEntry {
  url: string;
  thumbnailUrl?: string;
  urlExpiresAt: string;
  /** Epoch ms at which this entry is considered stale and must be re-signed. */
  refreshAtMs: number;
}

const cache = new Map<AttachmentId, CacheEntry>();

function toEntry(u: AttachmentUrl, now: number): CacheEntry {
  const serverRefresh = Date.parse(u.urlExpiresAt) - REFRESH_MARGIN_MS;
  return {
    url: u.url,
    thumbnailUrl: u.thumbnailUrl,
    urlExpiresAt: u.urlExpiresAt,
    refreshAtMs: Math.min(serverRefresh, now + MAX_CACHE_MS),
  };
}

function entryToUrl(id: AttachmentId, entry: CacheEntry): AttachmentUrl {
  return {
    attachmentId: id,
    url: entry.url,
    urlExpiresAt: entry.urlExpiresAt,
    thumbnailUrl: entry.thumbnailUrl,
  };
}

/** Synchronous cache peek (fresh only), for a tile's initial render. */
export function peekAttachmentUrl(id: AttachmentId): AttachmentUrl | null {
  const entry = cache.get(id);
  if (entry && Date.now() < entry.refreshAtMs) return entryToUrl(id, entry);
  return null;
}

interface Waiter {
  resolve: (u: AttachmentUrl) => void;
  reject: (e: unknown) => void;
}

interface PendingBatch {
  ids: Set<AttachmentId>;
  waiters: Map<AttachmentId, Waiter[]>;
  timer: ReturnType<typeof setTimeout> | null;
}

const batches = new Map<string, PendingBatch>();

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function flushChannel(channelId: string): Promise<void> {
  const batch = batches.get(channelId);
  if (!batch) return;
  batches.delete(channelId);

  const ids = [...batch.ids];
  const settle = (id: AttachmentId, run: (w: Waiter) => void): void => {
    for (const waiter of batch.waiters.get(id) ?? []) run(waiter);
  };

  for (const group of chunk(ids, MAX_BATCH)) {
    try {
      const { urls } = await api.getAttachmentUrls(channelId, group);
      const now = Date.now();
      const byId = new Map(urls.map((u) => [u.attachmentId, u]));
      for (const id of group) {
        const url = byId.get(id);
        if (url) {
          cache.set(id, toEntry(url, now));
          settle(id, (w) => w.resolve(url));
        } else {
          // The server omitted it — deleted, or no longer visible.
          settle(id, (w) => w.reject(new Error("This attachment is no longer available.")));
        }
      }
    } catch (err) {
      for (const id of group) settle(id, (w) => w.reject(err));
    }
  }
}

/** Fresh URL from cache, or a batched request to the API. */
export function fetchAttachmentUrl(channelId: string, id: AttachmentId): Promise<AttachmentUrl> {
  const fresh = peekAttachmentUrl(id);
  if (fresh) return Promise.resolve(fresh);

  return new Promise<AttachmentUrl>((resolve, reject) => {
    let batch = batches.get(channelId);
    if (!batch) {
      batch = { ids: new Set(), waiters: new Map(), timer: null };
      batches.set(channelId, batch);
    }
    batch.ids.add(id);
    const waiters = batch.waiters.get(id) ?? [];
    waiters.push({ resolve, reject });
    batch.waiters.set(id, waiters);
    if (batch.timer === null) {
      batch.timer = setTimeout(() => void flushChannel(channelId), BATCH_WINDOW_MS);
    }
  });
}

export type AttachmentUrlStatus = "idle" | "loading" | "ready" | "error";

export interface UseAttachmentUrlResult {
  status: AttachmentUrlStatus;
  url?: string;
  thumbnailUrl?: string;
  retry: () => void;
}

/**
 * Lazily resolve (and keep fresh) a signed URL for one attachment. Pass
 * `enabled: false` until the tile nears the viewport so off-screen media never
 * hits the network. While mounted, the URL is re-signed shortly before it
 * expires without flashing the currently-shown image.
 */
export function useAttachmentUrl(
  channelId: string,
  attachmentId: AttachmentId,
  enabled: boolean,
): UseAttachmentUrlResult {
  const [state, setState] = useState<Omit<UseAttachmentUrlResult, "retry">>(() => {
    const cached = peekAttachmentUrl(attachmentId);
    return cached
      ? { status: "ready", url: cached.url, thumbnailUrl: cached.thumbnailUrl }
      : { status: "idle" };
  });
  const [retryToken, setRetryToken] = useState(0);
  const retry = useCallback(() => setRetryToken((n) => n + 1), []);
  const readyRef = useRef(state.status === "ready");

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const load = (): void => {
      // Keep the current image visible across a background re-sign.
      if (!readyRef.current) setState({ status: "loading" });
      fetchAttachmentUrl(channelId, attachmentId)
        .then((u) => {
          if (cancelled) return;
          readyRef.current = true;
          setState({ status: "ready", url: u.url, thumbnailUrl: u.thumbnailUrl });
          const untilRefresh = Math.min(
            MAX_CACHE_MS,
            Math.max(30_000, Date.parse(u.urlExpiresAt) - REFRESH_MARGIN_MS - Date.now()),
          );
          timer = setTimeout(load, untilRefresh);
        })
        .catch(() => {
          if (cancelled) return;
          readyRef.current = false;
          setState({ status: "error" });
        });
    };

    load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [channelId, attachmentId, enabled, retryToken]);

  return { ...state, retry };
}
