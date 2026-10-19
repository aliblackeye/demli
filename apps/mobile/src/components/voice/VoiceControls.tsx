import { useState, type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
import { PRESS } from "@/theme/motion-presets";
import { colors, radius, space, typography } from "@/theme/theme";
import { IconButton, type IconButtonVariant } from "../ui/IconButton";
import { Text } from "../ui/Text";
import { Touchable } from "../ui/Touchable";
import { CameraPreviewSheet } from "./CameraPreviewSheet";
import { ScreenShareQualitySheet } from "./ScreenShareQualitySheet";

/**
 * One round call control with its caption underneath — the unit of the bottom
 * dock. The caption says what a tap DOES ("Sustur", "Kamerayı aç"), which is also
 * the button's accessible name, so sight and TalkBack read the same verb.
 *
 * Danger semantics (design system §1.4, "tehlike rengi kararı"): a STATE that
 * cuts you off (mic muted, deafened) is the pink WASH with pink ink; the one
 * ACTION that ends your presence (leave / hang up) is the SOLID pink disc with
 * dark ink. A media feature that is ON (camera, screen share) is the coral wash.
 * Everything at rest is the raised neutral disc. Pink never means "on", coral
 * never means "danger" — so a glance at the dock answers "can they hear me?".
 */
export function CallControl({
  icon,
  label,
  variant = "secondary",
  active = false,
  toggle = false,
  disabled = false,
  haptic = "light",
  onPress,
}: {
  icon: LucideIcon;
  label: string;
  variant?: IconButtonVariant;
  active?: boolean;
  /** Announce as an on/off toggle (camera, share) instead of a plain button. */
  toggle?: boolean;
  disabled?: boolean;
  haptic?: "light" | "medium";
  onPress: () => void;
}) {
  return (
    <View style={{ alignItems: "center", gap: space.xs, width: 68 }}>
      <IconButton
        icon={icon}
        label={label}
        variant={variant}
        size="lg"
        active={active}
        toggle={toggle}
        disabled={disabled}
        haptic={haptic}
        onPress={onPress}
      />
      <ControlCaption label={label} disabled={disabled} />
    </View>
  );
}

function ControlCaption({ label, disabled }: { label: string; disabled?: boolean }) {
  return (
    <Text
      numberOfLines={2}
      importantForAccessibility="no"
      accessibilityElementsHidden
      style={{
        color: colors.fgMuted,
        fontSize: typography.size["2xs"],
        lineHeight: 14,
        fontWeight: "500",
        textAlign: "center",
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {label}
    </Text>
  );
}

/**
 * Push-to-talk (Bas-Konuş): hold to transmit, release to mute. Drives the engine
 * directly via the voice store's setMicActive (press-in → mic on, press-out → mic
 * off). While held the disc turns solid coral — "you are on air" is the one state
 * on the dock that is allowed to be loud.
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
  const label = t("mobile:voice.controlHoldToTalk");
  return (
    <View style={{ alignItems: "center", gap: space.xs, width: 68 }}>
      <Touchable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected: micEnabled }}
        disabled={disabled}
        onPressIn={() => {
          haptics.light();
          setMicActive(true);
        }}
        onPressOut={() => setMicActive(false)}
        tone={micEnabled ? colors.accent : colors.surfaceRaised}
        pressedTone={colors.accentDeep}
        pressScale={PRESS.scale.icon}
        style={{
          width: 48,
          height: 48,
          borderRadius: radius.pill,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Radio size={22} color={micEnabled ? colors.onAccent : colors.fg} strokeWidth={2} />
      </Touchable>
      <ControlCaption label={label} disabled={disabled} />
    </View>
  );
}

/**
 * The surface the bottom controls sit on: the room's "desk edge" — a base-tone
 * panel with the card radius on top and no border, the one place on a call screen
 * where the chrome is allowed to be solid. Both the voice room and the DM call
 * mount it, so the dock is the same object on both surfaces.
 */
export function ControlDock({
  children,
  hidden = false,
  style,
}: {
  children: ReactNode;
  /** Collapsed out of layout (an expanded watch party / fullscreen share). */
  hidden?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        {
          display: hidden ? "none" : "flex",
          backgroundColor: colors.surface,
          borderTopLeftRadius: radius.card,
          borderTopRightRadius: radius.card,
          borderCurve: "continuous",
          paddingBottom: insets.bottom + space.xs,
        },
        style,
      ]}
    >
      {children}
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
  leaveLabel,
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
  /**
   * What the red disc says. A room's "Ayrıl" by default; a DM call passes its own
   * verb (cancel while ringing, leave the call once live — ADR 0023 §2).
   */
  leaveLabel?: string;
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
        accessibilityRole="toolbar"
        style={{
          flexDirection: "row",
          justifyContent: "space-evenly",
          alignItems: "flex-start",
          paddingHorizontal: space.sm,
          paddingTop: space.lg,
          paddingBottom: space.md,
        }}
      >
        {pushToTalk ? (
          <PushToTalkButton micEnabled={micEnabled} disabled={!canToggleAudio} />
        ) : (
          <CallControl
            icon={micEnabled ? Mic : MicOff}
            // Muted is a state that cuts you off → the pink wash.
            variant={micEnabled ? "secondary" : "danger"}
            disabled={!canToggleAudio}
            onPress={onToggleMic}
            label={micEnabled ? t("mobile:voice.controlMute") : t("mobile:voice.controlUnmute")}
          />
        )}
        <CallControl
          icon={cameraEnabled ? Video : VideoOff}
          // Camera publishing = a feature that is ON → the coral wash. Off is the
          // neutral default, never red: a camera that is off is not a problem.
          active={cameraEnabled}
          toggle
          disabled={!connected}
          onPress={onCameraPress}
          label={
            cameraEnabled
              ? t("mobile:voice.controlStopVideo")
              : t("mobile:voice.controlStartVideo")
          }
        />
        {/* Screen share (task #45): publish the phone's screen. Connected-only —
            MediaProjection needs a live room, and the engine guards it to
            `connected`. Idle = the neutral "Share screen" disc; sharing = the coral
            "on" wash with the stop glyph (founder: "ekran paylaşmamışken kırmızı
            gösteriyor" — the idle state must never read as an error). */}
        <CallControl
          icon={screenShareEnabled ? ScreenShareOff : ScreenShare}
          active={screenShareEnabled}
          toggle
          disabled={!connected}
          onPress={handleShareScreen}
          label={
            screenShareEnabled
              ? t("mobile:voice.controlStopShareScreen")
              : t("mobile:voice.controlShareScreen")
          }
        />
        <CallControl
          // Crossed-out headphone when deafened (mirrors the muted-mic MicOff),
          // normal headphones otherwise; deafened is a cut-off state → pink wash.
          icon={deafened ? HeadphoneOff : Headphones}
          variant={deafened ? "danger" : "secondary"}
          disabled={!canToggleAudio}
          onPress={onToggleDeafen}
          haptic="medium"
          label={deafened ? t("mobile:voice.controlUndeafen") : t("mobile:voice.controlDeafen")}
        />
        <CallControl
          icon={PhoneOff}
          // The one action that ends your presence → the solid pink disc.
          variant="dangerSolid"
          onPress={onLeave}
          haptic="medium"
          label={leaveLabel ?? t("mobile:voice.controlLeave")}
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
