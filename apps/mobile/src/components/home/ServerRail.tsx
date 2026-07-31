import { useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { router } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Plus } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import type { FriendGroup } from "@demli/types";
import { Avatar } from "@/components/Avatar";
import { BrandMark } from "@/components/BrandMark";
import type { GroupDetails } from "@/lib/clients";
import { queryKeys } from "@/lib/query-client";
import { TAB_BAR_CONTENT_HEIGHT } from "@/lib/tab-bar";
import { useGroups } from "@/queries/chat-queries";
import { useChatStore } from "@/stores/chat-store";
import { useHomeShellStore } from "@/stores/home-shell-store";
import { colors, radius, space } from "@/theme/theme";
import { deriveServerUnread } from "./server-unread";
import { ServerActionsSheet } from "./ServerActionsSheet";
import { RAIL_WIDTH, ServerRailItem } from "./ServerRailItem";

/** Thin separator between the Home entry and the server column. */
function RailDivider() {
  return (
    <View style={{ alignItems: "center", paddingVertical: space.sm }}>
      <View style={{ width: 28, height: 2, borderRadius: 1, backgroundColor: colors.stroke }} />
    </View>
  );
}

/**
 * The left vertical server RAIL of the Home shell:
 *   - top: the Home / DM entry (a message-bubble glyph),
 *   - a divider,
 *   - the scrollable server avatars (unread dots, selection pill),
 *   - a trailing "+" that opens the existing create/join-server flow.
 *
 * Selection lives in {@link useHomeShellStore}; tapping an entry only flips that
 * one value, so the PANEL swaps and exactly the two affected rail items
 * re-render (memoized items + this container). The rail never subscribes to
 * presence/typing, so those ticks never touch it (§27).
 *
 * Long-pressing a server opens the same {@link ServerActionsSheet} as the panel
 * header (the rail's long-press gesture) — the only place membership actions live.
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

  return (
    <View
      style={{
        width: RAIL_WIDTH,
        backgroundColor: colors.app,
        borderRightWidth: 1,
        borderRightColor: colors.stroke,
        paddingTop: space.sm,
      }}
    >
      <ServerRailItem
        active={selectedServerId === null}
        onPress={() => selectServer(null)}
        accessibilityLabel={t("mobile:home.railHomeA11y")}
      >
        {/* The Demli mark, not a generic bubble glyph — the rail's Home entry is
            the app's anchor tile (desktop GroupRail home = the same logo).
            Selection is carried by the pill + ring, so the mark stays full-color. */}
        <BrandMark size="sm" />
      </ServerRailItem>

      <RailDivider />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          alignItems: "center",
          gap: space.xs,
          paddingBottom: insets.bottom + TAB_BAR_CONTENT_HEIGHT + space.md,
        }}
      >
        {servers.map((server) => {
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
            >
              <Avatar name={server.name} size={48} uri={server.iconUrl} />
            </ServerRailItem>
          );
        })}

        {/* Create / join a server — reuses the existing new-group flow. */}
        <View style={{ width: RAIL_WIDTH, height: 60, alignItems: "center", justifyContent: "center" }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("mobile:home.railAddServerA11y")}
            onPress={() => router.push("/new-group")}
            hitSlop={4}
            style={({ pressed }) => ({
              width: 48,
              height: 48,
              borderRadius: radius.pill,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: colors.surface,
              borderWidth: 1,
              borderColor: colors.stroke,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Plus size={24} color={colors.accent} />
          </Pressable>
        </View>
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
