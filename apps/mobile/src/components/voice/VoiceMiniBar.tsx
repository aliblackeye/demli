import { View } from "react-native";
import Animated from "react-native-reanimated";
import { router, usePathname } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Mic, MicOff, PhoneOff, Video, Volume2 } from "lucide-react-native";
import { useAppTranslation, type AppTFunction } from "@/lib/i18n";
import type { VoiceState } from "@demli/media";
import {
  VOICE_MINI_BAR_HEIGHT,
  isLiveStatus,
  isVoiceMiniBarShown,
  isVoiceRoomRoute,
  voiceMiniBarBottom,
} from "@/lib/bottom-chrome";
import { isTabRoute } from "@/lib/tab-bar";
import { useVoiceStore } from "@/stores/voice-store";
import { colors, radius, space } from "@/theme/theme";
import { IconButton } from "../ui/IconButton";
import { Text } from "../ui/Text";
import { Touchable } from "../ui/Touchable";
import { FLOATING_BAR_ENTER, FLOATING_BAR_EXIT } from "./floating-bar-motion";
import { LiveDot, voiceStatusColor } from "./stage-chrome";
import { localizeVoiceError } from "./voice-error";
import { VoiceConnectionBars } from "./VoiceConnectionBars";

/**
 * The bar's geometry and visibility predicates live in the pure, unit-tested
 * lib/bottom-chrome so every surface that must clear the bar (chat composers,
 * tab-screen lists, the new-DM button, the update pill) reads the same numbers
 * this component positions itself with. Re-exported for existing importers.
 */
export { VOICE_MINI_BAR_HEIGHT, isLiveStatus, isVoiceRoomRoute };

/** Short status line for the compact bar (localized). */
function statusText(status: VoiceState["status"], t: AppTFunction): string {
  switch (status) {
    case "joining":
      return t("mobile:voice.statusConnecting");
    case "connected":
      return t("mobile:voice.statusConnected");
    case "reconnecting":
      return t("mobile:voice.statusReconnecting");
    case "error":
      return t("mobile:voice.statusError");
    default:
      return "";
  }
}

/**
 * Global mini voice bar. Mounted once in the authed `_layout` so it floats over
 * EVERY screen while a session is live (B2's companion to app-scoped voice): it
 * keeps the call visible while you browse other channels/screens.
 *
 *  - Hidden when idle/leaving, and hidden on the voice room screen itself (which
 *    already has the full controls — no redundant bar).
 *  - Tapping the label area returns to the voice room screen with the original
 *    route params (name/group) carried in the store's `channelMeta`.
 *  - Mic toggle + Leave are inline; both are ≥44pt touch targets.
 *
 * Koyu Masa: a floating glass bar (glass-strong, borderless, no outer shadow —
 * it separates from the page by tone), rising in on the position spring and
 * leaving on the fast step. The status dot breathes while the session is still
 * moving (joining / reconnecting). Mic muted = the pink wash, Leave = the solid
 * pink disc, the same grammar as the room's own dock.
 */
export function VoiceMiniBar() {
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();

  const status = useVoiceStore((s) => s.status);
  const roomId = useVoiceStore((s) => s.roomId);
  const micEnabled = useVoiceStore((s) => s.micEnabled);
  const cameraEnabled = useVoiceStore((s) => s.cameraEnabled);
  const error = useVoiceStore((s) => s.error);
  const channelMeta = useVoiceStore((s) => s.channelMeta);
  const toggleMic = useVoiceStore((s) => s.toggleMic);
  const leave = useVoiceStore((s) => s.leave);

  // One predicate, shared with every surface that clears the bar: hidden with no
  // live session, for a DM call (it has its own UI — the /call screen +
  // CallMiniBar, ADR 0012), and on the voice room screen (its own controls).
  if (!roomId || !isVoiceMiniBarShown(roomId, status, pathname)) return null;

  // A speaker GLYPH in front of the name, never an emoji baked into the string
  // (emoji render in the system font and read off-brand — brand-system §4.6).
  const title = channelMeta?.name ?? t("mobile:voice.channelFallback");
  const errorMessage = localizeVoiceError(error, t);
  const subtitle =
    status === "error" && errorMessage ? errorMessage : statusText(status, t);
  const moving = status === "joining" || status === "reconnecting";

  const openRoom = () => {
    router.push({
      pathname: "/voice/[channelId]",
      params: {
        channelId: roomId,
        ...(channelMeta?.groupId ? { groupId: channelMeta.groupId } : {}),
        ...(channelMeta?.name ? { name: channelMeta.name } : {}),
      },
    });
  };

  // On the three tab screens the bar must clear the bottom tab bar instead of
  // covering it; every other screen (chat/voice/detail) has no tab bar.
  const bottom = voiceMiniBarBottom(insets.bottom, isTabRoute(pathname));

  return (
    <Animated.View
      entering={FLOATING_BAR_ENTER.fromBottom}
      exiting={FLOATING_BAR_EXIT.toBottom}
      // Float above the bottom safe area, over whatever screen is showing.
      style={{
        position: "absolute",
        left: space.sm,
        right: space.sm,
        bottom,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: space.sm,
          paddingLeft: space.xs,
          paddingRight: space.sm,
          paddingVertical: space.sm,
          borderRadius: radius.xl,
          borderCurve: "continuous",
          backgroundColor: colors.glassStrong,
        }}
      >
        {/* Label area — tap to return to the voice room screen. */}
        <Touchable
          accessibilityRole="button"
          accessibilityLabel={t("mobile:voice.a11yOpenChannel", {
            name: channelMeta?.name ?? t("mobile:voice.channelFallback"),
          })}
          onPress={openRoom}
          pressedTone={colors.wash}
          style={{
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            gap: space.sm,
            minHeight: 44,
            paddingHorizontal: space.sm,
            borderRadius: radius.lg,
            borderCurve: "continuous",
          }}
        >
          <LiveDot color={voiceStatusColor(status)} pulsing={moving} />
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
              <Volume2 size={14} color={colors.fgMuted} strokeWidth={2} />
              <Text
                numberOfLines={1}
                style={{ flexShrink: 1, color: colors.fg, fontSize: 14, fontWeight: "600" }}
              >
                {title}
              </Text>
            </View>
            <Text
              numberOfLines={1}
              style={{
                color: status === "error" ? colors.danger : colors.fgMuted,
                fontSize: 12,
              }}
            >
              {subtitle}
            </Text>
          </View>
        </Touchable>

        {/* Camera-on status indicator (task #18) — status only, not a control;
            the full camera toggle lives on the voice room screen. */}
        {cameraEnabled ? (
          <View accessibilityRole="image" accessibilityLabel={t("mobile:voice.a11yCameraOn")}>
            <Video size={16} color={colors.accent} strokeWidth={2} />
          </View>
        ) : null}

        {/* Ping / connection-quality bars — self-hides unless connected. */}
        <VoiceConnectionBars />

        <IconButton
          icon={micEnabled ? Mic : MicOff}
          variant={micEnabled ? "secondary" : "danger"}
          size="md"
          haptic="light"
          onPress={toggleMic}
          label={micEnabled ? t("mobile:voice.a11yMuteMic") : t("mobile:voice.a11yUnmuteMic")}
        />
        <IconButton
          icon={PhoneOff}
          variant="dangerSolid"
          size="md"
          haptic="medium"
          onPress={leave}
          label={t("mobile:voice.a11yLeaveChannel")}
        />
      </View>
    </Animated.View>
  );
}
