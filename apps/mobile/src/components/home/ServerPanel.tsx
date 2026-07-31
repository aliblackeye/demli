import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { Text } from "../ui/Text";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronDown, MoreVertical, Search, UserPlus } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { TAB_BAR_CONTENT_HEIGHT } from "@/lib/tab-bar";
import { useGroups } from "@/queries/chat-queries";
import { useHomeShellStore } from "@/stores/home-shell-store";
import { colors, space } from "@/theme/theme";
import { ServerActionsSheet } from "./ServerActionsSheet";
import { ServerChannelList } from "./ServerChannelList";

/**
 * The server PANEL of the Home shell: an in-panel header (server name + invite /
 * overflow menu) over the shared {@link ServerChannelList}. Shown when a server
 * is selected in the rail.
 *
 * The header model: the name itself is the menu handle (tap or long-press
 * → {@link ServerActionsSheet}), a "…" button offers the same menu explicitly,
 * and only the high-frequency invite action keeps a dedicated icon. Server
 * settings and the destructive "leave" both live inside that menu, so nothing
 * one-tap-destructive sits on the panel. Leaving deselects back to Home/DMs.
 */
export function ServerPanel({ groupId }: { groupId: string }) {
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();
  const selectServer = useHomeShellStore((s) => s.selectServer);
  const [actionsOpen, setActionsOpen] = useState(false);

  const groups = useGroups();
  const serverName = useMemo(
    () => groups.data?.find((g) => g.id === groupId)?.name ?? t("mobile:group.channelsTitle"),
    [groups.data, groupId, t],
  );

  const openActions = () => setActionsOpen(true);

  return (
    <View style={{ flex: 1 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: space.md,
          paddingHorizontal: space.md,
          paddingTop: space.sm,
          paddingBottom: space.sm,
          borderBottomWidth: 1,
          borderBottomColor: colors.stroke,
        }}
      >
        <Pressable
          onPress={openActions}
          onLongPress={openActions}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t("mobile:group.serverActionsA11y", { name: serverName })}
          style={({ pressed }) => ({
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            gap: space.xs,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <Text variant="display"
            numberOfLines={1}
            style={{ flexShrink: 1, color: colors.fg, fontSize: 18, fontWeight: "800" }}
          >
            {serverName}
          </Text>
          <ChevronDown size={18} color={colors.fgMuted} />
        </Pressable>

        {/* Command palette (M20/W5) — same entry point as the Home panel header,
            so the palette is one tap away on either surface. Opened here it also
            offers this server's channels and its server-scoped actions. */}
        <Pressable
          onPress={() => router.push("/command-palette")}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={t("mobile:commandMenu.openA11y")}
        >
          <Search size={22} color={colors.fgMuted} />
        </Pressable>
        <Pressable
          onPress={() => router.push({ pathname: "/invite", params: { groupId, name: serverName } })}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={t("mobile:group.inviteFriends")}
        >
          <UserPlus size={22} color={colors.accent} />
        </Pressable>
        <Pressable
          onPress={openActions}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={t("mobile:group.serverActionsA11y", { name: serverName })}
        >
          <MoreVertical size={22} color={colors.fgMuted} />
        </Pressable>
      </View>

      <ServerChannelList
        groupId={groupId}
        contentBottomPadding={insets.bottom + TAB_BAR_CONTENT_HEIGHT + space.xl}
      />

      <ServerActionsSheet
        visible={actionsOpen}
        groupId={groupId}
        serverName={serverName}
        onClose={() => setActionsOpen(false)}
        onLeft={() => selectServer(null)}
      />
    </View>
  );
}
