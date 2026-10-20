import { Pressable, View } from "react-native";
import { Text } from "../ui/Text";
import { router, usePathname } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Mic, MicOff, PhoneOff, Video } from "lucide-react-native";
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
import { colors, elevation, radius, space } from "@/theme/theme";
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

function statusDot(status: VoiceState["status"]): string {
  if (status === "connected") return colors.online;
  if (status === "error") return colors.danger;
  if (status === "reconnecting" || status === "joining") return colors.idle;
  return colors.fgFaint;
}

/** A ≥44pt round control (mic toggle / leave). Red-tinted for the "off" state. */
function BarButton({
  Icon,
  danger,
  onPress,
  label,
}: {
  Icon: typeof Mic;
  danger?: boolean;
  onPress: () => void;
  label: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        borderRadius: radius.pill,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: danger ? colors.dangerSurface : colors.surfaceRaised,
        opacity: pressed ? 0.75 : 1,
      })}
    >
      <Icon size={20} color={danger ? colors.danger : colors.fg} />
    </Pressable>
  );
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

  const title = channelMeta?.name ? `🔊 ${channelMeta.name}` : t("mobile:voice.channelFallback");
  const errorMessage = localizeVoiceError(error, t);
  const subtitle =
    status === "error" && errorMessage ? errorMessage : statusText(status, t);

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
    <View
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
          paddingLeft: space.md,
          paddingRight: space.sm,
          paddingVertical: space.sm,
          borderRadius: radius.md,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: colors.stroke,
          backgroundColor: colors.surface,
          // Subtle lift so it reads as an overlay, not part of the page.
          ...elevation.panel,
        }}
      >
        {/* Label area — tap to return to the voice room screen. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("mobile:voice.a11yOpenChannel", {
            name: channelMeta?.name ?? t("mobile:voice.channelFallback"),
          })}
          onPress={openRoom}
          style={{
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            gap: space.sm,
            minHeight: 44,
          }}
        >
          <View
            style={{
              width: 9,
              height: 9,
              borderRadius: radius.pill,
              backgroundColor: statusDot(status),
            }}
          />
          <View style={{ flex: 1 }}>
            <Text
              numberOfLines={1}
              style={{ color: colors.fg, fontSize: 14, fontWeight: "600" }}
            >
              {title}
            </Text>
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
        </Pressable>

        {/* Camera-on status indicator (task #18) — status only, not a control;
            the full camera toggle lives on the voice room screen. */}
        {cameraEnabled ? (
          <View accessibilityRole="image" accessibilityLabel={t("mobile:voice.a11yCameraOn")}>
            <Video size={16} color={colors.accent} />
          </View>
        ) : null}

        {/* Ping / connection-quality bars — self-hides unless connected. */}
        <VoiceConnectionBars />

        <BarButton
          Icon={micEnabled ? Mic : MicOff}
          danger={!micEnabled}
          onPress={toggleMic}
          label={micEnabled ? t("mobile:voice.a11yMuteMic") : t("mobile:voice.a11yUnmuteMic")}
        />
        <BarButton
          Icon={PhoneOff}
          danger
          onPress={leave}
          label={t("mobile:voice.a11yLeaveChannel")}
        />
      </View>
    </View>
  );
}
