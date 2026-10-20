import { useState } from "react";
import { AnimatePresence, m } from "framer-motion";
import {
  Headphones,
  HeadphoneOff,
  Mic,
  MicOff,
  Monitor,
  MonitorOff,
  MonitorPlay,
  PhoneOff,
  Video,
  VideoOff,
} from "lucide-react";
import { cn } from "@demli/ui";
import { transitions } from "@demli/app-ui";
import type { VoiceStatus } from "@demli/media";
import { useGroupDetails } from "../queries/chat-queries";
import { useAppTranslation } from "../lib/i18n";
import { useVoiceStore } from "../stores/voice-store";
import { useChatStore } from "../stores/chat-store";
import { useUiStore } from "../stores/ui-store";
import { useHasStageVideo } from "../hooks/useHasStageVideo";
import { isScreenCaptureAvailable } from "../lib/screen-share";
import { AloneCountdownNotice } from "./AloneCountdownNotice";
import { ShareAudioStatus, VoiceErrorNotice } from "./ShareAudioStatus";
import { VoiceConnectionBars } from "./VoiceConnectionBars";
import { SourcePicker } from "./SourcePicker";
import { CameraPreviewDialog } from "./CameraPreviewDialog";
import { CallControl, LiveDot, type LiveDotTone } from "./CallControls";

type ActiveStatus = Exclude<VoiceStatus, "idle">;

const STATUS_KEY = {
  joining: "desktop:voice.statusJoining",
  connected: "desktop:voice.statusConnected",
  reconnecting: "desktop:voice.statusReconnecting",
  error: "desktop:voice.statusError",
  leaving: "desktop:voice.statusLeaving",
} as const satisfies Record<ActiveStatus, string>;

/**
 * Status → text tone + dot. Connected reads in the brand coral (the room's warm
 * light); the two in-between states are amber and their dot breathes, so
 * "still working on it" is visible without reading the words.
 */
const STATUS_TONE: Record<ActiveStatus, { text: string; dot: LiveDotTone }> = {
  joining: { text: "text-warning", dot: "pending" },
  connected: { text: "text-accent", dot: "live" },
  reconnecting: { text: "text-warning", dot: "pending" },
  error: { text: "text-danger", dot: "error" },
  leaving: { text: "text-fg-faint", dot: "idle" },
};

/** Voice status card at the bottom of the channel sidebar — driven by the real LiveKit engine. */
export function VoicePanel(): JSX.Element | null {
  const { t } = useAppTranslation();
  const status = useVoiceStore((s) => s.status);
  const roomId = useVoiceStore((s) => s.roomId);
  const micEnabled = useVoiceStore((s) => s.micEnabled);
  const deafened = useVoiceStore((s) => s.deafened);
  const screenShareEnabled = useVoiceStore((s) => s.screenShareEnabled);
  const screenShareStarting = useVoiceStore((s) => s.screenShareStarting);
  const cameraEnabled = useVoiceStore((s) => s.cameraEnabled);
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
  const groupName = roomLabel?.groupName ?? null;

  const [pickerOpen, setPickerOpen] = useState(false);
  const [cameraPreviewOpen, setCameraPreviewOpen] = useState(false);
  const canShareScreen = status === "connected" && isScreenCaptureAvailable();
  const canUseCamera = status === "connected";

  const onScreenShareClick = (): void => {
    if (screenShareEnabled) stopScreenShare();
    else if (!screenShareStarting) setPickerOpen(true);
  };

  // #101: turning the camera ON opens the preview first (pick the
  // device, see yourself, then confirm to publish); turning it OFF is a direct
  // toggle. The button is connected-gated exactly as before.
  const onCameraClick = (): void => {
    if (cameraEnabled) toggleCamera();
    else setCameraPreviewOpen(true);
  };

  if (status === "idle") return null;

  const tone = STATUS_TONE[status];

  return (
    <section
      aria-label={t("desktop:voice.panelLabel")}
      data-testid="voice-panel"
      data-status={status}
      // Koyu Masa control card: one surface step above the sidebar, radius 16,
      // no border and no shadow — the tone difference is the edge.
      className="mx-2 mb-2 rounded-xl bg-surface p-2.5 animate-pop-in"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5 pl-0.5">
          <LiveDot tone={tone.dot} />
          <div className="min-w-0">
            {/* The status line crossfades as the FSM moves (joining → connected
                → reconnecting …): one word changing in place, never a jump. */}
            <AnimatePresence mode="wait" initial={false}>
              <m.p
                key={status}
                role="status"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: transitions.fast }}
                exit={{ opacity: 0, transition: transitions.instant }}
                className={cn("truncate text-label font-semibold", tone.text)}
              >
                {t(STATUS_KEY[status])}
              </m.p>
            </AnimatePresence>
            <p className="truncate text-2xs text-fg-faint" title={groupName ? `${roomName} · ${groupName}` : roomName}>
              {roomName}
              {groupName && <span className="text-fg-subtle"> · </span>}
              {groupName}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* Ping / connection-quality bars — self-hides unless connected. */}
          <VoiceConnectionBars />
          <CallControl
            label={t("desktop:voice.disconnect")}
            icon={PhoneOff}
            tone="leave"
            size="round-sm"
            onClick={leave}
            data-testid="voice-panel-leave"
          />
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
            "mt-2 flex h-8 w-full items-center justify-center gap-1.5 rounded-lg px-2 text-2xs font-semibold",
            "bg-accent-surface text-accent-hover transition-colors motion-hover hover:bg-accent/20 active:bg-accent/28",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
            "animate-fade-in",
          )}
        >
          <MonitorPlay className="size-3.5 shrink-0" aria-hidden />
          {t("desktop:voice.returnToStage")}
        </button>
      )}

      <VoiceErrorNotice className="mt-2" />

      {/* "Odada tek kişi sensin" uyarısı — sunucunun yalnız-kalma süpürmesinin
          istemci karşılığı. Yalnız DM araması ve grup-DM sesli kanalında görünür;
          sunucu sesli kanalında motor sayacı hiç kurmadığı için hiç çıkmaz. */}
      <AloneCountdownNotice className="mt-2" />

      {/* NB: the voice roster is NOT repeated here. The occupants already list in
          the channel sidebar under the connected voice channel (VoiceOccupantRow),
          so a second copy in this panel was pure duplication (founder #1). The
          panel stays compact: status + ping + controls only. */}

      {/* Share sound, the same component the DM call dock uses: measured state
          (waiting / live / failed), which capture feeds it, and why there is no
          sound when the sharer asked for some (§35). */}
      <ShareAudioStatus className="mt-2" />

      {/* Four controls fill the row (the voice-settings button left on founder
          request). Muted / deafened read as the pink "off" wash with the struck
          glyph; camera / share read as the coral "on" wash while live. */}
      <div className="mt-2.5 grid grid-cols-4 gap-1">
        <CallControl
          label={micEnabled ? t("desktop:voice.mute") : t("desktop:voice.unmute")}
          icon={micEnabled ? Mic : MicOff}
          tone={micEnabled ? "neutral" : "off"}
          pressed={!micEnabled}
          onClick={toggleMic}
        />
        <CallControl
          label={deafened ? t("desktop:voice.undeafen") : t("desktop:voice.deafen")}
          icon={deafened ? HeadphoneOff : Headphones}
          tone={deafened ? "off" : "neutral"}
          pressed={deafened}
          onClick={toggleDeafen}
        />
        <CallControl
          label={cameraEnabled ? t("desktop:voice.stopCamera") : t("desktop:voice.camera")}
          icon={cameraEnabled ? Video : VideoOff}
          tone={cameraEnabled ? "on" : "neutral"}
          pressed={cameraEnabled}
          disabled={!canUseCamera && !cameraEnabled}
          disabledHint={t("desktop:voice.connectFirst")}
          onClick={onCameraClick}
        />
        <CallControl
          label={
            screenShareEnabled
              ? t("desktop:voice.stopSharing")
              : screenShareStarting
                ? t("desktop:voice.shareStarting")
                : t("desktop:voice.shareScreen")
          }
          icon={screenShareEnabled ? MonitorOff : Monitor}
          tone={screenShareEnabled ? "on" : "neutral"}
          pressed={screenShareEnabled}
          // While a share is coming up the button is disabled: reopening the
          // picker then would start a second share over the first.
          disabled={(!canShareScreen || screenShareStarting) && !screenShareEnabled}
          disabledHint={
            screenShareStarting
              ? t("desktop:voice.shareStarting")
              : status === "connected"
                ? t("desktop:voice.shareNeedsDesktop")
                : t("desktop:voice.connectFirst")
          }
          onClick={onScreenShareClick}
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
