import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { GroupDetails } from "@/lib/clients";
import { queryKeys } from "@/lib/query-client";
import { useGroups } from "@/queries/chat-queries";
import { useChatStore } from "@/stores/chat-store";
import { deriveHomeUnreadTotal, type HomeUnreadTotal } from "./server-unread";

/**
 * The aggregate unread signal for the bottom Home tab badge (#110). Reuses the
 * same mute-correct derivation as the server rail (server channels via cached
 * group details; DMs / group chats as channel-scope streams), so the tab badge
 * can never disagree with what the rail and rows show. Subscribes narrowly to the
 * unread maps so only this thin tab-bar re-renders on an unread change (§27).
 */
export function useHomeUnreadTotal(): HomeUnreadTotal {
  const queryClient = useQueryClient();
  const groups = useGroups();
  const unreadChannelIds = useChatStore((s) => s.unreadChannelIds);
  const mentionUnreadChannelIds = useChatStore((s) => s.mentionUnreadChannelIds);
  const unreadCounts = useChatStore((s) => s.unreadCounts);
  const notificationMutes = useChatStore((s) => s.notificationMutes);

  return useMemo(() => {
    const channelIdsByServer: Record<string, string[]> = {};
    for (const g of groups.data ?? []) {
      if (g.kind !== "server") continue;
      const details = queryClient.getQueryData<GroupDetails>(queryKeys.groupDetails(g.id));
      channelIdsByServer[g.id] = (details?.channels ?? []).map((c) => c.id);
    }
    return deriveHomeUnreadTotal(
      channelIdsByServer,
      unreadChannelIds,
      mentionUnreadChannelIds,
      unreadCounts,
      notificationMutes,
    );
    // Cache reads are intentionally not a dep (channel lists are near-static); the
    // total settles on the next unread/mute change.
  }, [groups.data, unreadChannelIds, mentionUnreadChannelIds, unreadCounts, notificationMutes, queryClient]);
}
