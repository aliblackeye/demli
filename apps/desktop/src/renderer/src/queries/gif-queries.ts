import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "../lib/api-client";

export function useGifTrending(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: ["gif", "trending"],
    queryFn: ({ pageParam }) => api.trendingGifs({ limit: 20, pos: pageParam || undefined }),
    initialPageParam: "",
    getNextPageParam: (lastPage) => (lastPage.next ? lastPage.next : undefined),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useGifSearch(q: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: ["gif", "search", q],
    queryFn: ({ pageParam }) => api.searchGifs(q, { limit: 20, pos: pageParam || undefined }),
    initialPageParam: "",
    getNextPageParam: (lastPage) => (lastPage.next ? lastPage.next : undefined),
    enabled: enabled && q.length > 0,
    staleTime: 60_000,
  });
}
