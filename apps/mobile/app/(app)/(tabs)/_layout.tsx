import { Tabs } from "expo-router";
import { CircleUser, Home, Users } from "lucide-react-native";
import { unreadBadgeText } from "@demli/client-core";
import { useAppTranslation } from "@/lib/i18n";
import { DemliTabBar, type TabBarItem } from "@/components/home/TabBar";
import { useHomeUnreadTotal } from "@/components/home/useHomeUnreadTotal";
import { useFriendRequests } from "@/queries/social-queries";
import { colors, fontFamily } from "@/theme/theme";

/** Land on the unified Home surface, not whichever tab was registered first. */
export const unstable_settings = { initialRouteName: "groups" };

/**
 * Bottom tab bar (founder directive): Ana Sayfa (the unified
 * server-rail + panel surface) / Arkadaşlar / Sen. The old separate "Servers"
 * tab is gone — the rail inside Home replaces it. No "Notifications" tab: we
 * have no notification centre, and a dead tab is forbidden (§35).
 *
 * The bar itself is {@link DemliTabBar} — the floating Koyu Masa pill. It sits
 * OVER the screens (content scrolls under it), so each tab screen reserves the
 * bottom chrome — tab pill plus, during a call, the voice bar stacked above it —
 * through useTabScreenBottomClearance (lib/use-bottom-chrome).
 *
 * Home owns no native header (its rail spans the full height, so the header
 * lives inside the panel); Friends and You keep the header this navigator
 * provides, on the page tone with no hairline (borderless). Every detail screen
 * (a channel, a DM, the voice room, settings) still pushes OVER these tabs
 * full-screen — navigation is unchanged.
 */
export default function TabsLayout() {
  const { t } = useAppTranslation();
  // Home tab badge (#110): the aggregate unread across servers + DMs + group
  // chats. A mention paints it coral; plain unread is the white counter.
  const homeUnread = useHomeUnreadTotal();
  const homeBadge = unreadBadgeText(homeUnread.count, homeUnread.hasUnread);
  // Friends tab: pending incoming requests — the same count the Requests segment
  // shows, so the tab never promises something the screen does not have.
  const incoming = useFriendRequests("incoming");
  const incomingCount = incoming.data?.length ?? 0;

  const items: Record<string, TabBarItem> = {
    groups: {
      label: t("mobile:home.tabHome"),
      icon: Home,
      badge: homeBadge
        ? { text: homeBadge, mention: homeUnread.mention, a11y: t("mobile:group.unreadA11y") }
        : null,
    },
    friends: {
      label: t("mobile:home.tabFriends"),
      icon: Users,
      badge:
        incomingCount > 0
          ? {
              text: incomingCount > 99 ? "99+" : String(incomingCount),
              mention: true,
              a11y: t("mobile:friends.requestsBadgeA11y", { count: incomingCount }),
            }
          : null,
    },
    you: { label: t("mobile:home.tabYou"), icon: CircleUser, badge: null },
  };

  return (
    <Tabs
      tabBar={(props) => <DemliTabBar {...props} items={items} />}
      screenOptions={{
        headerStyle: { backgroundColor: colors.app },
        // Display face on the Friends/You native headers — nested navigators
        // don't inherit the root Stack's headerTitleStyle, and a color-only
        // override here dropped these titles back to the system font.
        headerTitleStyle: { color: colors.fgDisplay, fontFamily: fontFamily.display.semibold, fontSize: 20 },
        headerTitleAlign: "left",
        headerTintColor: colors.accent,
        headerShadowVisible: false,
        sceneStyle: { backgroundColor: colors.app },
      }}
    >
      <Tabs.Screen name="groups" options={{ headerShown: false }} />
      <Tabs.Screen name="friends" options={{ title: t("mobile:friends.title") }} />
      <Tabs.Screen name="you" options={{ title: t("mobile:you.title") }} />
    </Tabs>
  );
}
