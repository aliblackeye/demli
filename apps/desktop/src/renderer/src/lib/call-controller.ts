/**
 * Desktop DM-call controller glue (ADR 0012 Wave 6).
 *
 * The call FSM + control/data layer are SHARED (`@demli/client-core`); this
 * module owns the single desktop instance and the desktop-only wiring around it:
 *
 *  - Injects the concrete api client, the LiveKit engine adapter
 *    (`callEngine`, which drives the SAME engine the voice store mirrors), and
 *    the current user id.
 *  - Derives voice-channel occupancy from the FSM surface (ADR 0012 §6): a plain
 *    1-1 call announces nothing; a post-upgrade group voice channel is announced
 *    so co-members see the occupants — media never moves (§10/§35).
 *  - Retires the FSM when a post-upgrade group voice session is left through the
 *    normal voice UI (engine → idle), freeing the single call slot.
 *  - Exposes a `useSyncExternalStore` binding (`useCallState`) so React renders
 *    the ring / in-call surfaces off the FSM without a second copy of the state.
 *
 * The controller is (re)created per signed-in user in `initCallController` (from
 * App.tsx's auth effect) and torn down on logout, so a stale `currentUserId`
 * never leaks across accounts. `connection.ts` feeds it every `call.*` /
 * `voice.session_replaced` event via `getCallController()`.
 */

import { useSyncExternalStore } from "react";
import {
  createCallController,
  decideCallMediaOutcome,
  initialCallState,
  type CallActionName,
  type CallController,
  type CallState,
  type CallTransition,
} from "@demli/client-core";
import type { ChannelId, UserId } from "@demli/types";
import { ApiClientError, api } from "./api-client";
import { notifyBlocked } from "./blocked-notice";
import { setCallOccupancyChannel } from "../realtime/connection";
import { callEngine, useVoiceStore } from "../stores/voice-store";

/** The single desktop controller for the signed-in user, or null when logged out. */
let controller: CallController | null = null;

/** The group voice channel occupancy last announced, so we only push real changes. */
let announcedOccupancy: ChannelId | null = null;

/**
 * A control action failed. Terminal outcomes are already reflected in the FSM
 * (ended / reset), so this only needs to log for diagnostics — never a raw error
 * to the user (CLAUDE.md §26). The ring/in-call UI reads the settled FSM state.
 */
function handleControlError(error: unknown, action: CallActionName): void {
  console.warn(`[call] ${action} failed`, error);
  // Exception (M18): a BLOCKED refusal is not a diagnostic — it is the answer to
  // what the user just tried, and it has no other surface (the FSM simply returns
  // to idle, so the call button would appear to do nothing). Route it to the
  // root-level notice with copy that never says which side blocked (§28).
  if (error instanceof ApiClientError && error.code === "BLOCKED") {
    notifyBlocked(action === "upgrade" ? "addMember" : "call");
  }
}

/**
 * THE diagnostic line for call connectivity (call-UX plan K2.7). One line per FSM
 * transition carrying the pair that identifies every "accepted but never
 * connected" variant: the call phase and the voice/media status at that instant.
 * `dropped` marks an action the reducer ignored — the failure mode this wave fixed,
 * and the one that used to leave no trace at all.
 *
 * Deliberately terse and low-volume (§27): call transitions happen a handful of
 * times per call, never per frame.
 */
function logCallTransition(t: CallTransition): void {
  console.info(
    `[call] ${t.action} ${t.from}→${t.to}${t.applied ? "" : " (dropped)"} voice=${t.voiceStatus ?? "?"} call=${t.callId ?? "-"}`,
  );
}

/**
 * Push the occupancy override to match the FSM surface. A group surface (post
 * upgrade, or a freshly-accepted group-target ring) announces its voice channel;
 * anything else clears it. Idempotent — only real changes reach the gateway.
 */
function syncOccupancyFromState(state: CallState): void {
  const next: ChannelId | null =
    state.surface?.kind === "group" ? state.surface.voiceChannelId : null;
  if (next === announcedOccupancy) return;
  announcedOccupancy = next;
  setCallOccupancyChannel(next);
}

/**
 * The engine's roomId as of the previous voice-store notification, so we can tell
 * "we were in the call's room and are not any more" from "we were never in it"
 * (the latter is the normal `outgoing` → join window, which must NOT retire).
 */
let lastVoiceRoomId: string | null = null;

/**
 * Keep the call FSM honest about MEDIA (call-UX plan K2.4).
 *
 * Three distinct endings arrive through the voice FSM rather than through a
 * `call.*` event, and before this only the first was handled — the other two left
 * a phantom `active` call that `isCallLive` used to refuse every new call with
 * (the founder's "çıkıp o kişiyi tekrar aramak zorunda kalıyorum"):
 *
 *  1. Post-upgrade GROUP surface, user leaves via the normal voice UI → engine
 *     idle → retire the slot (unchanged behavior).
 *  2. Engine `error` on the CALL's own room (server unavailable, failed reconnect,
 *     dead transport). Media is gone and is not coming back → end the call on both
 *     planes so the peer stops staring at a dead room.
 *  3. Engine back to `idle` after having been in the call's room, with no `call.*`
 *     terminal (Leave pressed while in a DM call, an eviction we did not attribute).
 *
 * Registered once for the app lifetime; a no-op whenever no call is live.
 */
useVoiceStore.subscribe((s) => {
  const previousRoomId = lastVoiceRoomId;
  lastVoiceRoomId = s.roomId;

  const current = controller?.getState();
  if (!current) return;

  // The decision lives in client-core so the two platforms cannot drift. It used
  // to be spelled out here AND again in the mobile store; today a DTO written
  // twice in parallel is exactly what shipped a resync that would have hung up
  // the call it was healing. One copy, two callers.
  const outcome = decideCallMediaOutcome({
    call: current,
    voice: { status: s.status, roomId: s.roomId, endedReason: s.endedReason ?? null },
    previousRoomId,
  });
  if (outcome === "dismiss") controller?.dismiss();
  else if (outcome === "report_failure") controller?.reportMediaFailure();
});

/**
 * (Re)create the controller for the signed-in user. Disposes any prior instance
 * first, so switching accounts never carries a stale `currentUserId`.
 */
export function initCallController(currentUserId: UserId): CallController {
  disposeCallController();
  const created = createCallController({
    api,
    engine: callEngine,
    currentUserId,
    onError: handleControlError,
    getVoiceStatus: () => useVoiceStore.getState().status,
    onTransition: logCallTransition,
    /**
     * "Is anyone else still in this room?" — the only input to the last-one-out
     * rule (ADR 0023 §2), read from the media plane the engine mirrors rather
     * than from any server ledger. `isLocal` is the engine's own flag, so the
     * count is remote people, not track publishers.
     *
     * Returns null while the engine is in a DIFFERENT room (or none): the
     * controller must never mistake a server voice channel's occupancy for the
     * call's, and an unknown answer keeps the call alive rather than ending it.
     */
    getRemoteParticipantCount: () => {
      const call = controller?.getState();
      const voice = useVoiceStore.getState();
      if (!call?.roomName || voice.roomId !== call.roomName) return null;
      return voice.participants.filter((p) => !p.isLocal).length;
    },
  });
  created.subscribe(syncOccupancyFromState);
  controller = created;
  return created;
}

/** The live controller, or null before login / after logout. */
export function getCallController(): CallController | null {
  return controller;
}

/** Tear down the controller (logout / unmount): release the ring timer + occupancy. */
export function disposeCallController(): void {
  controller?.dispose();
  controller = null;
  if (announcedOccupancy !== null) {
    announcedOccupancy = null;
    setCallOccupancyChannel(null);
  }
}

/**
 * React binding for the call FSM (ADR 0002 — bind the shared subscribable store
 * with `useSyncExternalStore`). Returns the idle state before the controller
 * exists, so components mount safely on the login screen.
 */
export function useCallState(): CallState {
  return useSyncExternalStore(
    (onChange) => controller?.subscribe(onChange) ?? (() => undefined),
    () => controller?.getState() ?? initialCallState,
    () => initialCallState,
  );
}
