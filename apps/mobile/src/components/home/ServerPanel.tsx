import { useMemo, useState } from "react";
import { View } from "react-native";
import { Text } from "../ui/Text";
import { router } from "expo-router";
import { ChevronDown, MoreHorizontal, Search, UserPlus } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { useTabScreenBottomClearance } from "@/lib/use-bottom-chrome";
import { useGroups } from "@/queries/chat-queries";
import { useHomeShellStore } from "@/stores/home-shell-store";
import { colors, radius, space } from "@/theme/theme";
import { IconButton } from "../ui/IconButton";
import { Touchable } from "../ui/Touchable";
import { ServerActionsSheet } from "./ServerActionsSheet";
import { ServerChannelList } from "./ServerChannelList";

/**
 * The server PANEL of the Home shell: an in-panel header (server name + invite /
 * overflow menu) over the shared {@link ServerChannelList}. Shown when a server
 * is selected in the rail.
 *
 * The header model: the name itself is the menu handle (tap or long-press
 * → {@link ServerActionsSheet}; its press is a tone change on the name pill), a
 * "…" button offers the same menu explicitly, and only the high-frequency invite
 * action keeps a dedicated icon (coral — the warm call to action). Server
 * settings and the destructive "leave" both live inside that menu, so nothing
 * one-tap-destructive sits on the panel. Leaving deselects back to Home/DMs.
 * Borderless: the header and the list share the panel's one tone.
 */
export function ServerPanel({ groupId }: { groupId: string }) {
  const { t } = useAppTranslation();
  // Tab pill + (during a call) the voice bar — the last row scrolls clear of both.
  const bottomClearance = useTabScreenBottomClearance();
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
          gap: space.xs,
          paddingLeft: space.sm,
          paddingRight: space.sm,
          paddingTop: space.md,
          paddingBottom: space.xs,
        }}
      >
        <Touchable
          onPress={openActions}
          onLongPress={openActions}
          accessibilityRole="button"
          accessibilityLabel={t("mobile:group.serverActionsA11y", { name: serverName })}
          pressedTone={colors.raisedPressed}
          style={{
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            gap: space.xs,
            minHeight: 44,
            paddingHorizontal: space.sm,
            borderRadius: radius.lg,
            borderCurve: "continuous",
          }}
        >
          <Text
            variant="display"
            numberOfLines={1}
            style={{ flexShrink: 1, color: colors.fgDisplay, fontSize: 20, lineHeight: 26, fontWeight: "600", letterSpacing: -0.2 }}
          >
            {serverName}
          </Text>
          <ChevronDown size={18} color={colors.fgFaint} />
        </Touchable>

        {/* Command palette (M20/W5) — same entry point as the Home panel header,
            so the palette is one tap away on either surface. Opened here it also
            offers this server's channels and its server-scoped actions. */}
        <IconButton
          icon={Search}
          label={t("mobile:commandMenu.openA11y")}
          onPress={() => router.push("/command-palette")}
        />
        <IconButton
          icon={UserPlus}
          variant="accent"
          size="sm"
          label={t("mobile:group.inviteFriends")}
          onPress={() => router.push({ pathname: "/invite", params: { groupId, name: serverName } })}
          style={{ marginHorizontal: space.xs }}
        />
        <IconButton
          icon={MoreHorizontal}
          label={t("mobile:group.serverActionsA11y", { name: serverName })}
          onPress={openActions}
        />
      </View>

      <ServerChannelList
        groupId={groupId}
        contentBottomPadding={bottomClearance + space.xl}
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
