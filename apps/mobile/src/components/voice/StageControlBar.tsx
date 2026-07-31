/**
 * Floating IN-STAGE control bar — the mobile twin of the desktop
 * `StageControlBar` (founder: controls over the video area, with a fullscreen
 * button at the right "eğer yayın falan açıksa").
 *
 * IT SERVES BOTH SURFACES. This used to live under `components/call/` and was
 * mounted ONLY by the DM call screen, so a server voice room had no in-stage
 * controls at all — one of the asymmetries behind the founder's "sunucudaki sesli
 * ile özel arasında fark olmamalıydı" (plan §1.1). It now lives beside the rest
 * of the stage and is mounted once by the shared {@link VoiceStage}, so the room
 * and the call get the identical bar by construction rather than by remembering
 * to add it twice.
 *
 * It is an ADDITIONAL path to controls that already exist, never a replacement:
 * the bottom {@link VoiceControls} bar keeps working untouched. Every button
 * here drives the SAME voice store — and therefore the same `@demli/media`
 * FSM — as that bar, so there is exactly one source of truth for mic / camera /
 * share state (CLAUDE.md §11); this component owns no media logic of its own.
 *
 * REVEAL BEHAVIOUR — the one real difference from desktop. There is no hover on
 * a phone, so the desktop's "reveal on pointer activity" has no analogue: the
 * bar is TAP-TO-TOGGLE over the stage (`useAutoHideControls`, the hook the
 * fullscreen viewer and the share caption already use) and fades on idle. While
 * faded it is `pointerEvents="none"`, so a hidden bar can never swallow the tap
 * meant to bring it back.
 *
 * DELIBERATELY ABSENT: a self-monitor ("hear yourself") button. React Native has
 * no route for monitoring your own mic, the shared engine rejects the request
 * with `monitor_unavailable`, and a button that always errors is exactly the
 * dead control §35 forbids.
 */

import { Animated, Pressable, View } from "react-native";
import type { LucideIcon } from "lucide-react-native";
import {
  Expand,
  Mic,
  MicOff,
  PhoneOff,
  ScreenShare,
  ScreenShareOff,
  Shrink,
  Video,
  VideoOff,
} from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { haptics } from "@/lib/haptics";
import { colors, radius, space } from "@/theme/theme";

/** One round button on the bar. Dark, translucent — it sits over live video. */
function StageControl({
  Icon,
  label,
  active = false,
  danger = false,
  disabled = false,
  onPress,
  haptic = "light",
}: {
  Icon: LucideIcon;
  label: string;
  /** The feature is ON (camera publishing, screen sharing) → accent tint. */
  active?: boolean;
  /** The one red button (hang up / disconnect). */
  danger?: boolean;
  disabled?: boolean;
  onPress: () => void;
  haptic?: "light" | "medium";
}) {
  return (
    <Pressable
      onPress={() => {
        if (haptic === "medium") haptics.medium();
        else haptics.light();
        onPress();
      }}
      disabled={disabled}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected: danger ? undefined : active }}
      style={({ pressed }) => ({
        width: 42,
        height: 42,
        borderRadius: radius.pill,
        alignItems: "center",
        justifyContent: "center",
        borderWidth: 1,
        borderColor: "rgba(255,255,255,0.12)",
        backgroundColor: danger
          ? colors.danger
          : active
            ? colors.accentSurfaceStrong
            : "rgba(0,0,0,0.5)",
        opacity: disabled ? 0.4 : pressed ? 0.75 : 1,
      })}
    >
      <Icon
        size={20}
        color={danger ? colors.onAccent : active ? colors.accent : "#ffffff"}
      />
    </Pressable>
  );
}

export function StageControlBar({
  visible,
  opacity,
  micEnabled,
  onToggleMic,
  cameraEnabled,
  onToggleCamera,
  canUseCamera,
  screenShareEnabled,
  onToggleScreenShare,
  canShareScreen,
  canToggleAudio,
  disconnectLabel,
  onDisconnect,
  canFullscreen,
  fullscreen,
  onToggleFullscreen,
}: {
  /** Whether the auto-hide layer currently wants the bar shown. */
  visible: boolean;
  /** Animated opacity driven by the same layer (native driver). */
  opacity: Animated.Value;
  micEnabled: boolean;
  onToggleMic: () => void;
  cameraEnabled: boolean;
  onToggleCamera: () => void;
  /** False while the engine is not connected — a camera cannot publish yet. */
  canUseCamera: boolean;
  screenShareEnabled: boolean;
  onToggleScreenShare: () => void;
  /** False while connecting — MediaProjection needs a live room. */
  canShareScreen: boolean;
  /** True while a room exists (joining / connected / reconnecting) — gates mic. */
  canToggleAudio: boolean;
  /** "Hang up" in a DM call, "Leave" in a room. */
  disconnectLabel: string;
  onDisconnect: () => void;
  /**
   * Whether a fullscreen toggle is offered AT ALL. Gated by the caller on there
   * being video the bar can actually enlarge: a fullscreen button that does
   * nothing perceptible is worse than an absent one (§35).
   */
  canFullscreen: boolean;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const { t } = useAppTranslation();

  return (
    <Animated.View
      // Hidden = untappable, so a faded bar never eats the tap that reveals it.
      pointerEvents={visible ? "box-none" : "none"}
      accessibilityRole="toolbar"
      accessibilityLabel={t("mobile:call.stageControls")}
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: space.md,
        alignItems: "center",
        opacity,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: space.sm,
          paddingHorizontal: space.sm,
          paddingVertical: space.sm,
          borderRadius: radius.pill,
          borderWidth: 1,
          borderColor: "rgba(255,255,255,0.10)",
          backgroundColor: "rgba(0,0,0,0.62)",
        }}
      >
        <StageControl
          Icon={cameraEnabled ? Video : VideoOff}
          label={
            cameraEnabled
              ? t("mobile:voice.controlStopVideo")
              : t("mobile:voice.controlStartVideo")
          }
          active={cameraEnabled}
          disabled={!canUseCamera && !cameraEnabled}
          onPress={onToggleCamera}
        />
        <StageControl
          Icon={screenShareEnabled ? ScreenShareOff : ScreenShare}
          label={
            screenShareEnabled
              ? t("mobile:voice.controlStopShareScreen")
              : t("mobile:voice.controlShareScreen")
          }
          active={screenShareEnabled}
          disabled={!canShareScreen && !screenShareEnabled}
          onPress={onToggleScreenShare}
        />
        <StageControl
          Icon={micEnabled ? Mic : MicOff}
          label={micEnabled ? t("mobile:voice.controlMute") : t("mobile:voice.controlUnmute")}
          // "Active" here means MUTED — the tinted state is the one worth noticing.
          active={!micEnabled}
          disabled={!canToggleAudio}
          onPress={onToggleMic}
        />
        <StageControl
          Icon={PhoneOff}
          label={disconnectLabel}
          danger
          haptic="medium"
          onPress={onDisconnect}
        />
        {canFullscreen ? (
          <>
            <View
              accessibilityElementsHidden
              importantForAccessibility="no"
              style={{
                width: 1,
                height: 20,
                backgroundColor: "rgba(255,255,255,0.2)",
                marginHorizontal: 2,
              }}
            />
            <StageControl
              Icon={fullscreen ? Shrink : Expand}
              label={
                fullscreen
                  ? t("mobile:call.stageFullscreenExit")
                  : t("mobile:call.stageFullscreenEnter")
              }
              active={fullscreen}
              onPress={onToggleFullscreen}
            />
          </>
        ) : null}
      </View>
    </Animated.View>
  );
}
