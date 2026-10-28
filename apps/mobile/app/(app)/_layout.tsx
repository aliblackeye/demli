import { View } from "react-native";
import { Redirect, Stack } from "expo-router";
import { LayoutAnimationConfig } from "react-native-reanimated";
import { useAppTranslation } from "@/lib/i18n";
import { AccountSwitchingOverlay } from "@/components/AccountSwitchingOverlay";
import { InAppNotificationBanner } from "@/components/InAppNotificationBanner";
import { PipController } from "@/components/voice/PipController";
import { VoiceMiniBar } from "@/components/voice/VoiceMiniBar";
import { CallMiniBar } from "@/components/call/CallMiniBar";
import { IncomingCallOverlay } from "@/components/call/IncomingCallOverlay";
import { GameInviteToast } from "@/components/game/GameInviteToast";
import { GameOverlay } from "@/components/game/GameOverlay";
import { useAccountsStore } from "@/stores/accounts-store";
import { useAuthStore } from "@/stores/auth-store";
import { noteUserActivity } from "@/realtime/connection";
import { colors, fontFamily } from "@/theme/theme";

/** Initial route when the authed group mounts (avoids a bare-group warning). */
export const unstable_settings = { initialRouteName: "(tabs)" };

/**
 * Authed area. Guards every child: if the session drops (logout / expiry) we
 * bounce back to sign-in. Hosts its own native stack so screens get real
 * back-navigation and titles.
 */
export default function AppLayout() {
  const { t } = useAppTranslation();
  const status = useAuthStore((s) => s.status);
  // While an account switch is in flight we UNMOUNT the whole navigation Stack
  // (and the global bars) and show only the covering overlay. This is the P0
  // fix (fix/switch-black-2): the switch's ordered bringup runs queryCache.clear()
  // + per-store resets, which re-render every mounted screen. If a live
  // `removeClippedSubviews` list (Home/You) is still mounted while that reset
  // races the navigation that follows the switch, React Native Fabric throws an
  // unrecoverable "addView: view already has a parent" SoftException and tears the
  // whole surface down — a permanent black screen the founder could only escape by
  // force-killing the app. With nothing mounted during the reset, there is no view
  // to reparent, so the crash cannot happen; the Stack remounts fresh afterwards
  // (at Home — see switch-account.tsx's onSwitched).
  const switching = useAccountsStore((s) => s.switching);
  if (status !== "authenticated") return <Redirect href="/sign-in" />;

  return (
    // Capture-phase responder that OBSERVES every touch (always returns false so
    // it never becomes the responder / consumes the gesture) to feed the auto-idle
    // inactivity timer — a tap anywhere keeps us "online" (M15).
    <View
      style={{ flex: 1 }}
      onStartShouldSetResponderCapture={() => {
        noteUserActivity();
        return false;
      }}
    >
      {switching ? null : (
      // skipExiting: when the switch unmounts this whole tree, no Reanimated
      // `exiting` animation inside it (a toast, a banner, a badge) may keep its
      // view alive past the removal — that late-removed view is exactly the
      // reparenting the "view already has a parent" P0 above comes from. It only
      // applies to THIS wrapper unmounting; ordinary exits inside still animate.
      // One host child (collapsable off) so the flag lands on a real native tag.
      <LayoutAnimationConfig skipExiting>
      <View style={{ flex: 1 }} collapsable={false}>
      <Stack
        screenOptions={{
          // Borderless (Koyu Masa): the header sits on the page's own tone, no
          // hairline — the title and the content read as one surface.
          headerStyle: { backgroundColor: colors.app },
          // The display face (Onest) on every native title. The root Stack already sets
          // this, but nested navigators do NOT inherit screenOptions — a
          // color-only style here silently reset ~every authed header to
          // Roboto, which is most of why mobile read as "a different app".
          // RN ignores `fontWeight` for custom faces (see ui/Text.tsx), so the
          // weight is baked into the family name.
          headerTitleStyle: { color: colors.fg, fontFamily: fontFamily.display.semibold },
          headerTintColor: colors.accent,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.app },
          // Default every authed screen to portrait. The voice room opts into
          // "all" (landscape for fullscreen stream/camera viewing); without this
          // default, react-native-screens leaves the activity at the system
          // default when the voice screen pops, so portrait wouldn't re-assert on
          // the screens behind it until an app restart. This re-asserts it.
          orientation: "portrait",
        }}
      >
      {/* Bottom-tab shell (Home / Friends / You). The Home tab is the server-rail
          + panel surface; Friends and You own their headers. The Stack renders no
          header for the tabs; every other screen below still pushes over it. */}
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="group/[groupId]" options={{ title: t("mobile:group.channelsTitle") }} />
      <Stack.Screen name="channel/[channelId]" options={{ title: "" }} />
      <Stack.Screen
        name="channel-search"
        options={{ presentation: "modal", title: t("mobile:search.title") }}
      />
      {/* Command palette (M20/W5) — the mobile CommandMenu. Opened from the
          search icon in the Home shell's panel headers. It owns its own header
          (the search field itself), and fades rather than slides so it reads as
          an overlay on what you were looking at. A pushed card, not a modal, so
          picking a result can `router.replace` straight into the target without
          dragging a modal presentation along. */}
      <Stack.Screen
        name="command-palette"
        options={{ headerShown: false, animation: "fade", animationDuration: 140 }}
      />
      <Stack.Screen name="group-chat/[groupChatId]" options={{ title: t("mobile:groupChatDetails.fallbackTitle") }} />
      <Stack.Screen name="recent-calls" options={{ title: t("mobile:recentCalls.title") }} />
      <Stack.Screen name="dm/[dmId]" options={{ title: t("mobile:dm.fallbackTitle") }} />
      <Stack.Screen
        name="user/[userId]"
        options={{ presentation: "modal", title: t("mobile:userProfile.title") }}
      />
      <Stack.Screen name="voice/[channelId]" options={{ title: t("mobile:voice.title") }} />
      {/* DM call surface (ADR 0012): outgoing ring / active call / ended. Owns its
          own orientation (portrait, landscape only for a fullscreen share), so no
          native header. */}
      <Stack.Screen name="call" options={{ headerShown: false }} />
      <Stack.Screen name="settings" options={{ title: t("mobile:nav.settings") }} />
      {/* M18 people/moderation parity: the blocked-users list (Settings), the
          custom-status editor (You tab) and one server's audit log (Server
          settings). Pushed screens, not modals — each is reached from a settings
          list and "back" should return to that list. */}
      <Stack.Screen name="blocked-users" options={{ title: t("mobile:block.settingsTitle") }} />
      <Stack.Screen name="custom-status" options={{ title: t("mobile:customStatus.title") }} />
      <Stack.Screen name="moderation-log" options={{ title: t("mobile:moderationLog.title") }} />
      {/* Multi-account (M15 / ADR 0013): the switcher, the add-account login
          (modal, current session kept live), and the active-sessions screen. */}
      <Stack.Screen name="switch-account" options={{ title: t("mobile:accounts.switchTitle") }} />
      <Stack.Screen
        name="add-account"
        options={{ presentation: "modal", title: t("mobile:accounts.addTitle") }}
      />
      <Stack.Screen name="active-sessions" options={{ title: t("mobile:accounts.sessions.title") }} />
      <Stack.Screen name="new-group" options={{ presentation: "modal", title: t("mobile:nav.newServer") }} />
      <Stack.Screen name="new-group-chat" options={{ title: t("mobile:nav.newGroup") }} />
      <Stack.Screen
        name="group-chat-details"
        options={{ presentation: "modal", title: t("mobile:groupChatDetails.fallbackTitle") }}
      />
      <Stack.Screen
        name="server-settings"
        options={{ presentation: "modal", title: t("mobile:serverSettings.title") }}
      />
      <Stack.Screen
        name="channel-settings"
        options={{ presentation: "modal", title: t("mobile:channelSettings.title") }}
      />
      <Stack.Screen name="new-channel" options={{ presentation: "modal", title: t("mobile:newChannel.title") }} />
      <Stack.Screen
        name="category-editor"
        options={{ presentation: "modal", title: t("mobile:category.createTitle") }}
      />
      <Stack.Screen
        name="group-chat-invite"
        options={{ presentation: "modal", title: t("mobile:groupChatInvite.menuItem") }}
      />
      <Stack.Screen name="role-settings" options={{ presentation: "modal", title: t("mobile:roleEditor.title") }} />
      <Stack.Screen name="member-roles" options={{ presentation: "modal", title: t("mobile:memberRoles.title") }} />
      <Stack.Screen name="profile" options={{ presentation: "modal", title: t("mobile:profile.title") }} />
      <Stack.Screen name="invite" options={{ presentation: "modal", title: t("mobile:invite.titleGeneric") }} />
      <Stack.Screen name="join/[code]" options={{ title: t("mobile:join.title") }} />
      </Stack>
      {/* Global voice bar — floats over every authed screen while a session is
          live, and hides itself on the voice room screen (and DM-call rooms). */}
      <VoiceMiniBar />
      {/* Global "return to call" bar + ended-state auto-dismiss (ADR 0012). */}
      <CallMiniBar />
      {/* Foreground in-app banner (friend requests etc.) — floats over every
          authed screen; self-hides when there's nothing to show. */}
      <InAppNotificationBanner />
      {/* MSN Games — invite toast floats over the app; the overlay covers
          everything when a game is active. */}
      <GameInviteToast />
      <GameOverlay />
      {/* Global incoming-call ring — renders over EVERY authed screen the instant
          a call.invite lands. Last so it sits on top of every other overlay. */}
      <IncomingCallOverlay />
      {/* Android system PiP: floats the active speaker's camera when the app is
          backgrounded during a live video session. Renders null except in PiP. */}
      <PipController />
      </View>
      </LayoutAnimationConfig>
      )}
      {/* Covering overlay during an account switch (ADR 0013) — hides the app
          through the ordered teardown+bringup so no stale identity flashes. While
          it is up the Stack above is unmounted (see the `switching` guard). */}
      <AccountSwitchingOverlay />
    </View>
  );
}
