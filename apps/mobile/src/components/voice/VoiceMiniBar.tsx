import { Pressable, View } from "react-native";
import { Text } from "../ui/Text";
import { router, usePathname } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Mic, MicOff, PhoneOff, Video } from "lucide-react-native";
import { useAppTranslation, type AppTFunction } from "@/lib/i18n";
import type { VoiceState } from "@demli/media";
import { isDmCallRoom } from "@/lib/call-room";
import { TAB_BAR_CONTENT_HEIGHT, isTabRoute } from "@/lib/tab-bar";
import { useVoiceStore } from "@/stores/voice-store";
import { colors, elevation, radius, space } from "@/theme/theme";
import { localizeVoiceError } from "./voice-error";
import { VoiceConnectionBars } from "./VoiceConnectionBars";

/**
 * Approximate rendered height of the floating bar (paddingVertical 8×2 + the
 * 44pt control row + 1px borders, rounded up). A chat screen reserves this much
 * bottom space so the bar never covers the composer (it floats `absolute` over
 * every screen). Kept generous so a slightly taller bar still clears the input.
 */
export const VOICE_MINI_BAR_HEIGHT = 64;

/**
 * True on the voice room route, where the bar is deliberately NOT shown — that
 * screen carries the full controls itself.
 *
 * Exported because a second surface has to agree: a chat screen reserves
 * {@link VOICE_MINI_BAR_HEIGHT} at its bottom so the floating bar cannot cover
 * the composer, and since M20 the voice room's own CHAT view is such a screen.
 * Reserving there would leave a 64px hole above the composer for a bar that is
 * not on screen, so both read this one predicate.
 */
export function isVoiceRoomRoute(pathname: string): boolean {
  return pathname.startsWith("/voice/");
}

/** Statuses in which a session is live and the bar should be shown. */
export function isLiveStatus(status: VoiceState["status"]): boolean {
  return (
    status === "joining" ||
    status === "connected" ||
    status === "reconnecting" ||
    status === "error"
  );
}

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

  // Not in a session → nothing to show.
  if (!roomId || !isLiveStatus(status)) return null;
  // A DM call runs on this same engine but has its own UI (the /call screen +
  // CallMiniBar), so the generic voice bar must not double up for it (ADR 0012).
  if (isDmCallRoom(roomId)) return null;
  // Already on the voice room screen → its own controls cover this.
  if (isVoiceRoomRoute(pathname)) return null;

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
  const tabBarClearance = isTabRoute(pathname) ? TAB_BAR_CONTENT_HEIGHT : 0;

  return (
    <View
      // Float above the bottom safe area, over whatever screen is showing.
      style={{
        position: "absolute",
        left: space.sm,
        right: space.sm,
        bottom: insets.bottom + space.sm + tabBarClearance,
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
