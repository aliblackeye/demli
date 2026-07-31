import { useState } from "react";
import { Pressable, View } from "react-native";
import { Text } from "../ui/Text";
import {
  HeadphoneOff,
  Headphones,
  Mic,
  MicOff,
  PhoneOff,
  Radio,
  ScreenShare,
  ScreenShareOff,
  Video,
  VideoOff,
} from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { haptics } from "@/lib/haptics";
import { useMediaSettings } from "@/stores/media-settings";
import { useVoiceStore } from "@/stores/voice-store";
import { colors, radius, space, typography } from "@/theme/theme";
import { CameraPreviewSheet } from "./CameraPreviewSheet";
import { ScreenShareQualitySheet } from "./ScreenShareQualitySheet";

/** A round control button (mic / deafen), red-tinted when the state is "off". */
function ControlButton({
  Icon,
  active,
  danger,
  onPress,
  disabled,
  label,
  haptic = "light",
}: {
  Icon: LucideIcon;
  /** True when the feature is ON (mic live / hearing on). Off state tints red. */
  active: boolean;
  danger?: boolean;
  onPress: () => void;
  disabled?: boolean;
  label: string;
  /** Haptic intensity fired on press (default light; medium for weightier taps). */
  haptic?: "light" | "medium";
}) {
  const off = !active || danger;
  return (
    <View style={{ alignItems: "center", gap: space.xs }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={() => {
          if (haptic === "medium") haptics.medium();
          else haptics.light();
          onPress();
        }}
        disabled={disabled}
        style={({ pressed }) => ({
          width: 56,
          height: 56,
          borderRadius: radius.pill,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: off ? colors.dangerSurface : colors.surfaceRaised,
          opacity: disabled ? 0.4 : pressed ? 0.8 : 1,
        })}
      >
        <Icon size={24} color={off ? colors.danger : colors.fg} />
      </Pressable>
      <Text style={{ color: colors.fgFaint, fontSize: typography.size["2xs"] }}>{label}</Text>
    </View>
  );
}

/**
 * Push-to-talk (Bas-Konuş) button: hold to transmit, release to mute. Drives the
 * engine directly via the voice store's setMicActive (press-in → mic on,
 * press-out → mic off). Green-tinted while held (talking).
 */
function PushToTalkButton({
  micEnabled,
  disabled,
}: {
  micEnabled: boolean;
  disabled: boolean;
}) {
  const { t } = useAppTranslation();
  const setMicActive = useVoiceStore((s) => s.setMicActive);
  return (
    <View style={{ alignItems: "center", gap: space.xs }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("mobile:voice.controlHoldToTalk")}
        disabled={disabled}
        onPressIn={() => {
          haptics.light();
          setMicActive(true);
        }}
        onPressOut={() => setMicActive(false)}
        style={({ pressed }) => ({
          width: 56,
          height: 56,
          borderRadius: radius.pill,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: micEnabled ? colors.accent : colors.surfaceRaised,
          opacity: disabled ? 0.4 : pressed ? 0.85 : 1,
        })}
      >
        <Radio size={24} color={micEnabled ? colors.onAccent : colors.fg} />
      </Pressable>
      <Text style={{ color: colors.fgFaint, fontSize: typography.size["2xs"] }}>
        {t("mobile:voice.controlHoldToTalk")}
      </Text>
    </View>
  );
}

/**
 * Bottom control bar for the voice room: mute mic, toggle camera, deafen, and
 * leave. All delegate straight to the voice store (which delegates to the engine
 * — mute/deafen/camera semantics are engine-owned). In push-to-talk mode the mute
 * button becomes a hold-to-talk button.
 *
 * Mic + deafen are enabled whenever a room exists (`canToggleAudio`: joining /
 * connected / reconnecting), NOT only when fully connected — the FSM accepts
 * SET_MIC/SET_DEAFENED in every status (they set a preference the engine applies
 * on connect), and you most need to mute precisely while connecting or during a
 * flaky reconnect (audit D2). Camera stays gated on `connected` because it
 * publishes a live track that genuinely needs an established connection (task
 * #18) — turning it on/off never touches the mic or a screen share.
 */
export function VoiceControls({
  micEnabled,
  deafened,
  cameraEnabled,
  screenShareEnabled,
  connected,
  canToggleAudio,
  onToggleMic,
  onToggleDeafen,
  onToggleCamera,
  onToggleScreenShare,
  onLeave,
}: {
  micEnabled: boolean;
  deafened: boolean;
  cameraEnabled: boolean;
  /** True while the phone is publishing its screen (task #45). Gates the share button icon. */
  screenShareEnabled: boolean;
  connected: boolean;
  /** True while a room exists (joining/connected/reconnecting) — gates mic + deafen. */
  canToggleAudio: boolean;
  onToggleMic: () => void;
  onToggleDeafen: () => void;
  onToggleCamera: () => void;
  onToggleScreenShare: () => void;
  onLeave: () => void;
}) {
  const { t } = useAppTranslation();
  const pushToTalk = useMediaSettings((s) => s.audio.inputMode) === "push_to_talk";
  const [cameraPreviewOpen, setCameraPreviewOpen] = useState(false);
  const [shareQualityOpen, setShareQualityOpen] = useState(false);

  // #101: turning the camera ON opens the preview sheet first
  // (front/back + self-view, then confirm to publish); turning it OFF is a direct
  // toggle. Shared here so BOTH surfaces that render VoiceControls — the server
  // voice room and the DM in-call view — get the preview flow automatically.
  const onCameraPress = (): void => {
    if (cameraEnabled) onToggleCamera();
    else setCameraPreviewOpen(true);
  };

  // Starting a share opens the quality sheet first (resolution + FPS, mobile parity
  // with the desktop SourcePicker, #112); it also carries the Android "Entire screen"
  // guidance (single-app projection isn't reliably captured). Stopping a share is a
  // direct toggle — no sheet. The sheet's "Start sharing" runs onToggleScreenShare,
  // which triggers the OS MediaProjection/broadcast consent.
  const handleShareScreen = () => {
    if (screenShareEnabled) {
      onToggleScreenShare();
      return;
    }
    setShareQualityOpen(true);
  };

  return (
    <>
    <View
      style={{
        flexDirection: "row",
        justifyContent: "space-evenly",
        alignItems: "flex-start",
        paddingHorizontal: space.md,
        paddingVertical: space.lg,
      }}
    >
      {pushToTalk ? (
        <PushToTalkButton micEnabled={micEnabled} disabled={!canToggleAudio} />
      ) : (
        <ControlButton
          Icon={micEnabled ? Mic : MicOff}
          active={micEnabled}
          disabled={!canToggleAudio}
          onPress={onToggleMic}
          label={micEnabled ? t("mobile:voice.controlMute") : t("mobile:voice.controlUnmute")}
        />
      )}
      <ControlButton
        Icon={cameraEnabled ? Video : VideoOff}
        active={cameraEnabled}
        disabled={!connected}
        onPress={onCameraPress}
        label={
          cameraEnabled
            ? t("mobile:voice.controlStopVideo")
            : t("mobile:voice.controlStartVideo")
        }
      />
      {/* Screen share (task #45): publish the phone's screen. Connected-only —
          MediaProjection needs a live room, and the engine guards it to `connected`.
          `active` when sharing keeps the button tinted like the other "on" states. */}
      <ControlButton
        // Screen share: IDLE is the neutral default (plain
        // ScreenShare icon, normal/non-red button = inviting "Share screen"),
        // SHARING is the engaged state (ScreenShareOff/stop icon + RED = "Stop
        // sharing"). ControlButton reds the `off` (=`!active`) state, so we pass
        // `active={!screenShareEnabled}` — idle→active→normal, sharing→off→red.
        // (founder: "ekran paylaşmamışken kırmızı gösteriyor" — the red came from
        // `active`, not the icon; the earlier icon-only fix left the red.)
        Icon={screenShareEnabled ? ScreenShareOff : ScreenShare}
        active={!screenShareEnabled}
        disabled={!connected}
        onPress={handleShareScreen}
        label={
          screenShareEnabled
            ? t("mobile:voice.controlStopShareScreen")
            : t("mobile:voice.controlShareScreen")
        }
      />
      <ControlButton
        // Crossed-out headphone when deafened (mirrors the muted-mic MicOff),
        // normal headphones otherwise.
        Icon={deafened ? HeadphoneOff : Headphones}
        active={!deafened}
        disabled={!canToggleAudio}
        onPress={onToggleDeafen}
        haptic="medium"
        label={deafened ? t("mobile:voice.controlUndeafen") : t("mobile:voice.controlDeafen")}
      />
      <ControlButton
        Icon={PhoneOff}
        active={false}
        danger
        onPress={onLeave}
        haptic="medium"
        label={t("mobile:voice.controlLeave")}
      />
    </View>
    <CameraPreviewSheet
      visible={cameraPreviewOpen}
      onClose={() => setCameraPreviewOpen(false)}
      onConfirm={onToggleCamera}
    />
    <ScreenShareQualitySheet
      visible={shareQualityOpen}
      onClose={() => setShareQualityOpen(false)}
      onConfirm={onToggleScreenShare}
    />
    </>
  );
}
