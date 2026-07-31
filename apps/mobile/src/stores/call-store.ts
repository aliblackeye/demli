/**
 * DM-call store glue (ADR 0012 / plan Wave 7) — the mobile binding of the SHARED,
 * framework-free call controller (`@demli/client-core`'s `createCallController`).
 *
 * The controller owns the whole call lifecycle (ring → active → ended, the
 * seamless group upgrade, the caller ring timeout, single-session end); this file
 * only wires it to the mobile seams and exposes a React binding:
 *
 *  - `engine`  → the SAME app-lifetime `voiceEngine` (voice-store), wrapped so a
 *    join first leaves any current room (the engine's JOIN is only legal from
 *    idle/error). A DM call is a voice room, so mic/camera/screen-share/reconnect
 *    all fall out of the existing engine (ADR 0012 §2).
 *  - `api`     → the mobile `getApi()` (satisfies the controller's `CallApi` slice).
 *  - `signalVoiceJoin` → announces the group voice channel for OCCUPANCY on a
 *    seamless upgrade (media never moves — connection.ts §6/§10).
 *
 * The controller is a small subscribable store (`getState`/`subscribe`, the same
 * contract the media engine uses). We bind it to React with `useSyncExternalStore`
 * behind a STABLE facade (module-level `subscribe`/`getSnapshot`) so we can rebind
 * to a fresh controller per session (correct `currentUserId`, no stale call state
 * across a re-login) WITHOUT breaking any component's subscription.
 *
 * CRITICAL (ADR 0012 §6 / Wave 4): on `call.upgraded` the controller NEVER calls
 * engine.leave()/join(voiceChannelId) — it re-points the surface and emits a
 * signaling-only occupancy join. The engine stays on the same LiveKit room, so
 * the two originals' audio never drops.
 */
import { useSyncExternalStore } from "react";
import {
  createCallController,
  createCallEngineAdapter,
  watchCallMedia,
  type CallController,
  type CallState,
  type CallTransition,
  type CallVoiceEngine,
} from "@demli/client-core";
import type { ChannelId, UserId } from "@demli/types";
import { friendlyErrorMessage, getApi } from "../lib/clients";
import { announceCallOccupancy } from "../realtime/connection";
import { useMediaSettings } from "./media-settings";
import { voiceEngine } from "./voice-store";

/**
 * The engine seam the controller drives — built by the SHARED adapter
 * (`@demli/client-core`'s `createCallEngineAdapter`), so the join-legality
 * rules live in ONE place for both platforms instead of a hand-rolled copy per
 * app. It handles what a raw `voiceEngine.join` cannot:
 *
 *  - live status (`connected`/`joining`/`reconnecting`) → leave first (JOIN is
 *    only legal from idle/error, §11);
 *  - `leaving` → WAIT the teardown out (call-UX plan K2.8). LEAVE is illegal from
 *    `leaving` too, so the old leave-first guard threw `InvalidVoiceCommandError`
 *    and the accept/start died silently mid-way: the row live server-side, this
 *    phone with no media — the founder's "kabul etti ama bağlanmadı";
 *  - `isConnectedTo` → the honest, FSM-read answer to "is media actually up on
 *    this room?", which is what lets the controller's resync tell a real `active`
 *    call from a media-less one (K2.3) and skip re-joining a live session.
 *
 * The controller hands a PRE-MINTED `{ url, token }` credential (from the call
 * endpoint), which the engine uses instead of its own token fetch (ADR 0012 §2).
 */
const callEngine: CallVoiceEngine = createCallEngineAdapter({
  getVoiceState: () => voiceEngine.getState(),
  subscribeVoice: (listener) => voiceEngine.subscribe(listener),
  join: (roomChannelId, credential) => voiceEngine.join(roomChannelId, credential),
  leave: () => voiceEngine.leave(),
  // Same pre-join setup the store's own channel `join` applies: under push-to-talk
  // join MUTED so nothing transmits until the user holds Talk. Without it a call
  // answered on a PTT phone went live with a hot mic — the opposite of the setting.
  beforeJoin: async () => {
    if (useMediaSettings.getState().audio.inputMode === "push_to_talk") {
      await voiceEngine.setMic(false);
    }
  },
});

/**
 * THE diagnostic line for call connectivity (call-UX plan K2.7). One line per FSM
 * transition carrying the pair that identifies every "accepted but never
 * connected" variant: the call phase and the voice/media status at that instant.
 * `dropped` marks an action the reducer IGNORED — the failure mode this wave
 * fixes, and the one that used to leave no trace at all.
 *
 * Deliberately terse and low-volume (§27): a handful of lines per call, never per
 * frame — it rides the same `console` the mobile logs are read through (adb/Expo).
 */
function logCallTransition(t: CallTransition): void {
  console.info(
    `[call] ${t.action} ${t.from}→${t.to}${t.applied ? "" : " (dropped)"} voice=${t.voiceStatus ?? "?"} call=${t.callId ?? "-"}`,
  );
}

function createController(userId: UserId): CallController {
  return createCallController({
    api: getApi(),
    engine: callEngine,
    currentUserId: userId,
    // Occupancy-only announce for the group voice channel on a seamless upgrade
    // (media stays on the same LiveKit room — connection.ts owns the WS announce).
    signalVoiceJoin: (channelId: ChannelId) => announceCallOccupancy(channelId),
    onError: (error, action) => {
      // The FSM already lands on a friendly terminal/outcome; just log the cause.
      console.warn(`[call] ${action} failed: ${friendlyErrorMessage(error)}`);
    },
    getVoiceStatus: () => voiceEngine.getState().status,
    onTransition: logCallTransition,
  });
}

// ── stable store facade over a rebindable controller ────────────────────────

let controller: CallController = createController("" as UserId);
const listeners = new Set<() => void>();
let unbindController = controller.subscribe(() => emit());

/**
 * Keep the call FSM honest about MEDIA (call-UX plan K2.4) — the shared decision
 * (`watchCallMedia`), wired to this app's engine.
 *
 * Three endings arrive through the voice FSM rather than through a `call.*` event
 * (post-upgrade group session left via the voice UI; engine `error` on the call's
 * own room; engine back to `idle` with no call terminal). Before this the phone
 * handled NONE of them, so a dead media session left a phantom `active` call that
 * `isCallLive` used to refuse every new call with — the founder's "çıkıp o kişiyi
 * tekrar aramak zorunda kalıyorum". The two exceptions the shared decision keeps:
 * a `pending` control action owns its own leave/join churn, and an already-
 * attributed `endedReason` (`session_replaced` — the call is LIVE on another
 * device, so ending it here would kill it — or `alone`) is never a failure.
 *
 * Registered once for the app lifetime, reading the CURRENT controller per
 * notification so a rebind ({@link configureCallController}) needs no
 * re-subscribe.
 */
watchCallMedia({
  subscribeVoice: (listener) => voiceEngine.subscribe(listener),
  getController: () => controller,
});

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** The current controller — used by the realtime layer to feed server events. */
export function getCallController(): CallController {
  return controller;
}

/**
 * Rebind to a FRESH, idle controller for a new session so `currentUserId` is
 * correct (the start-409 adopt path needs it) and no stale call state carries
 * across a re-login. The stable facade below keeps every subscribed component
 * intact; `emit()` makes them re-read the fresh (idle) snapshot.
 */
export function configureCallController(userId: UserId): void {
  unbindController();
  controller.dispose();
  controller = createController(userId);
  unbindController = controller.subscribe(() => emit());
  announceCallOccupancy(null);
  emit();
}

/** Tear down the call controller on logout/session end (mirror of configure). */
export function resetCallController(): void {
  configureCallController("" as UserId);
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function getSnapshot(): CallState {
  return controller.getState();
}

/**
 * Subscribe to live call state OUTSIDE React (e.g. the ringtone side-effect in
 * sounds/call-ringtone.ts). Rides the SAME stable facade as {@link useCallState},
 * so it keeps working across a controller rebind ({@link configureCallController})
 * and reads the fresh snapshot on every notify. Returns an unsubscribe.
 */
export function subscribeCallState(listener: (state: CallState) => void): () => void {
  return subscribe(() => listener(controller.getState()));
}

/** Bind the live call state to a component (re-renders only on real changes). */
export function useCallState(): CallState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
