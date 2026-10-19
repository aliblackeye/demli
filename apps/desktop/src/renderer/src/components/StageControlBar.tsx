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
import type { LucideIcon } from "lucide-react";
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
import { Button, Tooltip, TooltipContent, TooltipTrigger, cn } from "@demli/ui";
import { useAppTranslation } from "../lib/i18n";

function StageControl({
  label,
  icon: Icon,
  active = false,
  disabled = false,
  disabledHint,
  danger = false,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  active?: boolean;
  disabled?: boolean;
  disabledHint?: string;
  danger?: boolean;
  onClick: () => void;
}): JSX.Element {
  const button = (
    <Button
      variant="secondary"
      size="icon-sm"
      aria-label={label}
      aria-pressed={danger ? undefined : active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "size-9 rounded-full border border-white/10 bg-black/45 text-white",
        "hover:bg-black/65 hover:text-white",
        active && !danger && "bg-accent/25 text-accent hover:bg-accent/35",
        danger && "bg-danger/85 text-on-accent hover:bg-danger hover:text-on-accent",
      )}
    >
      <Icon className="size-4" />
    </Button>
  );
  return (
    <Tooltip>
      {/* span keeps the tooltip working on a disabled button (same as CallDock). */}
      <TooltipTrigger asChild>{disabled ? <span>{button}</span> : button}</TooltipTrigger>
      <TooltipContent side="top">{disabledHint ?? label}</TooltipContent>
    </Tooltip>
  );
}

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

  const divider: ReactNode = <span aria-hidden className="mx-0.5 h-5 w-px bg-white/20" />;

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
      className={cn(
        "absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1.5",
        "rounded-full border border-white/10 bg-black/55 p-1.5 backdrop-blur-md",
        "shadow-[0_10px_30px_-12px_rgba(0,0,0,0.8)] transition-opacity motion-fast",
        visible ? "opacity-100" : "pointer-events-none opacity-0",
        // Keyboard: tabbing into a faded bar must show it (and make it clickable).
        "focus-within:pointer-events-auto focus-within:opacity-100",
        // Touch: no hover exists, so never hide it on a coarse pointer.
        "pointer-coarse:pointer-events-auto pointer-coarse:opacity-100",
      )}
    >
      <StageControl
        label={cameraEnabled ? t("desktop:voice.stopCamera") : t("desktop:voice.camera")}
        icon={cameraEnabled ? Video : VideoOff}
        active={cameraEnabled}
        disabled={!canUseCamera && !cameraEnabled}
        disabledHint={t("desktop:call.connecting")}
        onClick={onToggleCamera}
      />
      <StageControl
        label={
          screenShareEnabled ? t("desktop:voice.stopSharing") : t("desktop:voice.shareScreen")
        }
        icon={screenShareEnabled ? MonitorOff : Monitor}
        active={screenShareEnabled}
        disabled={!canShareScreen && !screenShareEnabled}
        disabledHint={screenShareDisabledHint}
        onClick={onToggleScreenShare}
      />
      <StageControl
        label={micEnabled ? t("desktop:voice.mute") : t("desktop:voice.unmute")}
        icon={micEnabled ? Mic : MicOff}
        active={!micEnabled}
        onClick={onToggleMic}
      />
      <StageControl
        label={disconnectLabel}
        icon={PhoneOff}
        danger
        onClick={onDisconnect}
      />
      {canFullscreen && (
        <>
          {divider}
          <StageControl
            label={
              fullscreen
                ? t("desktop:stage.fullscreenExit")
                : t("desktop:stage.fullscreenEnter")
            }
            icon={fullscreen ? Minimize2 : Maximize2}
            active={fullscreen}
            onClick={onToggleFullscreen}
          />
        </>
      )}
    </div>
  );
}
