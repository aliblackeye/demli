import { useEffect, useState } from "react";
import { m } from "framer-motion";
import { LogOut, Maximize2, Mic, MicOff, PhoneIncoming, PhoneOff, Video, VideoOff } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger, UserAvatar, cn } from "@demli/ui";
import { toastPop } from "@demli/app-ui";
import type { CallState } from "@demli/client-core";
import { useAppTranslation } from "../lib/i18n";
import { getCallController } from "../lib/call-controller";
import { useVoiceStore } from "../stores/voice-store";
import { CallControl, LiveDot } from "./CallControls";

/**
 * Floating DM-call widget (embedded layout, task #104). The in-call surface lives
 * embedded in its own DM ({@link EmbeddedCallStage} + {@link CallDock}); whenever
 * the user is looking at something ELSE, this compact pill floats bottom-left so
 * the call stays reachable and controllable. The engine is untouched (ADR 0012
 * §11): only the presentation changes, media keeps running on the same LiveKit
 * room.
 *
 * Drawn as the Koyu Masa floating layer — strong glass (92% + blur), pill radius,
 * no border and no shadow — with the same {@link CallControl}s as the dock, so the
 * mute you press here looks and behaves like the one in the sidebar. It rides in
 * on the position spring and sinks out on the fast step (`toastPop`).
 *
 * Sits at z-40 — ABOVE the app shell but BELOW Radix dialogs (z-50) — so
 * device-settings / picker dialogs still open on top. Clicking the pill body
 * (`onExpand`) routes back to the call's DM, where the embedded stage shows.
 */
export function CallPill({
  state,
  activeSince,
  onExpand,
}: {
  state: CallState;
  /** Epoch ms the call became active (drives the live duration). */
  activeSince: number | null;
  onExpand: () => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const micEnabled = useVoiceStore((s) => s.micEnabled);
  const cameraEnabled = useVoiceStore((s) => s.cameraEnabled);
  const connected = useVoiceStore((s) => s.status === "connected");
  const toggleMic = useVoiceStore((s) => s.toggleMic);
  const toggleCamera = useVoiceStore((s) => s.toggleCamera);

  const duration = useElapsedLabel(activeSince);
  const name = state.peer?.displayName ?? t("desktop:call.calling");
  // The seat, not the engine, decides what this pill says (ADR 0023 §1): media
  // on another device — or a room we deliberately walked out of — is a live call
  // whose controls here would drive nothing (§35).
  const seatedHere = state.seat === "here";
  const subtitle = !seatedHere
    ? state.seat === "elsewhere"
      ? t("desktop:call.seatElsewhere")
      : t("desktop:call.seatVacant")
    : connected
      ? duration
      : t("desktop:call.connecting");

  const hangup = (): void => {
    void getCallController()?.hangup();
  };
  const leave = (): void => {
    void getCallController()?.leaveRoom();
  };

  return (
    <m.div
      variants={toastPop}
      initial="initial"
      animate="animate"
      exit="exit"
      className="fixed bottom-4 left-4 z-40 flex"
      data-testid="call-pill"
    >
      <div className="flex items-center gap-1 rounded-pill surface-glass-strong p-1.5">
        {/* Expand region: avatar + name + live duration */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t("desktop:call.returnToCall")}
              onClick={onExpand}
              className={cn(
                "flex min-w-0 items-center gap-2.5 rounded-pill py-1 pl-1 pr-3 text-left",
                "transition-colors motion-hover hover:bg-wash active:bg-wash-strong",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
              )}
            >
              {state.peer ? (
                <span className="relative inline-flex [--avatar-ring:var(--color-overlay)]">
                  <UserAvatar
                    name={state.peer.displayName}
                    colorSeed={state.peer.id}
                    src={state.peer.avatarUrl}
                    size="sm"
                  />
                </span>
              ) : (
                <span className="flex size-8 items-center justify-center rounded-full bg-raised text-fg">
                  <Maximize2 aria-hidden className="size-4" />
                </span>
              )}
              <span className="min-w-0">
                <span className="block max-w-[9rem] truncate text-label font-semibold text-fg-display">
                  {name}
                </span>
                <span className="flex items-center gap-1.5 text-2xs tabular-nums text-fg-muted">
                  <LiveDot
                    tone={!seatedHere ? "idle" : connected ? "live" : "pending"}
                    small
                  />
                  {subtitle}
                </span>
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">{t("desktop:call.returnToCall")}</TooltipContent>
        </Tooltip>

        {/* Inline mini controls. With the seat away, mic/camera would drive a room
            this device is not in — so the pill offers the one action that IS
            available: take the call here. Ending it stays reachable. */}
        <div className="flex items-center gap-1">
          {seatedHere ? (
            <>
              <CallControl
                label={micEnabled ? t("desktop:voice.mute") : t("desktop:voice.unmute")}
                icon={micEnabled ? Mic : MicOff}
                tone={micEnabled ? "neutral" : "off"}
                pressed={!micEnabled}
                size="round-sm"
                surface="glass"
                onClick={toggleMic}
              />
              <CallControl
                label={cameraEnabled ? t("desktop:voice.stopCamera") : t("desktop:voice.camera")}
                icon={cameraEnabled ? Video : VideoOff}
                tone={cameraEnabled ? "on" : "neutral"}
                pressed={cameraEnabled}
                size="round-sm"
                surface="glass"
                disabled={!connected && !cameraEnabled}
                disabledHint={t("desktop:call.connecting")}
                onClick={toggleCamera}
              />
            </>
          ) : (
            <CallControl
              label={
                state.seat === "elsewhere" ? t("desktop:call.bringHere") : t("desktop:call.rejoin")
              }
              icon={PhoneIncoming}
              tone="on"
              size="round-sm"
              surface="glass"
              disabled={state.pending}
              onClick={() => void getCallController()?.joinHere()}
            />
          )}
          <CallControl
            label={seatedHere ? t("desktop:call.leaveRoom") : t("desktop:call.hangUp")}
            icon={seatedHere ? LogOut : PhoneOff}
            tone="leave"
            size="round-sm"
            surface="glass"
            onClick={seatedHere ? leave : hangup}
          />
        </div>
      </div>
    </m.div>
  );
}

/** mm:ss elapsed since `since`, ticking once a second. Empty while not active. */
function useElapsedLabel(since: number | null): string {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (since === null) return;
    const id = window.setInterval(() => setTick((n) => (n + 1) % 3600), 1000);
    return () => window.clearInterval(id);
  }, [since]);
  if (since === null) return "";
  const secs = Math.max(0, Math.floor((Date.now() - since) / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
