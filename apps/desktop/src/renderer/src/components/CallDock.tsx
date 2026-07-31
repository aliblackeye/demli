/**
 * Bottom-left DM-call control dock (task #104 — the "connected to a call"
 * box). Sits just above the {@link UserFooter} in the home sidebar, shown while the
 * call's own DM is on screen (paired with the {@link EmbeddedCallStage} at the top
 * of the conversation). It carries the call-SPECIFIC controls the removed
 * full-screen surface used to hold:
 *
 *  - live connection status (green "Voice/Video connected") + the peer's name;
 *  - camera (preview-before-publish via {@link CameraPreviewDialog}, #101),
 *    screen-share (via {@link SourcePicker}), add-person → seamless group upgrade;
 *  - hang up (or cancel while still ringing out).
 *
 * Mic / deafen / voice-settings are NOT duplicated here — they already live in the
 * always-present UserFooter user bar, which drives the same engine. This keeps the
 * dock compact, exactly like the server {@link VoicePanel} it mirrors.
 *
 * INSTANT ROOM (founder directive): the controls are live from the RINGING phase
 * onward, not only after the peer answers — the caller's `start()` already joined
 * the LiveKit room, so camera / screen share genuinely work while it rings (a DM
 * call behaves like a voice channel you walked into first). Each control is gated
 * on the ENGINE being connected rather than on the call phase, so nothing is ever a
 * dead button (§35): during the brief join it is disabled with a "Connecting…"
 * hint. "Add person" is the one exception — the server only upgrades an ACTIVE
 * call — so it stays disabled while ringing with its own hint.
 */

import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  LogOut,
  Monitor,
  MonitorOff,
  PhoneOff,
  Smartphone,
  UserPlus,
  Video,
  VideoOff,
} from "lucide-react";
import { Button, Tooltip, TooltipContent, TooltipTrigger, cn } from "@demli/ui";
import { useAppTranslation } from "../lib/i18n";
import { getCallController } from "../lib/call-controller";
import { useDms } from "../queries/social-queries";
import { isScreenCaptureAvailable } from "../lib/screen-share";
import { useVoiceStore } from "../stores/voice-store";
import { useDmCallSurface } from "../hooks/useDmCallSurface";
import { AloneCountdownNotice } from "./AloneCountdownNotice";
import { VoiceConnectionBars } from "./VoiceConnectionBars";
import { SourcePicker } from "./SourcePicker";
import { CameraPreviewDialog } from "./CameraPreviewDialog";
import { AddCallMemberDialog } from "./AddCallMemberDialog";

function DockControl({
  label,
  active = false,
  disabled = false,
  disabledHint,
  onClick,
  icon: Icon,
}: {
  label: string;
  active?: boolean;
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
      className={cn("w-full", active && "bg-accent/20 text-accent hover:bg-accent/30")}
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

export function CallDock(): JSX.Element | null {
  const { t } = useAppTranslation();
  const { state, onCallDm, callDmId, seatedHere } = useDmCallSurface();
  const { data: dms } = useDms();

  const status = useVoiceStore((s) => s.status);
  const cameraEnabled = useVoiceStore((s) => s.cameraEnabled);
  const screenShareEnabled = useVoiceStore((s) => s.screenShareEnabled);
  const toggleCamera = useVoiceStore((s) => s.toggleCamera);
  const startScreenShare = useVoiceStore((s) => s.startScreenShare);
  const stopScreenShare = useVoiceStore((s) => s.stopScreenShare);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [cameraPreviewOpen, setCameraPreviewOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  if (!onCallDm) return null;

  const ringing = state.phase === "outgoing";
  const connected = status === "connected";
  const peer =
    state.peer ?? (dms ?? []).find((d) => d.id === callDmId)?.participant ?? null;
  const peerName = peer?.displayName ?? t("desktop:call.calling");

  // Status line: ringing → "Ringing…"; connected → voice/video-connected (green);
  // otherwise the media is still coming up → "Connecting…".
  const statusText = ringing
    ? t("desktop:call.ringing")
    : connected
      ? cameraEnabled
        ? t("desktop:call.videoConnected")
        : t("desktop:call.voiceConnected")
      : t("desktop:call.connecting");
  const statusClass = ringing ? "text-idle" : connected ? "text-online" : "text-idle";

  const canShareScreen = connected && isScreenCaptureAvailable();

  /**
   * The primary button. Ringing → withdraw the call (there is no room to walk out
   * of yet). Otherwise LEAVE THE ROOM (ADR 0023 §2): the call stays alive for the
   * other person and for this account's other devices, and the controller falls
   * through to a real hang-up only when nobody is left behind.
   */
  const end = (): void => {
    if (ringing) void getCallController()?.cancel();
    else void getCallController()?.leaveRoom();
  };
  const onScreenShareClick = (): void => {
    if (screenShareEnabled) stopScreenShare();
    else setPickerOpen(true);
  };
  // Preview-before-publish (#101): opening the camera goes through the preview
  // dialog; closing it is a direct toggle — same flow as VoicePanel / the old
  // call surface (wiring preserved).
  const onCameraClick = (): void => {
    if (cameraEnabled) toggleCamera();
    else setCameraPreviewOpen(true);
  };

  // ── SEAT AWAY (ADR 0023 §1) ───────────────────────────────────────────────
  // The call is live but its media is not on this device: it is running on the
  // phone (`elsewhere`), or the user walked out of the room and the call is still
  // going (`vacant`). Everything below — camera, screen share, add-person, the
  // connection bars — would be a dead control over a room we are not in (§35), so
  // this is its own compact band: what is happening, and the one action that
  // changes it.
  if (!seatedHere && !ringing) {
    const elsewhere = state.seat === "elsewhere";
    return (
      <section
        aria-label={t("desktop:call.controlsLabel")}
        className="mx-2 mb-1.5 rounded-lg border border-stroke bg-surface p-2"
      >
        <div className="flex items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
            <Smartphone className="size-3.5" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold text-fg">
              {elsewhere ? t("desktop:call.seatElsewhere") : t("desktop:call.seatVacant")}
            </p>
            <p className="truncate text-2xs text-fg-muted">{peerName}</p>
          </div>
        </div>
        <p className="mt-1.5 text-2xs leading-snug text-fg-muted">
          {elsewhere ? t("desktop:call.seatElsewhereHint") : t("desktop:call.seatVacantHint")}
        </p>
        <div className="mt-2 flex items-center gap-1">
          <Button
            size="sm"
            className="flex-1"
            onClick={() => void getCallController()?.joinHere()}
            disabled={state.pending}
          >
            {elsewhere ? t("desktop:call.bringHere") : t("desktop:call.rejoin")}
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("desktop:call.hangUp")}
                onClick={() => void getCallController()?.hangup()}
                className="hover:bg-danger/15 hover:text-danger"
              >
                <PhoneOff className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{t("desktop:call.hangUp")}</TooltipContent>
          </Tooltip>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label={t("desktop:call.controlsLabel")}
      className="mx-2 mb-1.5 rounded-lg border border-stroke bg-surface p-2"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className={cn("text-xs font-semibold", statusClass)}>{statusText}</p>
          <p className="truncate text-2xs text-fg-muted">{peerName}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* Ping / connection-quality bars — self-hides unless connected. */}
          <VoiceConnectionBars />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={ringing ? t("desktop:call.cancel") : t("desktop:call.leaveRoom")}
                onClick={end}
                className="hover:bg-danger/15 hover:text-danger"
              >
                {ringing ? <PhoneOff className="size-4" /> : <LogOut className="size-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {ringing ? t("desktop:call.cancel") : t("desktop:call.leaveRoom")}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Aramada tek başına kaldıysan sunucu belli bir süre sonra aramayı kapatıyor;
          bu satır o süreyi gösterir. Sayaç yalnız motor kurduğunda görünür (DM
          araması + grup-DM seslisi), sunucu sesli kanalında asla. */}
      <AloneCountdownNotice className="mt-2" />

      {/* Controls are live from the ringing phase on — the room is already joined.
          Gating is per-control on the ENGINE status, never on the call phase. */}
      <div className="mt-2 grid grid-cols-3 gap-1">
        <DockControl
          label={cameraEnabled ? t("desktop:voice.stopCamera") : t("desktop:voice.camera")}
          active={cameraEnabled}
          disabled={!connected && !cameraEnabled}
          disabledHint={t("desktop:call.connecting")}
          onClick={onCameraClick}
          icon={cameraEnabled ? Video : VideoOff}
        />
        <DockControl
          label={
            screenShareEnabled ? t("desktop:voice.stopSharing") : t("desktop:voice.shareScreen")
          }
          active={screenShareEnabled}
          disabled={!canShareScreen && !screenShareEnabled}
          disabledHint={
            connected ? t("desktop:voice.shareNeedsDesktop") : t("desktop:call.connecting")
          }
          onClick={onScreenShareClick}
          icon={screenShareEnabled ? MonitorOff : Monitor}
        />
        <DockControl
          // The upgrade endpoint requires an ACTIVE call (409 otherwise), so this
          // one really is unavailable while ringing — disabled with a hint, not
          // hidden and not a dead button (§35).
          label={t("desktop:call.addPerson")}
          disabled={!connected || ringing}
          disabledHint={
            ringing ? t("desktop:call.addPersonNeedsAnswer") : t("desktop:call.connecting")
          }
          onClick={() => setAddOpen(true)}
          icon={UserPlus}
        />
      </div>

      <SourcePicker open={pickerOpen} onOpenChange={setPickerOpen} onSelect={startScreenShare} />
      <CameraPreviewDialog open={cameraPreviewOpen} onOpenChange={setCameraPreviewOpen} />
      <AddCallMemberDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        excludeUserId={peer?.id ?? null}
      />
    </section>
  );
}
