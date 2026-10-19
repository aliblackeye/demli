/**
 * Ordering guard between expo-audio's `setAudioModeAsync` and the LiveKit call
 * audio session (M16 · 1D).
 *
 * On Android `setAudioModeAsync` always rewrites `AudioManager.mode` and the
 * speakerphone route (expo-audio AudioModule.kt: MODE_NORMAL + speaker on unless
 * `shouldRouteThroughEarpiece`). During a call that silently knocks the session
 * out of MODE_IN_COMMUNICATION — the mode the platform echo canceller is bound
 * to — and forces the loudspeaker. So:
 *
 *  1. A mode change is REFUSED while a voice session is joining / connected /
 *     reconnecting, or while the room adapter owns the call audio session. The
 *     caller keeps the ambient mode and may retry after the call.
 *  2. The adapter calls {@link acquireCallAudio} before it configures LiveKit,
 *     which waits for a mode change already in flight, so the LiveKit session is
 *     always the LAST writer.
 *  3. If that wait times out and the change lands while the call owns the
 *     session, the adapter's re-assert hook runs right after it.
 *
 * Ownership is a LEASE: a new call's acquire replaces the previous one, and a
 * release only ends the lease it was given. An old room whose teardown settles
 * after the next call connected therefore cannot unlock the guard for that call.
 *
 * Pure module (no native imports) so the ordering is unit-tested.
 */

/** A mode change to run, e.g. `() => setAudioModeAsync({...})`. */
export type AudioModeChange = () => Promise<unknown>;

/** Re-applies the LiveKit call audio session after a late mode change. */
export type CallAudioReassert = () => Promise<void>;

/** Voice statuses in which a room holds (or is about to hold) the audio session. */
const SESSION_STATUSES: ReadonlySet<string> = new Set(["joining", "connected", "reconnecting"]);

/** Default upper bound on how long a connect waits for an in-flight mode change. */
export const ACQUIRE_WAIT_MS = 1_500;

/** Proof of ownership handed to the call that acquired the session. */
export type CallAudioLease = { readonly reassert: CallAudioReassert };

let voiceSessionProbe: () => boolean = () => false;
let lease: CallAudioLease | null = null;
let inFlight: { settled: Promise<void>; done: boolean } | null = null;
/** Set when a connect stopped waiting for an in-flight change (it timed out). */
let reassertOnSettle = false;

/** True for a voice status in which `setAudioModeAsync` must not run. */
export function isVoiceSessionStatus(status: string): boolean {
  return SESSION_STATUSES.has(status);
}

/** Register the live voice-status read (voice-sounds.ts wires the voice store). */
export function setVoiceSessionProbe(probe: () => boolean): void {
  voiceSessionProbe = probe;
}

/** Whether a call currently owns, or is acquiring, the device audio session. */
export function isCallAudioActive(): boolean {
  return lease !== null || voiceSessionProbe();
}

/**
 * Run an expo-audio mode change unless a call owns the audio session.
 * Resolves `true` when the change ran, `false` when it was refused. Rejects with
 * the change's own error.
 */
export async function runAudioModeChange(change: AudioModeChange): Promise<boolean> {
  if (isCallAudioActive()) return false;
  const run = (async () => {
    await change();
  })();
  const tracked = {
    done: false,
    settled: run.then(
      () => undefined,
      () => undefined,
    ),
  };
  void tracked.settled.then(() => {
    tracked.done = true;
  });
  inFlight = tracked;
  try {
    await run;
  } finally {
    if (inFlight === tracked) inFlight = null;
    const owner = lease;
    if (reassertOnSettle && owner) {
      reassertOnSettle = false;
      await owner.reassert().catch(() => undefined);
    }
  }
  return true;
}

/**
 * Take the call audio session (call BEFORE configuring LiveKit) and wait — at
 * most `waitMs` — for a mode change that is already running. The returned lease
 * replaces any earlier one.
 */
export async function acquireCallAudio(
  reassert: CallAudioReassert,
  waitMs: number = ACQUIRE_WAIT_MS,
): Promise<CallAudioLease> {
  const mine: CallAudioLease = { reassert };
  lease = mine;
  const pending = inFlight;
  if (!pending) return mine;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    pending.settled,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (!pending.done && lease === mine) reassertOnSettle = true;
  return mine;
}

/**
 * End `held` once its LiveKit audio session has been stopped. A lease that a
 * later call already replaced is left alone.
 */
export function releaseCallAudio(held: CallAudioLease): void {
  if (lease !== held) return;
  lease = null;
  reassertOnSettle = false;
}

/** Test-only reset of the module state. */
export function resetAudioModeGuardForTests(): void {
  voiceSessionProbe = () => false;
  lease = null;
  inFlight = null;
  reassertOnSettle = false;
}
