/**
 * Watch Party server reads: what this deployment can do, and the video search
 * (M20 wave 3).
 *
 * ## The quota is the design constraint
 *
 * `GET /watch/search` costs a unit of a YouTube Data API budget that is shared
 * by EVERY user of this deployment and refills once a day. That is roughly a
 * hundred searches for the whole install, with a per-user daily cap underneath
 * it. Three rules follow, and all three live here rather than in the component,
 * so no future caller can opt out of them by rendering a different box:
 *
 *  1. **No search-as-you-type.** {@link useWatchVideoSearch} exposes `run`, and
 *     only an explicit user act calls it. A "debounced" keystroke search is
 *     still one request per pause in typing — half a dozen for one query — and
 *     two people looking for one clip would spend the day's budget.
 *  2. **A repeat is free.** Results are cached per normalized query for the life
 *     of the hook, so going back to a query already fetched costs nothing.
 *  3. **A burst is one request.** `SUBMIT_COOLDOWN_MS` swallows the double-Enter
 *     and the double-click — the cheapest class of accidental spend there is.
 *
 * A pasted LINK never reaches this hook at all: the picker parses the field
 * first and submits a parseable ref directly, so the common case is free.
 */

import { useCallback, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ChannelId } from "@demli/types";
import {
  IDLE_WATCH_SEARCH,
  watchSearchFailure,
  type WatchPickerResult,
  type WatchPickerSearchState,
} from "@demli/app-ui";
import { ApiClientError } from "@demli/client-core";
import { api } from "../lib/api-client";

/**
 * Minimum gap between two accepted submissions. Comfortably below any real
 * "type a new query and search again" cycle, and comfortably above the interval
 * between the two events a double-click or a held Enter produces.
 */
const SUBMIT_COOLDOWN_MS = 700;

/**
 * Does this server have video search configured?
 *
 * Cached hard: the answer is a deployment constant, it spends no quota, and a
 * client asks it once when the picker opens. `null` while it is in flight — the
 * picker treats that as "not yet" and renders the link path, so the search box
 * appears once rather than flickering in behind a resolved promise.
 */
export function useWatchSearchEnabled(enabled: boolean): boolean | null {
  const { data } = useQuery({
    queryKey: ["watch", "capabilities"],
    queryFn: () => api.getWatchCapabilities(),
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
  /** Drop results and the in-flight guard (the picker calls this on open). */
  reset: () => void;
}

/**
 * The search state machine for one channel's picker.
 *
 * Deliberately NOT `useQuery`: TanStack would happily refetch on window focus or
 * remount, and every one of those is a unit of a shared daily budget spent
 * without anybody asking for it. Here a request happens when, and only when,
 * `run` is called and the guards let it through.
 */
export function useWatchVideoSearch(channelId: ChannelId | null): UseWatchVideoSearch {
  const [state, setState] = useState<WatchPickerSearchState>(IDLE_WATCH_SEARCH);
  /** query → results, for the life of this hook. A repeat costs nothing. */
  const cacheRef = useRef(new Map<string, WatchPickerResult[]>());
  const lastSubmitMsRef = useRef(0);
  const inFlightRef = useRef(false);
  /**
   * Sequence number, so a slow first response cannot overwrite a fast second
   * one. Without it, searching "a" then "b" can land "a"'s results under "b"'s
   * query — results that look like an answer and are not.
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

      // Burst guard. Two Enters in the same breath are one intention.
      const now = Date.now();
      if (inFlightRef.current || now - lastSubmitMsRef.current < SUBMIT_COOLDOWN_MS) return;
      lastSubmitMsRef.current = now;
      inFlightRef.current = true;

      const seq = ++seqRef.current;
      setState({ status: "searching", query, results: [], failure: null });

      api
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
