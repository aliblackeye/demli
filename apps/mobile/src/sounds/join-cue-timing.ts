/**
 * Join-cue settle scheduler (mobile only) — the fix for the founder's "the join
 * sound comes out broken" report.
 *
 * ROOT CAUSE: the LiveKit RN adapter (media/livekit-room.ts) flips Android's
 * audio session to the VoIP profile (`MODE_IN_COMMUNICATION`, audioFocus=GAIN)
 * on `connect()`, and the voice FSM then publishes the mic right after it reaches
 * `connected`. The join cue used to play the instant status became `connected` —
 * i.e. squarely inside that connect + mic-acquire storm, when the audio HAL is
 * being reconfigured. Playing a media clip through a device mid-reconfiguration
 * is exactly what produced the crackled / clipped / cut-off beep. Mute/unmute
 * and message cues never sounded broken because they fire once the session has
 * long settled.
 *
 * FIX: don't play the join cue at the transition — arm a short timer and play it
 * a beat later, once the session has settled. If the user leaves (or the join is
 * abandoned) before the timer fires, cancel it so no stray beep escapes after
 * we have already left. Kept as a tiny, dependency-free unit so the timing rule
 * is unit-tested without pulling native `expo-audio` into the test (the mobile
 * suite is pure-logic, node-env).
 *
 * This is deliberately mobile-only: desktop uses `HTMLAudioElement` with no
 * audio-mode switch, so its join cue is fine and stays immediate.
 */

/** Schedules the (delayed) join cue and cancels it on an early leave. */
export interface JoinCueScheduler {
  /** Arm the settle timer for a fresh join (call on `joining -> connected`). */
  arm(): void;
  /** Cancel a pending cue (call on any exit / new session). Safe when idle. */
  cancel(): void;
}

/**
 * @param playJoin fired once, `delayMs` after {@link JoinCueScheduler.arm}, unless
 *   cancelled first.
 * @param delayMs settle window after `connected` before the cue plays.
 */
export function createJoinCueScheduler(playJoin: () => void, delayMs: number): JoinCueScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;

  function cancel(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return {
    arm() {
      // Re-arming (e.g. a room switch) restarts the settle window from scratch.
      cancel();
      timer = setTimeout(() => {
        timer = null;
        playJoin();
      }, delayMs);
    },
    cancel,
  };
}
