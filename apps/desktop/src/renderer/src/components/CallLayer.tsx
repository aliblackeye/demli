import { useEffect, useRef, useState } from "react";
import { AnimatePresence, m } from "framer-motion";
import { Phone, PhoneOff } from "lucide-react";
import { UserAvatar } from "@demli/ui";
import { bannerDrop, toastPop } from "@demli/app-ui";
import { callTransitionCue } from "@demli/client-core";
import type { CallEndedReason, CallRole, CallState, PendingInvite } from "@demli/client-core";
import type { AppTFunction } from "../lib/i18n";
import { useAppTranslation } from "../lib/i18n";
import { getCallController } from "../lib/call-controller";
import { notifyIncomingCall } from "../notifications/notification-manager";
import { startRingtone, stopRingtone } from "../sounds/ringtone";
import { playSound } from "../sounds/sound-manager";
import { queryClient, queryKeys } from "../lib/query-client";
import { useAuthStore } from "../stores/auth-store";
import { useChatStore } from "../stores/chat-store";
import { useSelfPresenceStore } from "../stores/self-presence-store";
import { useDms } from "../queries/social-queries";
import { useDmCallSurface } from "../hooks/useDmCallSurface";
import { IncomingCallDialog } from "./IncomingCallDialog";
import { CallPill } from "./CallPill";
import { CallControl } from "./CallControls";

/** How long an ended call's outcome shows before the FSM returns to idle. */
const ENDED_LINGER_MS = 3500;
/** How long the "moved to a group call" confirmation shows after an upgrade. */
const MOVED_TOAST_MS = 4000;

/** Localized outcome text for an ended call (role-aware; §26). */
function localizeCallEnded(
  t: AppTFunction,
  reason: CallEndedReason | null,
  role: CallRole | null,
): string {
  switch (reason) {
    case "declined":
      return t("desktop:call.endedDeclined");
    case "canceled":
      return role === "callee" ? t("desktop:call.endedMissed") : t("desktop:call.endedCanceled");
    case "timeout":
      return role === "caller" ? t("desktop:call.endedNoAnswer") : t("desktop:call.endedMissed");
    case "busy":
      return t("desktop:call.endedBusy");
    case "failed":
      return t("desktop:call.endedFailed");
    case "upgraded":
      return t("desktop:call.endedUpgraded");
    case "session_replaced":
      return t("desktop:call.endedSessionReplaced");
    case "hung_up":
    default:
      return t("desktop:call.endedHungUp");
  }
}

/**
 * Root DM-call orchestration (ADR 0012 Wave 6; embedded layout, task #104). Owns
 * the global incoming-call overlay and the side effects that live outside a single
 * surface, plus the FLOATING call pill:
 *
 *  - ringtone: incoming ring / outgoing ringback while ringing;
 *  - incoming toast + window raise when the app is backgrounded (once per call);
 *  - routing the caller/callee onto the call's DM so the embedded stage is visible;
 *  - seamless-upgrade navigation into the new group's server surface;
 *  - the ended-call outcome, auto-returning the FSM to idle.
 *
 * The IN-CALL surface itself is no longer a full-screen overlay: it renders
 * EMBEDDED in the call's DM conversation ({@link EmbeddedCallStage} + the sidebar
 * {@link CallDock}). This layer only shows the {@link CallPill} while the user is
 * looking at something OTHER than the call's DM — clicking it routes back.
 *
 * Mounted once at the App root.
 */
export function CallLayer(): JSX.Element | null {
  const { t } = useAppTranslation();
  const { state, isDmCall, onCallDm, callDmId } = useDmCallSurface();
  const { data: dms } = useDms();
  const openDm = useChatStore((s) => s.openDm);
  const [movedToast, setMovedToast] = useState(false);
  // `activeSince` drives the pill's live duration label.
  const [activeSince, setActiveSince] = useState<number | null>(null);

  // Do Not Disturb (reactive, per-account): suppresses the incoming RING, the OS
  // toast + window-raise, and swaps the forced full-screen incoming overlay for a
  // quiet banner the user can still act on. The call FSM itself is untouched — the
  // user can accept/decline exactly as before, just without the interruption.
  const meId = useAuthStore((s) => s.user?.id);
  const doNotDisturb = useSelfPresenceStore((s) =>
    meId ? s.statusByUser[meId] === "dnd" : false,
  );

  // ── ringtone ──────────────────────────────────────────────────────────────
  // Ring ONLY while genuinely ringing AND no answer is in flight. `accept()` sets
  // `pending` true but deliberately KEEPS `phase === "incoming"` for the whole
  // async leave → mint → engine.join round-trip, flipping to "active"
  // (`accept_confirmed`) only once media has actually CONNECTED. Gating the ring on
  // `phase` alone therefore kept it audible until that join finished: on NATIVE
  // desktop the LiveKit join settles in a blink so the ring stopped effectively on
  // click, but a BROWSER's WebRTC join (getUserMedia + ICE/DTLS) takes seconds, so
  // on web the ring kept playing AFTER the user accepted and only cut out when the
  // call finally connected — the founder's "zil, aramayı kabul edince durmuyor, bir
  // süre sonra kendiliğinden kesiliyor". Fix: stop the instant the user COMMITS
  // (`pending`), not when media is up. Platform-safe — desktop already stopped ~now,
  // and a recoverable accept failure re-clears `pending` (still `incoming`) so the
  // ring correctly resumes until the give-up timer fires. Outgoing ringback is
  // unaffected: the caller's `pending` is already false throughout the "outgoing"
  // phase (`outgoing_started`/`accepted_by_peer` both clear it).
  useEffect(() => {
    if (state.pending) stopRingtone();
    // DND silences ONLY the incoming ring — an outgoing ringback is the caller's
    // own action and stays audible.
    else if (state.phase === "incoming") {
      if (doNotDisturb) stopRingtone();
      else startRingtone("incoming");
    } else if (state.phase === "outgoing") startRingtone("outgoing");
    else stopRingtone();
  }, [state.phase, state.pending, doNotDisturb]);
  useEffect(() => () => stopRingtone(), []);

  // ── call outcome cues: connected / ended / failed (shared policy) ──────────
  // `callTransitionCue` is the SAME rule mobile applies (sounds/call-ringtone.ts),
  // so both clients cue a call identically. The voice-room cues stay silent for
  // dmcall rooms (voice-sounds.ts) — the caller is in the room while it rings,
  // so only the FSM knows when the call actually connected.
  const prevCallRef = useRef<CallState>(state);
  useEffect(() => {
    const cue = callTransitionCue(prevCallRef.current, state);
    prevCallRef.current = state;
    if (cue) playSound(cue);
  }, [state]);

  // ── busy banner: a SHORT single cue for a parked 2nd invite (never the ring) ─
  const beepedRef = useRef<string | null>(null);
  useEffect(() => {
    const parked = state.pendingInvite;
    if (!parked) {
      beepedRef.current = null;
      return;
    }
    if (beepedRef.current === parked.callId) return;
    beepedRef.current = parked.callId;
    // A short blip only — it must NOT disrupt the ongoing call's audio; the
    // compact banner does the rest. Never `startRingtone` here.
    playSound("message");
  }, [state.pendingInvite]);

  // ── duration bookkeeping (drives the pill's live timer) ─────────────────────
  useEffect(() => {
    setActiveSince((prev) => (state.phase === "active" ? (prev ?? Date.now()) : null));
  }, [state.phase]);

  // ── route onto the call's DM so the embedded stage is visible ───────────────
  // When a DM call goes ACTIVE, bring the callee to that DM once so they land on
  // the embedded call surface (the caller is already there). Guarded per-call so a
  // deliberate navigation AWAY afterwards is never fought, and never fired for a
  // post-upgrade group surface (CallLayer routes those into the server instead).
  const routedRef = useRef<string | null>(null);
  useEffect(() => {
    if (state.phase === "idle") routedRef.current = null;
    const surface = state.surface;
    if (state.phase !== "active" || surface?.kind !== "dm" || !state.callId) return;
    if (state.role !== "callee") return;
    if (routedRef.current === state.callId) return;
    const dm = (dms ?? []).find((d) => d.id === surface.dmId);
    if (!dm) return; // resolve the stream on the next dms tick
    routedRef.current = state.callId;
    if (!onCallDm) openDm({ id: dm.id, streamId: dm.streamId });
  }, [state.phase, state.surface, state.callId, state.role, dms, onCallDm, openDm]);

  // ── incoming: native toast + raise the window (once per call) ───────────────
  const notifiedRef = useRef<string | null>(null);
  useEffect(() => {
    if (state.phase !== "incoming") {
      if (state.phase === "idle") notifiedRef.current = null;
      return;
    }
    if (!state.peer || !state.callId || notifiedRef.current === state.callId) return;
    notifiedRef.current = state.callId;
    // `notifyIncomingCall` is already a no-op under DND (via `canNotify`); the
    // window-raise is the other half of "önüme arama şeyi çıkmasın", so gate it
    // too — a DND user is never yanked to the foreground by a call.
    notifyIncomingCall(state.peer, state.media === "video");
    if (!doNotDisturb && !document.hasFocus()) {
      void window.demli?.notifications?.requestFocus().catch(() => undefined);
    }
  }, [state.phase, state.callId, state.peer, state.media, doNotDisturb]);

  // ── seamless upgrade → navigate into the new group's voice channel ──────────
  const upgradedRef = useRef<string | null>(null);
  useEffect(() => {
    if (state.phase === "idle") upgradedRef.current = null;
    if (state.phase !== "active" || state.surface?.kind !== "group" || !state.callId) return;
    if (upgradedRef.current === state.callId) return;
    upgradedRef.current = state.callId;
    const { groupId } = state.surface;
    // The new group + its channels arrive via member.joined invalidations; nudge
    // the group list too so the rail shows it, then route into the server surface.
    // Media stays on the same LiveKit room (ADR 0012 §6) — no re-join here.
    void queryClient.invalidateQueries({ queryKey: queryKeys.groups });
    void queryClient.invalidateQueries({ queryKey: queryKeys.groupDetails(groupId) });
    useChatStore.getState().openServer(groupId);
    setMovedToast(true);
  }, [state.phase, state.surface, state.callId]);

  useEffect(() => {
    if (!movedToast) return;
    const timer = window.setTimeout(() => setMovedToast(false), MOVED_TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [movedToast]);

  // ── ended: linger on the outcome, then return to idle ───────────────────────
  useEffect(() => {
    if (state.phase !== "ended") return;
    const timer = window.setTimeout(() => getCallController()?.dismiss(), ENDED_LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [state.phase, state.callId]);

  // The floating pill shows only while the live DM call's conversation is NOT the
  // one on screen; on the call's DM the embedded stage + dock take over instead.
  const showPill = isDmCall && !onCallDm;
  const expandToCallDm = (): void => {
    const dm = (dms ?? []).find((d) => d.id === callDmId);
    if (dm) openDm({ id: dm.id, streamId: dm.streamId });
  };

  return (
    // One AnimatePresence for the whole call layer: each surface enters and EXITS
    // (framer) as the FSM moves, so a ring, pill, banner or outcome toast never
    // pops in/out abruptly. Keys are stable per-surface so simultaneous overlays
    // (e.g. pill + busy banner) animate independently.
    <AnimatePresence>
      {/* Incoming ring: full-screen overlay normally, but under Do Not Disturb a
          quiet top banner instead — visible + actionable, never a forced pop-up. */}
      {state.phase === "incoming" &&
        (doNotDisturb ? (
          <QuietIncomingCallBanner key="quiet-incoming" state={state} />
        ) : (
          <IncomingCallDialog key="incoming-dialog" state={state} />
        ))}
      {showPill && (
        <CallPill
          key="call-pill"
          state={state}
          activeSince={activeSince}
          onExpand={expandToCallDm}
        />
      )}
      {/* Compact busy banner: a 2nd call arriving while this one is live. Hidden
          during an inbound ring (the full dialog owns that surface); it re-appears
          once that ring is answered and this call goes active. */}
      {state.pendingInvite && state.phase !== "incoming" && (
        <BusyCallBanner key="busy-banner" invite={state.pendingInvite} />
      )}
      {state.phase === "ended" && (
        <CallToast key="ended-toast" message={localizeCallEnded(t, state.endedReason, state.role)} />
      )}
      {movedToast && state.phase !== "ended" && (
        <CallToast key="moved-toast" message={t("desktop:call.movedToGroup")} />
      )}
    </AnimatePresence>
  );
}

/**
 * Compact "X is calling you" banner shown while ALREADY in a call (Task 1). A 2nd
 * incoming invite is parked in the FSM (`pendingInvite`); this offers accept —
 * which ends the current call and switches — or decline (the current call runs
 * on). Deliberately NOT a full-screen ring and NOT ringing (a short blip fired by
 * CallLayer), so it never disrupts the ongoing call. Sits above the call surface.
 */
function BusyCallBanner({ invite }: { invite: PendingInvite }): JSX.Element {
  const { t } = useAppTranslation();
  const caller = invite.caller;
  const name = caller.displayName || caller.username;
  const title =
    invite.media === "video"
      ? t("desktop:call.busyVideoCallingYou", { name })
      : t("desktop:call.busyCallingYou", { name });

  const accept = (): void => {
    void getCallController()?.acceptPendingInvite();
  };
  const decline = (): void => {
    void getCallController()?.declinePendingInvite();
  };

  return (
    <div
      role="alert"
      aria-label={title}
      className="pointer-events-none fixed inset-x-0 top-4 z-[75] flex justify-center px-4"
    >
      <m.div
        variants={bannerDrop}
        initial="initial"
        animate="animate"
        exit="exit"
        className="pointer-events-auto flex max-w-[min(28rem,calc(100vw-2rem))] items-center gap-3 rounded-card surface-glass-strong py-2 pl-2.5 pr-2"
      >
        <UserAvatar
          name={caller.displayName}
          colorSeed={caller.id}
          src={caller.avatarUrl}
          size="sm"
          className="[--avatar-ring:var(--color-overlay)]"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-label font-semibold text-fg-display">{title}</div>
          <div className="truncate text-2xs text-fg-muted">{t("desktop:call.busySwitchHint")}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <CallControl
            label={t("desktop:call.decline")}
            icon={PhoneOff}
            tone="leave"
            size="round"
            surface="glass"
            onClick={decline}
          />
          <CallControl
            label={t("desktop:call.accept")}
            icon={Phone}
            tone="accept"
            size="round"
            surface="glass"
            onClick={accept}
          />
        </div>
      </m.div>
    </div>
  );
}

/**
 * Quiet incoming-call surface shown ONLY under Do Not Disturb, in place of the
 * full-screen ring overlay. A compact top banner: caller + Accept / Decline, plus
 * a one-line "DND is on" hint. No ring, no window-raise, no modal takeover — the
 * user sees the call and can answer, but is never interrupted (founder's
 * "uygulama altta olduğunda önüme arama şeyi çıkmaz"). Actions drive the SAME call
 * controller as the full dialog, so the FSM is unchanged.
 */
function QuietIncomingCallBanner({ state }: { state: CallState }): JSX.Element {
  const { t } = useAppTranslation();
  const caller = state.peer;
  const name = caller?.displayName ?? caller?.username ?? t("desktop:call.notifyIncomingTitle");
  const subtitle =
    state.media === "video" ? t("desktop:call.incomingVideo") : t("desktop:call.incomingVoice");

  const accept = (): void => {
    void getCallController()
      ?.accept()
      .catch(() => {
        // The controller settles the FSM + logs via onError (§26); swallow so a
        // rejected accept never escapes as an unhandled rejection.
      });
  };
  const decline = (): void => {
    void getCallController()?.decline();
  };

  return (
    <div
      role="alert"
      aria-label={`${name} — ${subtitle}`}
      className="pointer-events-none fixed inset-x-0 top-4 z-[70] flex justify-center px-4"
    >
      <m.div
        variants={bannerDrop}
        initial="initial"
        animate="animate"
        exit="exit"
        className="pointer-events-auto flex max-w-[min(28rem,calc(100vw-2rem))] items-center gap-3 rounded-card surface-glass-strong py-2 pl-2.5 pr-2"
      >
        <UserAvatar
          name={name}
          colorSeed={caller?.id ?? "call"}
          src={caller?.avatarUrl ?? null}
          size="sm"
          className="[--avatar-ring:var(--color-overlay)]"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-label font-semibold text-fg-display">{name}</div>
          <div className="truncate text-2xs text-fg-muted">
            {subtitle} · {t("desktop:call.dndQuietHint")}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <CallControl
            label={t("desktop:call.decline")}
            icon={PhoneOff}
            tone="leave"
            size="round"
            surface="glass"
            onClick={decline}
          />
          <CallControl
            label={t("desktop:call.accept")}
            icon={Phone}
            tone="accept"
            size="round"
            surface="glass"
            onClick={accept}
          />
        </div>
      </m.div>
    </div>
  );
}

/** A small centered outcome/confirmation pill above every surface. */
function CallToast({ message }: { message: string }): JSX.Element {
  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 bottom-6 z-[80] flex justify-center"
    >
      <m.div
        variants={toastPop}
        initial="initial"
        animate="animate"
        exit="exit"
        className="rounded-pill surface-glass-strong px-4 py-2 text-label font-medium text-fg"
      >
        {message}
      </m.div>
    </div>
  );
}
