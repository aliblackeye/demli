/**
 * Floating IN-STAGE control bar — the "controls over the video"
 * layer (founder request: "kameraların gösterildiği kısma hover edince kamera,
 * ekran paylaşımı, mikrofon açma kapama ve bağlantıyı kesme olsun ... en sağında
 * tam ekran butonu olsun eğer yayın falan açıksa").
 *
 * It is an ADDITIONAL path to controls that already exist, never a replacement:
 * the bottom-left {@link CallDock} / {@link VoicePanel} / {@link UserFooter} keep
 * working untouched ("sol altı da kullanabilir"). Every button here drives the
 * SAME voice store — and therefore the same `@demli/media` FSM — as those
 * surfaces, so there is exactly one source of truth for mic/camera/share state
 * (CLAUDE.md §11); this component owns no media logic of its own.
 *
 * REVEAL BEHAVIOUR — three input models, one bar:
 *  - MOUSE: hidden by default, revealed on pointer activity over the stage and
 *    faded again after a short idle (`useAutoHideOverlay`, the same hook the
 *    share-tile chrome uses). The stage is a video surface; permanent chrome on
 *    top of it is exactly what the founder objected to elsewhere.
 *  - TOUCH: there IS no hover, and the web build is opened from phones. On a
 *    coarse pointer the bar is PERMANENTLY visible (`pointer-coarse:` — the
 *    repo's established no-hover fallback), so it can never become unreachable.
 *  - KEYBOARD: the buttons stay in the tab order even while faded (opacity, not
 *    `display:none`), and `focus-within` pins the bar visible, so tabbing to a
 *    control shows what you have selected.
 *
 * The bar sits over a clickable stage (a tile click focuses/unfocuses it, and a
 * double-click toggles fullscreen), so every pointer event is stopped here — the
 * §E convention from ScreenShareTile. Without that, reaching for "mute" would
 * also re-focus the stage under it.
 */

import type { MouseEvent, PointerEvent, ReactNode } from "react";
import {
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  Monitor,
  MonitorOff,
  PhoneOff,
  Video,
  VideoOff,
} from "lucide-react";
import { cn } from "@demli/ui";
import { useAppTranslation } from "../lib/i18n";
import { CallControl } from "./CallControls";

export interface StageControlBarProps {
  /** Whether the auto-hide layer currently wants the bar shown (mouse path). */
  visible: boolean;
  micEnabled: boolean;
  onToggleMic: () => void;
  cameraEnabled: boolean;
  onToggleCamera: () => void;
  /** False while the engine is not connected — camera cannot publish yet. */
  canUseCamera: boolean;
  screenShareEnabled: boolean;
  onToggleScreenShare: () => void;
  /** False when connecting, or on a platform without screen capture (web). */
  canShareScreen: boolean;
  /** Hint shown on the disabled screen-share button (why it is unavailable). */
  screenShareDisabledHint: string;
  /** Label for the red button — "Hang up" in a DM call, "Disconnect" in a room. */
  disconnectLabel: string;
  onDisconnect: () => void;
  /**
   * Whether a fullscreen toggle is offered AT ALL. Gated by the caller on there
   * being real video to enlarge: a fullscreen button over an avatar grid does
   * nothing a user can perceive, and a control that appears to do nothing is
   * worse than an absent one (§35).
   */
  canFullscreen: boolean;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  /** Called on any pointer/focus activity so the caller can restart its idle timer. */
  onInteract: () => void;
}

export function StageControlBar({
  visible,
  micEnabled,
  onToggleMic,
  cameraEnabled,
  onToggleCamera,
  canUseCamera,
  screenShareEnabled,
  onToggleScreenShare,
  canShareScreen,
  screenShareDisabledHint,
  disconnectLabel,
  onDisconnect,
  canFullscreen,
  fullscreen,
  onToggleFullscreen,
  onInteract,
}: StageControlBarProps): JSX.Element {
  const { t } = useAppTranslation();

  // The stage beneath reacts to click / double-click (focus + fullscreen), so no
  // pointer event that lands on the bar may bubble into it.
  const swallow = (event: MouseEvent | PointerEvent): void => {
    event.stopPropagation();
  };

  const divider: ReactNode = <span aria-hidden className="mx-1 h-5 w-px rounded-full bg-stroke-strong" />;

  return (
    <div
      role="toolbar"
      aria-label={t("desktop:stage.controlsLabel")}
      onPointerDown={(event) => {
        swallow(event);
        onInteract();
      }}
      onPointerMove={onInteract}
      onClick={swallow}
      onDoubleClick={swallow}
      onFocusCapture={onInteract}
      data-testid="stage-control-bar"
      data-visible={visible || undefined}
      className={cn(
        // Koyu Masa floating layer: strong glass, pill radius, no border, no
        // shadow. Reveal/hide is opacity + a 6px rise on the fast step, so the
        // bar arrives with the pointer instead of popping.
        "absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1",
        "rounded-pill surface-glass-strong p-1.5",
        "transition-[opacity,translate] motion-fast",
        visible ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-1.5 opacity-0",
        // Keyboard: tabbing into a faded bar must show it (and make it clickable).
        "focus-within:pointer-events-auto focus-within:translate-y-0 focus-within:opacity-100",
        // Touch: no hover exists, so never hide it on a coarse pointer.
        "pointer-coarse:pointer-events-auto pointer-coarse:translate-y-0 pointer-coarse:opacity-100",
      )}
    >
      <CallControl
        label={cameraEnabled ? t("desktop:voice.stopCamera") : t("desktop:voice.camera")}
        icon={cameraEnabled ? Video : VideoOff}
        tone={cameraEnabled ? "on" : "neutral"}
        pressed={cameraEnabled}
        size="round"
        surface="glass"
        disabled={!canUseCamera && !cameraEnabled}
        disabledHint={t("desktop:call.connecting")}
        onClick={onToggleCamera}
      />
      <CallControl
        label={
          screenShareEnabled ? t("desktop:voice.stopSharing") : t("desktop:voice.shareScreen")
        }
        icon={screenShareEnabled ? MonitorOff : Monitor}
        tone={screenShareEnabled ? "on" : "neutral"}
        pressed={screenShareEnabled}
        size="round"
        surface="glass"
        disabled={!canShareScreen && !screenShareEnabled}
        disabledHint={screenShareDisabledHint}
        onClick={onToggleScreenShare}
      />
      <CallControl
        label={micEnabled ? t("desktop:voice.mute") : t("desktop:voice.unmute")}
        icon={micEnabled ? Mic : MicOff}
        tone={micEnabled ? "neutral" : "off"}
        pressed={!micEnabled}
        size="round"
        surface="glass"
        onClick={onToggleMic}
      />
      {/* Leave reads as danger by SHAPE as well as colour: the only wide pill on
          the bar, solid pink with dark ink, set off by a gap. */}
      <CallControl
        label={disconnectLabel}
        icon={PhoneOff}
        tone="leave"
        size="round"
        surface="glass"
        wide
        className="ml-1"
        onClick={onDisconnect}
        data-testid="stage-leave"
      />
      {canFullscreen && (
        <>
          {divider}
          <CallControl
            label={
              fullscreen
                ? t("desktop:stage.fullscreenExit")
                : t("desktop:stage.fullscreenEnter")
            }
            icon={fullscreen ? Minimize2 : Maximize2}
            tone={fullscreen ? "on" : "neutral"}
            pressed={fullscreen}
            size="round"
            surface="glass"
            onClick={onToggleFullscreen}
          />
        </>
      )}
    </div>
  );
}
