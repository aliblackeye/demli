import { Tabs } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CircleUser, Home, Users } from "lucide-react-native";
import { unreadBadgeText } from "@demli/client-core";
import { useAppTranslation } from "@/lib/i18n";
import { TAB_BAR_CONTENT_HEIGHT } from "@/lib/tab-bar";
import { useHomeUnreadTotal } from "@/components/home/useHomeUnreadTotal";
import { colors, fontFamily, space, typography } from "@/theme/theme";

/** Land on the unified Home surface, not whichever tab was registered first. */
export const unstable_settings = { initialRouteName: "groups" };

/**
 * Bottom tab bar (founder directive): Ana Sayfa (the unified
 * server-rail + panel surface) / Arkadaşlar / Sen. The old separate "Servers"
 * tab is gone — the rail inside Home replaces it. No "Notifications" tab: we
 * have no notification centre, and a dead tab is forbidden (§35).
 *
 * Home owns no native header (its rail spans the full height, so the header
 * lives inside the panel); Friends and You keep the stack-style header
 * this tab bar provides. Every detail screen (a channel, a DM, the voice room,
 * settings) still pushes OVER these tabs full-screen — navigation is unchanged.
 */
export default function TabsLayout() {
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();
  // Home tab badge (#110): the aggregate unread across servers + DMs + group
  // chats. A mention paints it accent; plain unread stays neutral. Undefined
  // (no badge) when everything is read.
  const homeUnread = useHomeUnreadTotal();
  const homeBadge = unreadBadgeText(homeUnread.count, homeUnread.hasUnread) ?? undefined;

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        // Display face on the Friends/You native headers — nested navigators
        // don't inherit the root Stack's headerTitleStyle, and a color-only
        // override here dropped these titles back to the system font.
        headerTitleStyle: { color: colors.fg, fontFamily: fontFamily.display.semibold },
        headerTintColor: colors.accent,
        headerShadowVisible: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.fgFaint,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.stroke,
          height: TAB_BAR_CONTENT_HEIGHT + insets.bottom,
          paddingBottom: insets.bottom,
          paddingTop: space.xs,
        },
        // Custom faces ignore fontWeight on Android — the weight is the family.
        tabBarLabelStyle: { fontSize: typography.size["2xs"], fontFamily: fontFamily.body.semibold },
      }}
    >
      <Tabs.Screen
        name="groups"
        options={{
          headerShown: false,
          tabBarLabel: t("mobile:home.tabHome"),
          tabBarIcon: ({ color, size }) => <Home size={size} color={color} />,
          tabBarBadge: homeBadge,
          tabBarBadgeStyle: {
            backgroundColor: homeUnread.mention ? colors.accent : colors.fg,
            // Light fill either way (accent orange / cream) — dark ink on top.
            color: homeUnread.mention ? colors.onAccent : colors.app,
            fontSize: typography.size["2xs"],
            fontWeight: "800",
          },
        }}
      />
      <Tabs.Screen
        name="friends"
        options={{
          title: t("mobile:friends.title"),
          tabBarLabel: t("mobile:home.tabFriends"),
          tabBarIcon: ({ color, size }) => <Users size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="you"
        options={{
          title: t("mobile:you.title"),
          tabBarLabel: t("mobile:home.tabYou"),
          tabBarIcon: ({ color, size }) => <CircleUser size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}
