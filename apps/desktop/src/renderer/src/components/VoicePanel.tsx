import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  AlertTriangle,
  Headphones,
  HeadphoneOff,
  Loader2,
  Mic,
  MicOff,
  Monitor,
  MonitorOff,
  MonitorPlay,
  PhoneOff,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
} from "lucide-react";
import { Button, Tooltip, TooltipContent, TooltipTrigger, cn } from "@demli/ui";
import type { VoiceStatus } from "@demli/media";
import { useGroupDetails } from "../queries/chat-queries";
import { localizeVoiceError } from "../lib/errors";
import { useAppTranslation } from "../lib/i18n";
import { useVoiceStore } from "../stores/voice-store";
import { useChatStore } from "../stores/chat-store";
import { useUiStore } from "../stores/ui-store";
import { useHasStageVideo } from "../hooks/useHasStageVideo";
import { isScreenCaptureAvailable, isWebPlatform } from "../lib/screen-share";
import { AloneCountdownNotice } from "./AloneCountdownNotice";
import { VoiceConnectionBars } from "./VoiceConnectionBars";
import { SourcePicker } from "./SourcePicker";
import { CameraPreviewDialog } from "./CameraPreviewDialog";

const STATUS_KEY = {
  joining: "desktop:voice.statusJoining",
  connected: "desktop:voice.statusConnected",
  reconnecting: "desktop:voice.statusReconnecting",
  error: "desktop:voice.statusError",
  leaving: "desktop:voice.statusLeaving",
} as const satisfies Record<Exclude<VoiceStatus, "idle">, string>;

const STATUS_CLASS: Record<Exclude<VoiceStatus, "idle">, string> = {
  joining: "text-idle",
  // Demli Voice v2 (.dc.html): a live voice connection reads in the brand ACCENT,
  // not green — it matches the "Ses bağlandı" card in the founder's design.
  connected: "text-accent",
  reconnecting: "text-idle",
  error: "text-danger",
  leaving: "text-fg-faint",
};

function ControlButton({
  label,
  active,
  activeDanger = false,
  disabled = false,
  disabledHint,
  onClick,
  icon: Icon,
}: {
  label: string;
  active?: boolean;
  activeDanger?: boolean;
  disabled?: boolean;
  disabledHint?: string;
  onClick?: () => void;
  icon: LucideIcon;
}): JSX.Element {
  const button = (
    <Button
      variant="secondary"
      size="icon-sm"
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "w-full",
        // Accent highlight for a non-danger "on" control (camera / screen share),
        // matching the call control bar (task #4). Danger wins when both apply.
        active && !activeDanger && "bg-accent/20 text-accent hover:bg-accent/30",
        activeDanger && "bg-danger/15 text-danger hover:bg-danger/25",
      )}
    >
      <Icon className="size-4" />
    </Button>
  );
  return (
    <Tooltip>
      {/* span keeps tooltips working on disabled buttons */}
      <TooltipTrigger asChild>
        {disabled ? <span className="w-full">{button}</span> : button}
      </TooltipTrigger>
      <TooltipContent side="top">{disabledHint ?? label}</TooltipContent>
    </Tooltip>
  );
}

/** Voice status card at the bottom of the channel sidebar — driven by the real LiveKit engine. */
export function VoicePanel(): JSX.Element | null {
  const { t } = useAppTranslation();
  const status = useVoiceStore((s) => s.status);
  const roomId = useVoiceStore((s) => s.roomId);
  const micEnabled = useVoiceStore((s) => s.micEnabled);
  const deafened = useVoiceStore((s) => s.deafened);
  const screenShareEnabled = useVoiceStore((s) => s.screenShareEnabled);
  const screenShareAudioStatus = useVoiceStore((s) => s.screenShareAudioStatus);
  const screenShareSystemAudioFailed = useVoiceStore((s) => s.screenShareSystemAudioFailed);
  const screenShareAudioSource = useVoiceStore((s) => s.screenShareAudioSource);
  const cameraEnabled = useVoiceStore((s) => s.cameraEnabled);
  const voiceError = useVoiceStore((s) => s.error);
  const leave = useVoiceStore((s) => s.leave);
  const toggleMic = useVoiceStore((s) => s.toggleMic);
  const toggleDeafen = useVoiceStore((s) => s.toggleDeafen);
  const toggleCamera = useVoiceStore((s) => s.toggleCamera);
  const startScreenShare = useVoiceStore((s) => s.startScreenShare);
  const stopScreenShare = useVoiceStore((s) => s.stopScreenShare);
  const stageFocused = useUiStore((s) => s.stageFocused);
  const showVoiceStage = useUiStore((s) => s.showVoiceStage);
  const hasStageVideo = useHasStageVideo();
  const roomLabel = useVoiceStore((s) => s.roomLabel);
  const activeGroupId = useChatStore((s) => s.activeGroupId);
  const { data: details } = useGroupDetails(activeGroupId);
  // Prefer the label captured at join (correct from any surface, task #2); fall
  // back to a channel-list lookup for the active group, a call-appropriate label
  // for DM-call rooms, then the generic "Voice" placeholder.
  const roomName =
    roomLabel?.channelName ??
    details?.channels.find((c) => c.id === roomId)?.name ??
    (roomId?.startsWith("dmcall:") ? t("desktop:call.regionLabel") : undefined) ??
    t("desktop:voice.fallbackRoom");

  const [pickerOpen, setPickerOpen] = useState(false);
  const [cameraPreviewOpen, setCameraPreviewOpen] = useState(false);
  const canShareScreen = status === "connected" && isScreenCaptureAvailable();
  const canUseCamera = status === "connected";

  const onScreenShareClick = (): void => {
    if (screenShareEnabled) stopScreenShare();
    else setPickerOpen(true);
  };

  // #101: turning the camera ON opens the preview first (pick the
  // device, see yourself, then confirm to publish); turning it OFF is a direct
  // toggle. The button is connected-gated exactly as before.
  const onCameraClick = (): void => {
    if (cameraEnabled) toggleCamera();
    else setCameraPreviewOpen(true);
  };

  if (status === "idle") return null;

  return (
    <section
      aria-label={t("desktop:voice.panelLabel")}
      className={cn(
        // Frosted "voice connected" glass card (Demli Voice v2): translucent warm
        // surface, cream hairline, an inset top highlight and a soft lift, so the
        // panel reads as a raised control surface at the foot of the sidebar.
        "mx-2 mb-1.5 rounded-xl border border-stroke bg-surface/80 p-2.5 backdrop-blur",
        "shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_10px_24px_-12px_rgba(0,0,0,0.5)]",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {/* Demli Voice v2: an accent activity glyph next to the connection state,
              like the "Ses bağlandı" card in the founder's .dc.html. */}
          <Activity className={cn("size-4 shrink-0", STATUS_CLASS[status])} />
          <div className="min-w-0">
            <p className={cn("text-xs font-semibold", STATUS_CLASS[status])}>
              {t(STATUS_KEY[status])}
            </p>
            <p className="truncate text-2xs text-fg-muted">{roomName}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* Ping / connection-quality bars — self-hides unless connected. */}
          <VoiceConnectionBars />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("desktop:voice.disconnect")}
                onClick={leave}
                className="hover:bg-danger/15 hover:text-danger"
              >
                <PhoneOff className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{t("desktop:voice.disconnect")}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Compact "return to view" affordance: while a text channel occupies the
          center, this brings the voice-room video stage back. Shown only when the
          stage actually has video AND we're currently off it (§7). */}
      {hasStageVideo && !stageFocused && (
        <button
          type="button"
          onClick={showVoiceStage}
          className={cn(
            "mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1 text-2xs font-medium",
            "bg-accent/15 text-accent transition-colors motion-instant hover:bg-accent/25",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
          )}
        >
          <MonitorPlay className="size-3.5 shrink-0" />
          {t("desktop:voice.returnToStage")}
        </button>
      )}

      {voiceError && (
        <p
          role="alert"
          className="mt-1.5 rounded-md border border-danger/30 bg-danger/10 px-2 py-1.5 text-2xs leading-snug text-danger"
        >
          {localizeVoiceError(voiceError, t)}
        </p>
      )}

      {/* "Odada tek kişi sensin" uyarısı — sunucunun yalnız-kalma süpürmesinin
          istemci karşılığı. Yalnız DM araması ve grup-DM sesli kanalında görünür;
          sunucu sesli kanalında motor sayacı hiç kurmadığı için hiç çıkmaz. */}
      <AloneCountdownNotice className="mt-1.5" />

      {/* NB: the voice roster is NOT repeated here. The occupants already list in
          the channel sidebar under the connected voice channel (VoiceOccupantRow),
          so a second copy in this panel was pure duplication (founder #1). The
          panel stays compact: status + ping + controls only. */}

      {screenShareEnabled && (
        <div className="mt-1.5 rounded-md border border-online/25 bg-online/10 px-2 py-1.5">
          {/* HONEST film-audio state (§35). "Sesli paylaşıyorsun" is claimed ONLY
              after the supervisor measured real signal on the published track —
              a published-but-silent track reads "ses bekleniyor", never success.
              The old panel claimed success as soon as a track object existed,
              which is how a permanently-silent loopback looked like a healthy
              share for three releases. */}
          <p
            className={`flex items-center gap-1.5 text-2xs ${
              screenShareAudioStatus === "live" ? "text-online" : "text-fg-muted"
            }`}
          >
            {screenShareAudioStatus === "live" ? (
              <Volume2 className="size-3.5 shrink-0" />
            ) : screenShareAudioStatus === "searching" ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin" />
            ) : (
              <VolumeX className="size-3.5 shrink-0" />
            )}
            {screenShareAudioStatus === "live"
              ? t("desktop:voice.sharingWithAudio")
              : screenShareAudioStatus === "searching"
                ? t("desktop:voice.sharingAudioWaiting")
                : t("desktop:voice.sharingNoAudio")}
          </p>
          {/* System-audio capture FAILED (the user wanted film sound but the loopback
              track never came) — a prominent, actionable warning so the sharer knows
              viewers hear nothing, instead of a silent fall-back to video-only (§35). */}
          {screenShareEnabled && screenShareAudioSource && (
            <p className="mt-1 text-badge text-fg-faint">
              {screenShareAudioSource === "process"
                ? t("desktop:voice.filmSourceProcess")
                : screenShareAudioSource === "loopback"
                  ? t("desktop:voice.filmSourceLoopback")
                  : t("desktop:voice.filmSourceMix", {
                      device: screenShareAudioSource.replace(/^mixinput:/, ""),
                    })}
            </p>
          )}
          {screenShareSystemAudioFailed && (
            <div
              role="alert"
              className="mt-1.5 rounded-md border border-idle/40 bg-idle/10 px-2 py-1.5"
            >
              <p className="flex items-start gap-1.5 text-2xs font-semibold text-idle">
                <AlertTriangle className="mt-px size-3.5 shrink-0" />
                {t("desktop:voice.systemAudioFailedTitle")}
              </p>
              <p className="mt-1 text-2xs leading-snug text-fg-muted">
                {/* Web'de kurtarma yolu bambaşka: WASAPI/Stereo Mix tavsiyesi değil,
                    tarayıcı diyaloğundaki "sesi de paylaş" kutusu (yalnız Chromium). */}
                {isWebPlatform()
                  ? t("desktop:voice.systemAudioFailedHintWeb")
                  : t("desktop:voice.systemAudioFailedHint")}
              </p>
            </div>
          )}
          {/* NB: no "show my broadcast" toggle — your own share now auto-appears as
              a grid tile on the stage (founder #2), clickable to focus like a
              camera. Nothing to opt into. */}
        </div>
      )}

      {/* 4 kontrol kaldı (ses-ayar butonu founder isteğiyle gitti) — satırı doldur. */}
      <div className="mt-2 grid grid-cols-4 gap-1">
        <ControlButton
          label={micEnabled ? t("desktop:voice.mute") : t("desktop:voice.unmute")}
          active={!micEnabled}
          activeDanger={!micEnabled}
          onClick={toggleMic}
          icon={micEnabled ? Mic : MicOff}
        />
        <ControlButton
          label={deafened ? t("desktop:voice.undeafen") : t("desktop:voice.deafen")}
          active={deafened}
          activeDanger={deafened}
          onClick={toggleDeafen}
          icon={deafened ? HeadphoneOff : Headphones}
        />
        <ControlButton
          label={cameraEnabled ? t("desktop:voice.stopCamera") : t("desktop:voice.camera")}
          active={cameraEnabled}
          disabled={!canUseCamera && !cameraEnabled}
          disabledHint={t("desktop:voice.connectFirst")}
          onClick={onCameraClick}
          icon={cameraEnabled ? Video : VideoOff}
        />
        <ControlButton
          label={
            screenShareEnabled ? t("desktop:voice.stopSharing") : t("desktop:voice.shareScreen")
          }
          active={screenShareEnabled}
          disabled={!canShareScreen && !screenShareEnabled}
          disabledHint={
            status === "connected"
              ? t("desktop:voice.shareNeedsDesktop")
              : t("desktop:voice.connectFirst")
          }
          onClick={onScreenShareClick}
          icon={screenShareEnabled ? MonitorOff : Monitor}
        />
      </div>

      <SourcePicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onSelect={startScreenShare}
      />
      <CameraPreviewDialog open={cameraPreviewOpen} onOpenChange={setCameraPreviewOpen} />
    </section>
  );
}
