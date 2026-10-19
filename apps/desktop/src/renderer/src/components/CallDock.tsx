/**
 * Bottom-left DM-call control dock (task #104 — the "connected to a call"
 * box). Sits just above the {@link UserFooter} in the home sidebar, shown while the
 * call's own DM is on screen (paired with the {@link EmbeddedCallStage} at the top
 * of the conversation). It carries the call-SPECIFIC controls the removed
 * full-screen surface used to hold:
 *
 *  - live connection status + the peer's name;
 *  - camera (preview-before-publish via {@link CameraPreviewDialog}, #101),
 *    screen-share (via {@link SourcePicker}), add-person → seamless group upgrade;
 *  - hang up (or cancel while still ringing out);
 *  - the same voice-error line and screen-share sound status as the VoicePanel
 *    ({@link ShareAudioStatus}), so a DM call is never the silent surface.
 *
 * Mic / deafen / voice-settings are NOT duplicated here — they already live in the
 * always-present UserFooter user bar, which drives the same engine. This keeps the
 * dock compact, exactly like the server {@link VoicePanel} it mirrors — and it is
 * drawn with the SAME card, status dot and {@link CallControl}s, so a DM call and
 * a voice channel read as one product (M16 §1).
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
import { Button, cn } from "@demli/ui";
import { useAppTranslation } from "../lib/i18n";
import { getCallController } from "../lib/call-controller";
import { useDms } from "../queries/social-queries";
import { isScreenCaptureAvailable } from "../lib/screen-share";
import { useVoiceStore } from "../stores/voice-store";
import { useDmCallSurface, type DmCallSurface } from "../hooks/useDmCallSurface";
import { AloneCountdownNotice } from "./AloneCountdownNotice";
import { ShareAudioStatus, VoiceErrorNotice } from "./ShareAudioStatus";
import { VoiceConnectionBars } from "./VoiceConnectionBars";
import { SourcePicker } from "./SourcePicker";
import { CameraPreviewDialog } from "./CameraPreviewDialog";
import { AddCallMemberDialog } from "./AddCallMemberDialog";
import { CallControl, LiveDot } from "./CallControls";

/** The dock's card — the same surface the server-channel VoicePanel uses. */
const DOCK_CARD = "mx-2 mb-2 rounded-xl bg-surface p-2.5 animate-pop-in";

export function CallDock(): JSX.Element | null {
  return <CallDockView surface={useDmCallSurface()} />;
}

/**
 * The dock itself, fed the call surface instead of reading it. Split only so the
 * dev harness can render every call phase (ringing, connecting, live, seat away)
 * through the REAL component without a live call controller; production always
 * goes through {@link CallDock}.
 */
export function CallDockView({ surface }: { surface: DmCallSurface }): JSX.Element | null {
  const { t } = useAppTranslation();
  const { state, onCallDm, callDmId, seatedHere } = surface;
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

  // Status line: ringing → "Ringing…"; connected → voice/video-connected (the
  // room's coral light); otherwise the media is still coming up → "Connecting…".
  const statusText = ringing
    ? t("desktop:call.ringing")
    : connected
      ? cameraEnabled
        ? t("desktop:call.videoConnected")
        : t("desktop:call.voiceConnected")
      : t("desktop:call.connecting");
  const statusClass = ringing || !connected ? "text-warning" : "text-accent";

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
        data-testid="call-dock"
        data-seat={state.seat}
        className={DOCK_CARD}
      >
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-surface text-accent-hover">
            {elsewhere ? (
              <Smartphone aria-hidden className="size-4" />
            ) : (
              <LogOut aria-hidden className="size-4" />
            )}
          </span>
          <div className="min-w-0">
            <p className="truncate text-label font-semibold text-fg">
              {elsewhere ? t("desktop:call.seatElsewhere") : t("desktop:call.seatVacant")}
            </p>
            <p className="truncate text-2xs text-fg-faint">{peerName}</p>
          </div>
        </div>
        <p className="mt-2 text-2xs leading-snug text-fg-muted">
          {elsewhere ? t("desktop:call.seatElsewhereHint") : t("desktop:call.seatVacantHint")}
        </p>
        <div className="mt-2.5 flex items-center gap-1.5">
          <Button
            size="sm"
            variant="accent"
            className="flex-1"
            onClick={() => void getCallController()?.joinHere()}
            loading={state.pending}
          >
            {elsewhere ? t("desktop:call.bringHere") : t("desktop:call.rejoin")}
          </Button>
          <CallControl
            label={t("desktop:call.hangUp")}
            icon={PhoneOff}
            tone="off"
            size="round-sm"
            onClick={() => void getCallController()?.hangup()}
          />
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label={t("desktop:call.controlsLabel")}
      data-testid="call-dock"
      data-phase={state.phase}
      className={DOCK_CARD}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5 pl-0.5">
          <LiveDot tone={ringing || !connected ? "pending" : "live"} />
          <div className="min-w-0">
            <p role="status" title={statusText} className={cn("truncate text-label font-semibold", statusClass)}>
              {statusText}
            </p>
            <p className="truncate text-2xs text-fg-faint">{peerName}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* Ping / connection-quality bars — self-hides unless connected. */}
          <VoiceConnectionBars />
          <CallControl
            label={ringing ? t("desktop:call.cancel") : t("desktop:call.leaveRoom")}
            icon={ringing ? PhoneOff : LogOut}
            tone="off"
            size="round-sm"
            onClick={end}
            data-testid="call-dock-leave"
          />
        </div>
      </div>

      {/* Aramada tek başına kaldıysan sunucu belli bir süre sonra aramayı kapatıyor;
          bu satır o süreyi gösterir. Sayaç yalnız motor kurduğunda görünür (DM
          araması + grup-DM seslisi), sunucu sesli kanalında asla. */}
      <AloneCountdownNotice className="mt-2" />

      {/* Same media notices as the voice-channel panel: a DM call's errors and
          its screen share's sound status used to be invisible here. */}
      <VoiceErrorNotice className="mt-2" />
      <ShareAudioStatus className="mt-2" />

      {/* Controls are live from the ringing phase on — the room is already joined.
          Gating is per-control on the ENGINE status, never on the call phase. */}
      <div className="mt-2.5 grid grid-cols-3 gap-1">
        <CallControl
          label={cameraEnabled ? t("desktop:voice.stopCamera") : t("desktop:voice.camera")}
          icon={cameraEnabled ? Video : VideoOff}
          tone={cameraEnabled ? "on" : "neutral"}
          pressed={cameraEnabled}
          disabled={!connected && !cameraEnabled}
          disabledHint={t("desktop:call.connecting")}
          onClick={onCameraClick}
        />
        <CallControl
          label={
            screenShareEnabled ? t("desktop:voice.stopSharing") : t("desktop:voice.shareScreen")
          }
          icon={screenShareEnabled ? MonitorOff : Monitor}
          tone={screenShareEnabled ? "on" : "neutral"}
          pressed={screenShareEnabled}
          disabled={!canShareScreen && !screenShareEnabled}
          disabledHint={
            connected ? t("desktop:voice.shareNeedsDesktop") : t("desktop:call.connecting")
          }
          onClick={onScreenShareClick}
        />
        <CallControl
          // The upgrade endpoint requires an ACTIVE call (409 otherwise), so this
          // one really is unavailable while ringing — disabled with a hint, not
          // hidden and not a dead button (§35).
          label={t("desktop:call.addPerson")}
          icon={UserPlus}
          disabled={!connected || ringing}
          disabledHint={
            ringing ? t("desktop:call.addPersonNeedsAnswer") : t("desktop:call.connecting")
          }
          onClick={() => setAddOpen(true)}
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
