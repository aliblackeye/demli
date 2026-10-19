import { useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import { router } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Plus } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import type { FriendGroup } from "@demli/types";
import { BrandMark } from "@/components/BrandMark";
import { Skeleton } from "@/components/Skeleton";
import type { GroupDetails } from "@/lib/clients";
import { queryKeys } from "@/lib/query-client";
import { TAB_BAR_CONTENT_HEIGHT } from "@/lib/tab-bar";
import { useGroups } from "@/queries/chat-queries";
import { useChatStore } from "@/stores/chat-store";
import { useHomeShellStore } from "@/stores/home-shell-store";
import { colors, radius, space } from "@/theme/theme";
import { deriveServerUnread } from "./server-unread";
import { ServerActionsSheet } from "./ServerActionsSheet";
import { RAIL_TILE, RAIL_WIDTH, ServerRailItem, ServerTile } from "./ServerRailItem";

/** Short separator between the Home entry and the server column. */
function RailDivider() {
  return (
    <View importantForAccessibility="no" style={{ alignItems: "center", paddingVertical: space.xs }}>
      <View style={{ width: 24, height: 2, borderRadius: radius.pill, backgroundColor: colors.surfaceRaised }} />
    </View>
  );
}

/**
 * The left vertical server RAIL of the Home shell, on the black page:
 *   - top: the Home / DM entry (the Demli mark),
 *   - a short divider,
 *   - the scrollable server tiles (edge pill, unread counts),
 *   - a trailing "+" that opens the existing create/join-server flow.
 *
 * First load shows three tile placeholders instead of an empty column, so the
 * rail never flashes "you have no servers" while the list is on its way.
 *
 * Selection lives in {@link useHomeShellStore}; tapping an entry only flips that
 * one value, so the PANEL swaps and exactly the two affected rail items
 * re-render (memoized items + this container). The rail never subscribes to
 * presence/typing, so those ticks never touch it (§27).
 *
 * Long-pressing a server opens the same {@link ServerActionsSheet} as the panel
 * header — the only place membership actions live.
 */
export function ServerRail({ selectedServerId }: { selectedServerId: string | null }) {
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const selectServer = useHomeShellStore((s) => s.selectServer);
  const [actionsFor, setActionsFor] = useState<FriendGroup | null>(null);

  const groups = useGroups();
  const servers = useMemo<FriendGroup[]>(
    () => (groups.data ?? []).filter((g) => g.kind === "server"),
    [groups.data],
  );

  // Unread is tracked per channel; map each server to its (cached) channel ids
  // so we can aggregate. Servers not yet opened have no cached details → no dot
  // until first visit, which is honest (no fake signal).
  const unreadChannelIds = useChatStore((s) => s.unreadChannelIds);
  const mentionUnreadChannelIds = useChatStore((s) => s.mentionUnreadChannelIds);
  const unreadCounts = useChatStore((s) => s.unreadCounts);
  const notificationMutes = useChatStore((s) => s.notificationMutes);

  const serverUnread = useMemo(() => {
    const channelIdsByServer: Record<string, string[]> = {};
    for (const server of servers) {
      const details = queryClient.getQueryData<GroupDetails>(queryKeys.groupDetails(server.id));
      channelIdsByServer[server.id] = (details?.channels ?? []).map((c) => c.id);
    }
    return deriveServerUnread(
      channelIdsByServer,
      unreadChannelIds,
      mentionUnreadChannelIds,
      unreadCounts,
      notificationMutes,
    );
    // `queryClient` cache reads are intentionally not a dep (channel lists are
    // near-static); a new server's badge settles on the next unread/mute change.
  }, [servers, unreadChannelIds, mentionUnreadChannelIds, unreadCounts, notificationMutes, queryClient]);

  const longPressHint = t("mobile:home.longPressOptionsA11y");

  return (
    <View style={{ width: RAIL_WIDTH, backgroundColor: colors.rail, paddingTop: space.xs }}>
      <ServerRailItem
        active={selectedServerId === null}
        onPress={() => selectServer(null)}
        accessibilityLabel={t("mobile:home.railHomeA11y")}
      >
        {/* The Demli mark — the rail's anchor tile (desktop GroupRail home =
            the same logo). Selection is carried by the edge pill, so the mark
            stays full-colour. */}
        <BrandMark size="sm" />
      </ServerRailItem>

      <RailDivider />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          alignItems: "center",
          paddingBottom: insets.bottom + TAB_BAR_CONTENT_HEIGHT + space.md,
        }}
      >
        {groups.isPending ? (
          <View
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel={t("mobile:ui.loading")}
            style={{ alignItems: "center", gap: space.sm, paddingTop: space.xs }}
          >
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} width={RAIL_TILE} height={RAIL_TILE} radius={radius.xl} />
            ))}
          </View>
        ) : (
          servers.map((server) => {
            const flags = serverUnread[server.id];
            return (
              <ServerRailItem
                key={server.id}
                active={selectedServerId === server.id}
                unread={flags?.unread ?? false}
                mention={flags?.mention ?? false}
                count={flags?.count ?? 0}
                onPress={() => selectServer(server.id)}
                onLongPress={() => setActionsFor(server)}
                accessibilityLabel={t("mobile:home.railServerA11y", { name: server.name })}
                accessibilityHint={longPressHint}
              >
                <ServerTile name={server.name} iconUrl={server.iconUrl} />
              </ServerRailItem>
            );
          })
        )}

        {/* Create / join a server — reuses the existing new-group flow. A
            utility tile: surface fill, coral glyph, tone + give on press. */}
        <ServerRailItem
          active={false}
          onPress={() => router.push("/new-group")}
          accessibilityLabel={t("mobile:home.railAddServerA11y")}
          tileTone={colors.surface}
        >
          <Plus size={22} color={colors.accent} strokeWidth={2.2} />
        </ServerRailItem>
      </ScrollView>

      <ServerActionsSheet
        visible={actionsFor !== null}
        groupId={actionsFor?.id ?? null}
        serverName={actionsFor?.name ?? ""}
        onClose={() => setActionsFor(null)}
        onLeft={() => {
          if (actionsFor && selectedServerId === actionsFor.id) selectServer(null);
          setActionsFor(null);
        }}
      />
    </View>
  );
}
