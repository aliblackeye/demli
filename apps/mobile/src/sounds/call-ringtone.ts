/**
 * Call phase → ringtone, wired purely through the call controller's subscription.
 * The mobile analog of the desktop renderer's CallLayer ring effect
 * (`phase === "incoming" → startRingtone("incoming")`, etc.), but as a
 * framework-free side-effect module — the same shape as voice-sounds.ts — so the
 * ring reacts globally no matter which screen is mounted, and the call FSM stays
 * sound-free (CLAUDE.md §23: media/sound lifecycle separate from UI).
 *
 * Imported once for its side effect from app/_layout.tsx (next to voice-sounds).
 *
 *   incoming → looping incoming ring   (callee is ringing)
 *   outgoing → looping outgoing ringback (caller is ringing)
 *   anything else (active / ended / idle) → stop
 *
 * So accept, decline, cancel, hang-up, ring timeout, and eviction all silence the
 * ring the moment the phase leaves ringing — no leak. Acting only on a phase
 * CHANGE keeps it cheap (the controller also notifies on `pending` flips).
 */
import { getCallController, subscribeCallState } from "@/stores/call-store";
import type { CallState } from "@demli/client-core";
import { startRingtone, stopRingtone } from "./ringtone";

let lastPhase: CallState["phase"] = getCallController().getState().phase;

subscribeCallState((state) => {
  if (state.phase === lastPhase) return;
  lastPhase = state.phase;
  if (state.phase === "incoming") startRingtone("incoming");
  else if (state.phase === "outgoing") startRingtone("outgoing");
  else stopRingtone();
});
