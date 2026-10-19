import { useEffect, useState } from "react";
import { m } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import {
  LogOut,
  Maximize2,
  Mic,
  MicOff,
  PhoneIncoming,
  PhoneOff,
  Video,
  VideoOff,
} from "lucide-react";
import { Button, Tooltip, TooltipContent, TooltipTrigger, UserAvatar, cn } from "@demli/ui";
import { toastPop } from "@demli/app-ui";
import type { CallState } from "@demli/client-core";
import { useAppTranslation } from "../lib/i18n";
import { getCallController } from "../lib/call-controller";
import { useVoiceStore } from "../stores/voice-store";

/**
 * Floating DM-call widget (embedded layout, task #104). The in-call surface lives
 * embedded in its own DM ({@link EmbeddedCallStage} + {@link CallDock}); whenever
 * the user is looking at something ELSE, this compact pill floats bottom-left so
 * the call stays reachable and controllable. The engine is untouched (ADR 0012
 * §11): only the presentation changes, media keeps running on the same LiveKit
 * room.
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
      <div className="flex items-center gap-1 rounded-2xl border border-stroke bg-surface p-1.5 shadow-2xl">
        {/* Expand region: avatar + name + live duration */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t("desktop:call.returnToCall")}
              onClick={onExpand}
              className="flex min-w-0 items-center gap-2 rounded-xl px-2 py-1 text-left hover:bg-raised"
            >
              {state.peer ? (
                <UserAvatar
                  name={state.peer.displayName}
                  colorSeed={state.peer.id}
                  src={state.peer.avatarUrl}
                  size="sm"
                />
              ) : (
                <span className="flex size-8 items-center justify-center rounded-full bg-online text-on-accent">
                  <Maximize2 className="size-4" />
                </span>
              )}
              <span className="min-w-0">
                <span className="block max-w-[9rem] truncate text-sm font-semibold text-fg">
                  {name}
                </span>
                <span className="block text-xs tabular-nums text-fg-muted">{subtitle}</span>
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">{t("desktop:call.returnToCall")}</TooltipContent>
        </Tooltip>

        {/* Inline mini controls. With the seat away, mic/camera would drive a room
            this device is not in — so the pill offers the one action that IS
            available: take the call here. Ending it stays reachable. */}
        <div className="flex items-center gap-1 pl-0.5">
          {seatedHere ? (
            <>
              <PillControl
                label={micEnabled ? t("desktop:voice.mute") : t("desktop:voice.unmute")}
                activeDanger={!micEnabled}
                onClick={toggleMic}
                icon={micEnabled ? Mic : MicOff}
              />
              <PillControl
                label={cameraEnabled ? t("desktop:voice.stopCamera") : t("desktop:voice.camera")}
                active={cameraEnabled}
                disabled={!connected && !cameraEnabled}
                onClick={toggleCamera}
                icon={cameraEnabled ? Video : VideoOff}
              />
            </>
          ) : (
            <PillControl
              label={
                state.seat === "elsewhere"
                  ? t("desktop:call.bringHere")
                  : t("desktop:call.rejoin")
              }
              disabled={state.pending}
              onClick={() => void getCallController()?.joinHere()}
              icon={PhoneIncoming}
            />
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label={
                  seatedHere ? t("desktop:call.leaveRoom") : t("desktop:call.hangUp")
                }
                onClick={seatedHere ? leave : hangup}
                className="size-8 rounded-full bg-danger p-0 text-on-accent hover:bg-danger/90"
              >
                {seatedHere ? <LogOut className="size-4" /> : <PhoneOff className="size-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {seatedHere ? t("desktop:call.leaveRoom") : t("desktop:call.hangUp")}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </m.div>
  );
}

function PillControl({
  label,
  active = false,
  activeDanger = false,
  disabled = false,
  onClick,
  icon: Icon,
}: {
  label: string;
  active?: boolean;
  activeDanger?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  icon: LucideIcon;
}): JSX.Element {
  const button = (
    <Button
      variant="secondary"
      size="icon"
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "size-8 rounded-full",
        active && "bg-accent/20 text-accent hover:bg-accent/30",
        activeDanger && "bg-danger/15 text-danger hover:bg-danger/25",
      )}
    >
      <Icon className="size-4" />
    </Button>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {disabled ? <span className="inline-flex">{button}</span> : button}
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
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
