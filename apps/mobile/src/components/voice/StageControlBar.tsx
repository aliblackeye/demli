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
 * LOOK: a raised glass pill over the picture (Koyu Masa `glass-strong`), the
 * buttons in the `veil` tone so they read on any frame. The same danger grammar
 * as the dock: muted = pink wash, hang up = the solid pink disc, a live camera /
 * share = the coral wash.
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

import { Animated, View } from "react-native";
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
import { colors, radius, space } from "@/theme/theme";
import { IconButton } from "../ui/IconButton";

export function StageControlBar({
  visible,
  opacity,
  onInteractionStart,
  onInteractionEnd,
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
  /**
   * A finger came down on the bar: keep it up with no idle timer, so a press or
   * a long-press tooltip is never faded out from under the finger.
   */
  onInteractionStart?: () => void;
  /** The finger lifted (or the gesture was cancelled): re-arm the idle fade. */
  onInteractionEnd?: () => void;
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
      // Observes touches on the buttons (they bubble), never claims them.
      onTouchStart={onInteractionStart}
      onTouchEnd={onInteractionEnd}
      onTouchCancel={onInteractionEnd}
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
      {/* The glass tone without the ui/Glass wrapper: Glass clips its children
          (overflow hidden, for the blur layer), and that would cut off the
          IconButtons' long-press tooltips. Android draws this same opaque
          glass-strong tone either way. */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: space.xs,
          padding: space.xs + 2,
          borderRadius: radius.pill,
          borderCurve: "continuous",
          backgroundColor: colors.glassStrong,
        }}
      >
        <IconButton
          icon={cameraEnabled ? Video : VideoOff}
          label={
            cameraEnabled
              ? t("mobile:voice.controlStopVideo")
              : t("mobile:voice.controlStartVideo")
          }
          variant="veil"
          active={cameraEnabled}
          toggle
          disabled={!canUseCamera && !cameraEnabled}
          haptic="light"
          onPress={onToggleCamera}
        />
        <IconButton
          icon={screenShareEnabled ? ScreenShareOff : ScreenShare}
          label={
            screenShareEnabled
              ? t("mobile:voice.controlStopShareScreen")
              : t("mobile:voice.controlShareScreen")
          }
          variant="veil"
          active={screenShareEnabled}
          toggle
          disabled={!canShareScreen && !screenShareEnabled}
          haptic="light"
          onPress={onToggleScreenShare}
        />
        <IconButton
          icon={micEnabled ? Mic : MicOff}
          label={micEnabled ? t("mobile:voice.controlMute") : t("mobile:voice.controlUnmute")}
          // Muted is the state worth noticing → the pink wash. Drawn by the
          // variant, so it is announced through `selected` (a screen reader
          // must hear "muted" too), not `active`, which would draw it solid.
          variant={micEnabled ? "veil" : "danger"}
          selected={!micEnabled}
          disabled={!canToggleAudio}
          haptic="light"
          onPress={onToggleMic}
        />
        <IconButton
          icon={PhoneOff}
          label={disconnectLabel}
          variant="dangerSolid"
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
                backgroundColor: colors.strokeStrong,
                marginHorizontal: space.xs,
              }}
            />
            <IconButton
              icon={fullscreen ? Shrink : Expand}
              label={
                fullscreen
                  ? t("mobile:call.stageFullscreenExit")
                  : t("mobile:call.stageFullscreenEnter")
              }
              variant="veil"
              active={fullscreen}
              haptic="light"
              onPress={onToggleFullscreen}
            />
          </>
        ) : null}
      </View>
    </Animated.View>
  );
}
