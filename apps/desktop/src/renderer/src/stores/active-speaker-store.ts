/**
 * The renderer's ONE binding of the shared {@link ActiveSpeakerTracker} to the
 * live voice roster (ADR 0022 §3: "aktif-konuşan seçimi tek modüldür").
 *
 * The tracker itself is pure and lives in `@demli/media` — it holds the 300 ms
 * attack / 5 s release hysteresis and the last-speaker memory. This module is the
 * platform half it cannot own: pumping it from the voice store, driving its
 * pending deadlines with a timer, and handing React a referentially-stable
 * snapshot.
 *
 * WHY A TIMER IS REQUIRED. Speaking arrives as EVENTS: a participant can start
 * talking and produce no further roster change for seconds. Without a scheduled
 * tick the attack would only commit on the NEXT unrelated event, so a lone
 * speaker in a quiet room might never enter the filmstrip. The tracker exposes
 * `nextDeadlineMs` precisely so a single timer can be armed for the earliest
 * pending transition, and nothing polls (§27) — a settled room arms no timer at all.
 *
 * OUTSIDE the voice store on purpose: this is derived view state, and the voice
 * store is documented as a thin mirror of the engine's VoiceState with no ad-hoc
 * view booleans (§11).
 */

import { useSyncExternalStore } from "react";
import {
  createActiveSpeakerTracker,
  EMPTY_ACTIVE_SPEAKERS,
  type ActiveSpeakerSnapshot,
} from "@demli/media";
import { useVoiceStore } from "./voice-store";

const tracker = createActiveSpeakerTracker();

let snapshot: ActiveSpeakerSnapshot = EMPTY_ACTIVE_SPEAKERS;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

/** The room we last pumped, so leaving one clears the other room's memory. */
let currentRoomId: string | null = null;

function emit(next: ActiveSpeakerSnapshot): void {
  // The tracker hands back the SAME object when nothing moved, so an idle
  // speaking tick costs zero renders.
  if (next === snapshot) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function arm(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  const delay = tracker.nextDeadlineMs(Date.now());
  if (delay === null) return;
  timer = setTimeout(() => {
    timer = null;
    emit(tracker.tick(Date.now()));
    // A commit can leave ANOTHER transition pending (two people flipping at
    // different times), so re-arm from the tracker rather than assuming settled.
    arm();
  }, delay);
}

function pump(): void {
  const { participants, roomId, status } = useVoiceStore.getState();

  // Leaving a room (or landing in a different one) must not carry the previous
  // room's last-speaker memory into the next call's first frame.
  if (roomId !== currentRoomId) {
    currentRoomId = roomId;
    tracker.reset();
  }
  if (status === "idle" || participants.length === 0) {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    tracker.reset();
    emit(EMPTY_ACTIVE_SPEAKERS);
    return;
  }

  emit(
    tracker.push(
      participants.map((p) => ({ identity: p.identity, speaking: p.speaking })),
      Date.now(),
    ),
  );
  arm();
}

useVoiceStore.subscribe(pump);

/**
 * The committed speaking snapshot: who is talking, who talked recently (the
 * filmstrip membership set), and the remembered last speaker. Recency-ordered.
 */
export function useActiveSpeakers(): ActiveSpeakerSnapshot {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
    () => snapshot,
  );
}

/** Test/diagnostic seam: the current snapshot without subscribing. */
export function getActiveSpeakers(): ActiveSpeakerSnapshot {
  return snapshot;
}
