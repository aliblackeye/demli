import { useEffect, useRef } from "react";
import type { LucideIcon } from "lucide-react";
import { m } from "framer-motion";
import { Phone, PhoneIncoming, PhoneOff, Users, Video } from "lucide-react";
import { UserAvatar } from "@demli/ui";
import { overlayFade, popIn } from "@demli/app-ui";
import type { CallState } from "@demli/client-core";
import { useAppTranslation } from "../lib/i18n";
import { getCallController } from "../lib/call-controller";
import { useVoiceStore } from "../stores/voice-store";
import { CallControl, type CallControlTone } from "./CallControls";

/**
 * Global incoming-call overlay (ADR 0012 Wave 6) — renders on top of every
 * screen while a call is ringing in. Shows the caller, and Accept /
 * Accept-with-video / Decline. The ringtone, native toast, and window raise are
 * driven by {@link CallLayer}; this component is the visual + the actions.
 *
 * Koyu Masa card: base tone on the blurred scrim, radius 24, no border, no
 * shadow, with the coral glow band across the top (the profile-card motif). The
 * caller's avatar BREATHES — a soft coral halo swelling and settling behind it
 * while the phone rings, which is the one thing on screen that moves. It stops
 * under reduced motion (the halo stays, still).
 *
 * Every action is a labelled circle, so the three choices are told apart by
 * position, glyph, word AND colour — never colour alone (decline pink and accept
 * green collapse under red-green colour blindness).
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

  // Keyboard users land INSIDE the ring card (on the card itself, not on a
  // button — a stray Enter must never answer or decline), and focus goes back
  // where it was once the ring ends.
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cardRef.current?.focus({ preventScroll: true });
    return () => previous?.focus?.({ preventScroll: true });
  }, []);

  const caller = state.peer;
  const isGroup = state.surface?.kind === "group";
  const subtitle = isGroup
    ? t("desktop:call.incomingGroup")
    : state.media === "video"
      ? t("desktop:call.incomingVideo")
      : t("desktop:call.incomingVoice");
  const SubtitleIcon = isGroup ? Users : state.media === "video" ? Video : PhoneIncoming;
  const callerName = caller?.displayName ?? t("desktop:call.notifyIncomingTitle");

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
      aria-label={`${callerName} — ${subtitle}`}
      data-testid="incoming-call"
      variants={overlayFade}
      initial="initial"
      animate="animate"
      exit="exit"
      className="fixed inset-0 z-[70] flex items-center justify-center surface-scrim"
    >
      <m.div
        ref={cardRef}
        tabIndex={-1}
        variants={popIn}
        className="relative w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-card bg-app px-6 pb-6 pt-9 text-center outline-none"
      >
        {/* The coral glow band — the room's warm light, held at the top edge. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-[radial-gradient(70%_100%_at_50%_0%,var(--color-accent-glow),transparent_72%)]"
        />

        <div className="relative flex justify-center">
          <span className="relative flex">
            {/* Breathing halo: a blurred coral disc swelling and settling on the
                1.6s pulse while the call rings (`pulse-ring` keyframes). */}
            <span
              aria-hidden
              data-testid="incoming-call-halo"
              className="absolute -inset-3 rounded-full bg-accent-glow blur-md animate-pulse-ring motion-reduce:animate-none"
            />
            <span aria-hidden className="absolute -inset-1 rounded-full shadow-[0_0_0_2px_var(--color-accent)]" />
            <UserAvatar
              name={caller?.displayName ?? "?"}
              colorSeed={caller?.id ?? "call"}
              src={caller?.avatarUrl ?? null}
              size="lg"
              ring={false}
              className="relative"
            />
          </span>
        </div>

        <h2 className="relative mt-6 truncate font-display text-xl font-medium text-fg-display">
          {callerName}
        </h2>
        <p className="relative mt-1 flex items-center justify-center gap-1.5 text-label text-fg-muted">
          <SubtitleIcon aria-hidden className="size-3.5 shrink-0" />
          {subtitle}
        </p>

        {busyElsewhere && (
          <p className="relative mt-4 rounded-lg bg-warning/12 px-3 py-2 text-2xs leading-snug text-warning">
            {t("desktop:call.busyWarning")}
          </p>
        )}

        <div className="relative mt-7 grid grid-cols-3 gap-2" aria-busy={busy || undefined}>
          <RingAction
            label={t("desktop:call.decline")}
            icon={PhoneOff}
            tone="leave"
            onClick={decline}
            disabled={busy}
            testId="incoming-decline"
          />
          <RingAction
            label={t("desktop:call.acceptWithVideo")}
            icon={Video}
            tone="neutral"
            onClick={() => accept(true)}
            disabled={busy}
            testId="incoming-accept-video"
          />
          <RingAction
            label={t("desktop:call.accept")}
            icon={Phone}
            tone="accept"
            onClick={() => accept(false)}
            disabled={busy}
            testId="incoming-accept"
          />
        </div>
      </m.div>
    </m.div>
  );
}

/** One labelled answer circle: the 56px control with its word under it. */
function RingAction({
  label,
  icon,
  tone,
  onClick,
  disabled,
  testId,
}: {
  label: string;
  icon: LucideIcon;
  tone: CallControlTone;
  onClick: () => void;
  disabled: boolean;
  testId: string;
}): JSX.Element {
  return (
    <div className="flex flex-col items-center gap-2">
      <CallControl
        label={label}
        icon={icon}
        tone={tone}
        size="hero"
        disabled={disabled}
        onClick={onClick}
        data-testid={testId}
      />
      <span aria-hidden className="text-2xs font-medium leading-tight text-fg-muted">
        {label}
      </span>
    </div>
  );
}
