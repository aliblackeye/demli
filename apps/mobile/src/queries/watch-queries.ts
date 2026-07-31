/**
 * Watch Party server reads on mobile: what this deployment can do, and the video
 * search (M20 mobile parity).
 *
 * A deliberate mirror of `apps/desktop/src/renderer/src/queries/watch-queries.ts`,
 * including the three quota rules — because the budget being protected is the
 * DEPLOYMENT's, not the platform's, and a phone that searched as you typed would
 * spend the laptop's allowance too.
 *
 * ## The quota is the design constraint
 *
 * `GET /watch/search` costs a unit of a YouTube Data API budget shared by EVERY
 * user of this install and refilled once a day — roughly a hundred searches for
 * everyone combined, with a per-user daily cap underneath it. Three rules follow,
 * and all three live here rather than in the sheet, so no future caller can opt
 * out of them by rendering a different box:
 *
 *  1. **No search-as-you-type.** {@link useWatchVideoSearch} exposes `run`, and
 *     only an explicit user act calls it. A "debounced" keystroke search is still
 *     one request per pause in typing — and on a phone, where typing is slower
 *     and pauses are longer, a debounce is WORSE than on desktop: more pauses,
 *     more requests.
 *  2. **A repeat is free.** Results are cached per normalized query for the life
 *     of the hook, so returning to a query already fetched costs nothing.
 *  3. **A burst is one request.** `SUBMIT_COOLDOWN_MS` swallows the double-tap on
 *     a search button, which on a touch screen is the single most common
 *     accidental spend there is.
 *
 * A pasted LINK never reaches this hook at all: the sheet parses the field first
 * and submits a parseable ref directly, so the common case — somebody dropped a
 * YouTube link in the chat and you long-pressed to copy it — is free.
 */

import { useCallback, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ChannelId } from "@demli/types";
import { ApiClientError } from "@demli/client-core";
import { getApi } from "@/lib/clients";
import { queryKeys } from "@/lib/query-client";
import { watchSearchFailure, type WatchSearchFailure } from "@/components/watch/watch-queue";

/**
 * Minimum gap between two accepted submissions. Comfortably below any real "type
 * a new query and search again" cycle, and comfortably above the interval between
 * the two events a double-tap produces.
 */
const SUBMIT_COOLDOWN_MS = 700;

/** One search hit, exactly as `GET /watch/search` returns it. */
export interface WatchPickerResult {
  videoId: string;
  title: string;
  channelTitle: string;
  durationSeconds: number | null;
  thumbnailUrl: string;
}

export type WatchPickerStatus = "idle" | "searching" | "done" | "error";

export interface WatchPickerSearchState {
  status: WatchPickerStatus;
  /** The query the current `results` / `failure` belong to. */
  query: string;
  results: readonly WatchPickerResult[];
  /** Set when `status === "error"`; decides which of the four copies shows. */
  failure: WatchSearchFailure | null;
}

export const IDLE_WATCH_SEARCH: WatchPickerSearchState = {
  status: "idle",
  query: "",
  results: [],
  failure: null,
};

/**
 * Does this server have video search configured?
 *
 * Cached hard: the answer is a deployment constant, it spends no quota, and a
 * client asks it once when the picker opens. `null` while it is in flight — the
 * sheet treats that as "not yet" and renders the link path, so the search box
 * appears once rather than flickering in behind a resolved promise.
 */
export function useWatchSearchEnabled(enabled: boolean): boolean | null {
  const { data } = useQuery({
    queryKey: queryKeys.watchCapabilities,
    queryFn: () => getApi().getWatchCapabilities(),
    enabled,
    staleTime: 60 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    retry: 1,
  });
  return data?.searchEnabled ?? null;
}

export interface UseWatchVideoSearch {
  state: WatchPickerSearchState;
  /** Run a search. Call ONLY from an explicit user act — see the file header. */
  run: (query: string) => void;
  /** Drop results and the in-flight guard (the sheet calls this on open). */
  reset: () => void;
}

/**
 * The search state machine for one channel's picker.
 *
 * Deliberately NOT `useQuery`: TanStack would happily refetch on app focus or
 * remount, and on a phone BOTH of those fire constantly — every return from the
 * background is a focus event. Each one would be a unit of a shared daily budget
 * spent without anybody asking. Here a request happens when, and only when, `run`
 * is called and the guards let it through.
 */
export function useWatchVideoSearch(channelId: ChannelId | null): UseWatchVideoSearch {
  const [state, setState] = useState<WatchPickerSearchState>(IDLE_WATCH_SEARCH);
  /** query → results, for the life of this hook. A repeat costs nothing. */
  const cacheRef = useRef(new Map<string, WatchPickerResult[]>());
  const lastSubmitMsRef = useRef(0);
  const inFlightRef = useRef(false);
  /**
   * Sequence number, so a slow first response cannot overwrite a fast second one.
   * Without it, searching "a" then "b" can land "a"'s results under "b"'s query —
   * results that look like an answer and are not.
   */
  const seqRef = useRef(0);

  const reset = useCallback(() => {
    inFlightRef.current = false;
    seqRef.current += 1;
    setState(IDLE_WATCH_SEARCH);
  }, []);

  const run = useCallback(
    (rawQuery: string) => {
      const query = rawQuery.trim();
      if (query.length === 0 || channelId === null) return;

      const cached = cacheRef.current.get(query);
      if (cached) {
        setState({ status: "done", query, results: cached, failure: null });
        return;
      }

      // Burst guard. Two taps in the same breath are one intention.
      const now = Date.now();
      if (inFlightRef.current || now - lastSubmitMsRef.current < SUBMIT_COOLDOWN_MS) return;
      lastSubmitMsRef.current = now;
      inFlightRef.current = true;

      const seq = ++seqRef.current;
      setState({ status: "searching", query, results: [], failure: null });

      getApi()
        .searchWatchVideos({ channelId, q: query })
        .then((response) => {
          if (seq !== seqRef.current) return;
          cacheRef.current.set(query, response.results);
          setState({ status: "done", query, results: response.results, failure: null });
        })
        .catch((error: unknown) => {
          if (seq !== seqRef.current) return;
          // A failure is NOT cached: quota resets, and YouTube being briefly
          // unreachable must not poison the query for the rest of the session.
          const code = error instanceof ApiClientError ? error.code : null;
          setState({
            status: "error",
            query,
            results: [],
            failure: watchSearchFailure(code),
          });
        })
        .finally(() => {
          if (seq === seqRef.current) inFlightRef.current = false;
        });
    },
    [channelId],
  );

  return { state, run, reset };
}
