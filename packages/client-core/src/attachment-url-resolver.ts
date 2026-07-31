/**
 * Signed-URL cache + batcher for attachment tiles (ADR 0008 §5) — shared by
 * desktop and mobile (ADR 0002: one wire implementation).
 *
 * The batch endpoint `POST /channels/:channelId/attachments/urls` is the SOLE
 * source of renderable URLs. Tiles call `request()` when they come near the
 * viewport (desktop IntersectionObserver / mobile FlatList windowing); requests
 * within one batch window per channel are coalesced into a single call
 * (virtualized scroll-back would otherwise fire one request per tile). Entries
 * expire (~1 h TTL) and are transparently re-requested; a fetch failure marks
 * the ids `error` so tiles can show a retry affordance — never a raw error
 * (CLAUDE.md §26).
 *
 * Framework-free (injected fetcher + timers) so the batching/expiry/retry
 * logic is unit-testable; the React glue lives in each app.
 *
 * NOTE: promoted verbatim from the desktop renderer's
 * lib/attachments/url-cache.ts (M10-5) so mobile can consume it; desktop
 * switching its import here is a follow-up owned by frontend-ui (desktop).
 */

import type { AttachmentUrl } from "@demli/protocol";

export type AttachmentUrlStatus = "loading" | "ready" | "error";

export interface AttachmentUrlEntry {
  status: AttachmentUrlStatus;
  /** Renderable URL when status is "ready", else null. */
  url: string | null;
}

export interface AttachmentUrlResolver {
  /** Subscribe to snapshot changes (useSyncExternalStore-compatible). */
  subscribe(listener: () => void): () => void;
  /** Stable-reference snapshot: attachmentId → entry. */
  getSnapshot(): ReadonlyMap<string, AttachmentUrlEntry>;
  /**
   * Ensure fresh URLs exist for these ids (missing, expired, or errored-then-
   * retried ids are fetched; fresh and in-flight ids are no-ops). Ids must
   * belong to `channelId` — the endpoint is channel-authorized.
   */
  request(channelId: string, attachmentIds: string[]): void;
  /** Drop a (failed/expired) entry and fetch it again — the retry affordance. */
  retry(channelId: string, attachmentId: string): void;
  /**
   * Register a local URL (freshly uploaded file: object URL on desktop, file://
   * URI on mobile) so the sender's own tiles render instantly without a
   * round-trip. Never expires, never fetched.
   */
  setLocalUrl(attachmentId: string, url: string): void;
}

export interface AttachmentUrlResolverOptions {
  fetchUrls(channelId: string, attachmentIds: string[]): Promise<AttachmentUrl[]>;
  now?: () => number;
  /** Coalescing window per channel before a batch fires. */
  batchDelayMs?: number;
  /** Max ids per request (API cap is 100). */
  batchMax?: number;
  /** Treat a URL as expired this long before its real expiry (clock skew). */
  expiryMarginMs?: number;
}

interface InternalEntry extends AttachmentUrlEntry {
  /** Epoch ms after which the URL must be re-requested; Infinity for local. */
  freshUntil: number;
  local: boolean;
}

export function createAttachmentUrlResolver(
  options: AttachmentUrlResolverOptions,
): AttachmentUrlResolver {
  const now = options.now ?? Date.now;
  const batchDelayMs = options.batchDelayMs ?? 25;
  const batchMax = options.batchMax ?? 100;
  const expiryMarginMs = options.expiryMarginMs ?? 60_000;

  const entries = new Map<string, InternalEntry>();
  const listeners = new Set<() => void>();
  /** channelId → ids queued for the next batch. */
  const queued = new Map<string, Set<string>>();
  /** channelId → armed batch timer. */
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlight = new Set<string>();

  let snapshot: ReadonlyMap<string, AttachmentUrlEntry> = new Map();
  let snapshotDirty = false;

  function notify(): void {
    snapshotDirty = true;
    for (const listener of listeners) listener();
  }

  function getSnapshot(): ReadonlyMap<string, AttachmentUrlEntry> {
    if (snapshotDirty) {
      const next = new Map<string, AttachmentUrlEntry>();
      for (const [id, entry] of entries) {
        next.set(id, { status: entry.status, url: entry.url });
      }
      snapshot = next;
      snapshotDirty = false;
    }
    return snapshot;
  }

  function needsFetch(id: string): boolean {
    if (inFlight.has(id)) return false;
    const entry = entries.get(id);
    if (!entry) return true;
    if (entry.local) return false;
    if (entry.status === "error") return false; // waits for an explicit retry
    if (entry.status === "loading") return true; // queued below, deduped there
    return now() >= entry.freshUntil;
  }

  async function flush(channelId: string): Promise<void> {
    timers.delete(channelId);
    const ids = [...(queued.get(channelId) ?? [])];
    queued.delete(channelId);
    if (ids.length === 0) return;
    for (const id of ids) inFlight.add(id);

    // The API caps a batch at 100 ids — chunk a deep scroll-back.
    for (let i = 0; i < ids.length; i += batchMax) {
      const chunk = ids.slice(i, i + batchMax);
      try {
        const urls = await options.fetchUrls(channelId, chunk);
        const byId = new Map(urls.map((u) => [u.attachmentId, u]));
        for (const id of chunk) {
          inFlight.delete(id);
          const signed = byId.get(id);
          if (signed) {
            entries.set(id, {
              status: "ready",
              url: signed.url,
              freshUntil: Date.parse(signed.urlExpiresAt) - expiryMarginMs,
              local: false,
            });
          } else {
            entries.set(id, { status: "error", url: null, freshUntil: 0, local: false });
          }
        }
      } catch {
        for (const id of chunk) {
          inFlight.delete(id);
          entries.set(id, { status: "error", url: null, freshUntil: 0, local: false });
        }
      }
    }
    notify();
  }

  function enqueue(channelId: string, id: string): void {
    let set = queued.get(channelId);
    if (!set) {
      set = new Set();
      queued.set(channelId, set);
    }
    set.add(id);
    if (!timers.has(channelId)) {
      timers.set(
        channelId,
        setTimeout(() => void flush(channelId), batchDelayMs),
      );
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getSnapshot,

    request(channelId, attachmentIds) {
      let changed = false;
      for (const id of attachmentIds) {
        if (!needsFetch(id)) continue;
        const existing = entries.get(id);
        if (!existing || existing.status !== "loading") {
          entries.set(id, { status: "loading", url: null, freshUntil: 0, local: false });
          changed = true;
        }
        enqueue(channelId, id);
      }
      if (changed) notify();
    },

    retry(channelId, attachmentId) {
      const entry = entries.get(attachmentId);
      if (entry?.local || inFlight.has(attachmentId)) return;
      entries.set(attachmentId, { status: "loading", url: null, freshUntil: 0, local: false });
      enqueue(channelId, attachmentId);
      notify();
    },

    setLocalUrl(attachmentId, url) {
      entries.set(attachmentId, {
        status: "ready",
        url,
        freshUntil: Number.POSITIVE_INFINITY,
        local: true,
      });
      notify();
    },
  };
}
