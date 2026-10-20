/**
 * Shared DM-call client core (ADR 0012 / plan Wave 5): the pure call FSM plus the
 * framework-free controller that drives it against the api client + media engine.
 * Consumed by desktop (Wave 6) and mobile (Wave 7) UI, which wrap it in their own
 * platform store (zustand/TanStack) and bind the store with `useSyncExternalStore`.
 */

export {
  callEndedMessage,
  callReducer,
  hasPendingInvite,
  initialCallState,
  isCallActive,
  isCallLive,
  isCallRinging,
  isCallSeatedAway,
} from "./call-state.js";
export type {
  CallAction,
  CallEndedReason,
  CallPhase,
  CallRole,
  CallSeat,
  CallState,
  CallSurface,
  PendingInvite,
} from "./call-state.js";

export {
  createCallEngineAdapter,
  decideCallMediaOutcome,
  isVoiceLive,
  watchCallMedia,
  DEFAULT_LEAVING_WAIT_MS,
} from "./voice-bridge.js";
export type {
  CallEngineAdapterDeps,
  CallMediaDecisionInput,
  CallMediaOutcome,
  CallMediaWatcherDeps,
  VoiceSnapshot,
} from "./voice-bridge.js";

export { CALL_ROOM_PREFIX, callTransitionCue, isCallRoomId } from "./call-cues.js";
export type { CallCue } from "./call-cues.js";

export { createCallController, DEFAULT_RING_TIMEOUT_MS } from "./call-controller.js";
export type {
  CallActionName,
  CallApi,
  CallController,
  CallControllerDeps,
  CallResyncTrigger,
  CallTransition,
  CallVoiceEngine,
} from "./call-controller.js";
