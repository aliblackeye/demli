import { m } from "framer-motion";
import { Phone, PhoneOff, Video } from "lucide-react";
import { Button, UserAvatar, cn } from "@demli/ui";
import { overlayFade, popIn } from "@demli/app-ui";
import type { CallState } from "@demli/client-core";
import { useAppTranslation } from "../lib/i18n";
import { getCallController } from "../lib/call-controller";
import { useVoiceStore } from "../stores/voice-store";

/**
 * Global incoming-call overlay (ADR 0012 Wave 6) — renders on top of every
 * screen while a call is ringing in. Shows the caller, and Accept /
 * Accept-with-video / Decline. The ringtone, native toast, and window raise are
 * driven by {@link CallLayer}; this component is the visual + the actions.
 *
 * Parent guarantees `state.phase === "incoming"`.
 */
export function IncomingCallDialog({ state }: { state: CallState }): JSX.Element {
  const { t } = useAppTranslation();
  // Already in a voice session? Accepting performs the single-session handoff
  // (ADR 0012 §5), so warn the user they will leave it.
  const voiceStatus = useVoiceStore((s) => s.status);
  const busyElsewhere = voiceStatus === "connected" || voiceStatus === "reconnecting";

  // A control action (this accept, or a decline) is already in flight. Answering
  // twice used to run two accepts: the second one's pre-join leave bumps the
  // engine's command epoch, so the FIRST join returns having connected nothing and
  // the second `POST /accept` 409s — an "accepted" call with no media on this side
  // (call-UX plan K2.5). The controller now refuses the re-entry; the buttons must
  // SHOW they are busy rather than look ignored.
  const busy = state.pending;

  const caller = state.peer;
  const isGroup = state.surface?.kind === "group";
  const subtitle = isGroup
    ? t("desktop:call.incomingGroup")
    : state.media === "video"
      ? t("desktop:call.incomingVideo")
      : t("desktop:call.incomingVoice");

  const accept = (withVideo: boolean): void => {
    const controller = getCallController();
    if (!controller) return;
    void controller
      .accept()
      .then(() => {
        // Turn the camera on once media is up (fresh joins start camera-off).
        if (withVideo && !useVoiceStore.getState().cameraEnabled) {
          useVoiceStore.getState().toggleCamera();
        }
      })
      .catch(() => {
        // The controller already settled the FSM (ring re-armed / ended) and logged
        // the failure via onError (§26); the outcome surfaces through CallLayer.
        // Swallow here so a rejected accept never escapes as an unhandled promise
        // rejection (which the global reporter would flag as a renderer error).
      });
  };

  const decline = (): void => {
    void getCallController()?.decline();
  };

  return (
    <m.div
      role="dialog"
      aria-modal="true"
      aria-label={subtitle}
      variants={overlayFade}
      initial="initial"
      animate="animate"
      exit="exit"
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 backdrop-blur-sm"
    >
      <m.div
        variants={popIn}
        className="w-[min(24rem,calc(100vw-2rem))] rounded-2xl border border-stroke bg-surface p-6 text-center shadow-2xl"
      >
        <div className="flex justify-center">
          <span className="relative flex">
            {/* Pulsing ring to signal the live call */}
            <span className="absolute inset-0 animate-ping rounded-full bg-accent/30" aria-hidden />
            <UserAvatar
              name={caller?.displayName ?? "?"}
              colorSeed={caller?.id ?? "call"}
              src={caller?.avatarUrl ?? null}
              size="lg"
              className="relative"
            />
          </span>
        </div>

        <h2 className="mt-4 text-lg font-semibold text-fg">
          {caller?.displayName ?? t("desktop:call.notifyIncomingTitle")}
        </h2>
        <p className="mt-0.5 text-sm text-fg-muted">{subtitle}</p>

        {busyElsewhere && (
          <p className="mt-3 rounded-md border border-idle/30 bg-idle/10 px-3 py-2 text-xs text-idle">
            {t("desktop:call.busyWarning")}
          </p>
        )}

        <div className="mt-6 flex items-center justify-center gap-3">
          <CallCircleButton
            label={t("desktop:call.decline")}
            onClick={decline}
            variant="danger"
            disabled={busy}
            icon={<PhoneOff className="size-5" />}
          />
          <CallCircleButton
            label={t("desktop:call.acceptWithVideo")}
            onClick={() => accept(true)}
            variant="neutral"
            disabled={busy}
            icon={<Video className="size-5" />}
          />
          <CallCircleButton
            label={t("desktop:call.accept")}
            onClick={() => accept(false)}
            variant="accept"
            disabled={busy}
            icon={<Phone className="size-5" />}
          />
        </div>
      </m.div>
    </m.div>
  );
}

function CallCircleButton({
  label,
  onClick,
  variant,
  icon,
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  variant: "accept" | "danger" | "neutral";
  icon: JSX.Element;
  disabled?: boolean;
}): JSX.Element {
  const tone =
    variant === "accept"
      ? "bg-online text-on-accent hover:bg-online/90"
      : variant === "danger"
        ? "bg-danger text-on-accent hover:bg-danger/90"
        : "bg-raised text-fg hover:bg-overlay";
  return (
    <Button
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={cn("size-12 rounded-full p-0 disabled:opacity-60", tone)}
    >
      {icon}
    </Button>
  );
}
