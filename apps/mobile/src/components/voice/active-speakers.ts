import { useSyncExternalStore } from "react";
import {
  createActiveSpeakerTracker,
  EMPTY_ACTIVE_SPEAKERS,
  type ActiveSpeakerSnapshot,
} from "@demli/media";
import { useVoiceStore } from "@/stores/voice-store";

/**
 * The mobile app's ONE active-speaker tracker (call-ux-plan K3/K5).
 *
 * The tracker itself is the pure, shared model in `@demli/media`
 * (`active-speaker.ts`); this file is the single place that binds it to the live
 * voice store and hands the result to React. One module-level instance — not one
 * per component — so the OS-PiP window, the screen-share filmstrip picker, and
 * anything added later all answer "who is talking" IDENTICALLY. Two components
 * each running their own tracker would drift (different mount times → different
 * hysteresis phase) and reintroduce exactly the divergence this replaces.
 *
 * Two things this binding has to get right:
 *
 *  - Speaking flags are EVENTS, not a poll. The SFU pushes
 *    `ActiveSpeakersChanged`, so a participant can start talking and produce no
 *    further event for seconds. A tracker driven only by store updates would
 *    never commit the 300 ms attack. So after every push we ask the tracker for
 *    its next deadline and schedule a single `tick` for it — one timer, only
 *    while a transition is actually pending, cleared as soon as it settles.
 *  - A media track is not React state (§27). The store's `participants` array is
 *    referentially stable across no-op speaking ticks and the tracker returns the
 *    SAME snapshot object when nothing moved, so subscribers only rerender when
 *    the answer genuinely changes.
 */
const tracker = createActiveSpeakerTracker();

let snapshot: ActiveSpeakerSnapshot = EMPTY_ACTIVE_SPEAKERS;
const listeners = new Set<() => void>();
let unsubscribeStore: (() => void) | null = null;
let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

function emit(next: ActiveSpeakerSnapshot): void {
  if (next === snapshot) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function clearDeadline(): void {
  if (deadlineTimer === null) return;
  clearTimeout(deadlineTimer);
  deadlineTimer = null;
}

/** Arm a single timer for the tracker's next pending attack/release commit. */
function scheduleDeadline(): void {
  clearDeadline();
  const remaining = tracker.nextDeadlineMs(Date.now());
  if (remaining === null) return;
  deadlineTimer = setTimeout(() => {
    deadlineTimer = null;
    emit(tracker.tick(Date.now()));
    // A commit can expose the NEXT pending transition (someone else mid-attack).
    scheduleDeadline();
  }, remaining);
}

function pushParticipants(): void {
  const { participants, status } = useVoiceStore.getState();
  // Leaving a room must not leave a stale "last speaker" behind for the next
  // session — an idle/error status means there is no room to track.
  if (status === "idle" || status === "error" || participants.length === 0) {
    tracker.reset();
    clearDeadline();
    emit(tracker.snapshot);
    return;
  }
  // Feed EVERYONE including the local user: consumers exclude self by simply not
  // offering themselves as a candidate, and "am I the one talking" is useful to
  // surfaces that do want it.
  emit(
    tracker.push(
      participants.map((p) => ({ identity: p.identity, speaking: p.speaking })),
      Date.now(),
    ),
  );
  scheduleDeadline();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (unsubscribeStore === null) {
    unsubscribeStore = useVoiceStore.subscribe(pushParticipants);
    // Seed from the current room so a late-mounting consumer is not blind until
    // the next speaking tick.
    pushParticipants();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    unsubscribeStore?.();
    unsubscribeStore = null;
    clearDeadline();
    tracker.reset();
    snapshot = tracker.snapshot;
  };
}

function getSnapshot(): ActiveSpeakerSnapshot {
  return snapshot;
}

/**
 * The live active-speaker snapshot (recency-ordered talkers + remembered last
 * speaker). Resolve it against a surface's own candidates with
 * `pickSpeakingSubject` from `@demli/media`.
 */
export function useActiveSpeakers(): ActiveSpeakerSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
