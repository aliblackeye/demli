/**
 * TanStack Query infinite-query hooks for the Tenor GIF proxy.
 *
 * Both hooks page through the server's cursor (`next` field) and flatten
 * pages into a single results array for the FlatList.
 */

import { useInfiniteQuery } from "@tanstack/react-query";
import { getApi } from "../lib/clients";

const GIF_PAGE_SIZE = 20;

export function useGifTrending() {
  return useInfiniteQuery({
    queryKey: ["gif", "trending"],
    queryFn: ({ pageParam }) =>
      getApi().trendingGifs({ limit: GIF_PAGE_SIZE, pos: pageParam || undefined }),
    initialPageParam: "" as string,
    getNextPageParam: (last) => (last.next ? last.next : undefined),
    staleTime: 5 * 60_000,
  });
}

export function useGifSearch(q: string) {
  return useInfiniteQuery({
    queryKey: ["gif", "search", q],
    queryFn: ({ pageParam }) =>
      getApi().searchGifs(q, { limit: GIF_PAGE_SIZE, pos: pageParam || undefined }),
    initialPageParam: "" as string,
    getNextPageParam: (last) => (last.next ? last.next : undefined),
    enabled: q.trim().length > 0,
    staleTime: 60_000,
  });
}
