/**
 * UI sound cue gate (sfx-refresh) — the ONE throttle + cross-cue arbiter both
 * clients' sound managers run, so a cue is dropped on desktop exactly when it is
 * dropped on mobile. Pure: no audio, no clock of its own (the caller passes
 * `now`), generic over the cue name so each platform keeps its own `UiSound`.
 */

/** Drop a cue when one of `after` played within the last `windowMs`. */
export interface CueSuppressionRule {
  after: readonly string[];
  windowMs: number;
}

/** Same cue re-triggered within this window is dropped (store-update bursts). */
export const CUE_THROTTLE_MS = 100;

/**
 * Cues that would only repeat what an earlier cue already said:
 *  - call-ended after peer-left-call: the other side hung up — the voice roster
 *    cue already told you; the call FSM's ended{hung_up} would repeat it.
 *  - unmute after undeafen: unmuting while deafened undeafens first (engine) —
 *    one gesture, one cue.
 *  - mute after deafen: deafening mutes the mic in the same breath.
 *  - error after error: the voice store and the call FSM can both report the
 *    same failure.
 */
export const CUE_SUPPRESSION_RULES: Readonly<Record<string, CueSuppressionRule>> = {
  "call-ended": { after: ["peer-left-call"], windowMs: 2500 },
  unmute: { after: ["undeafen"], windowMs: 400 },
  mute: { after: ["deafen"], windowMs: 400 },
  error: { after: ["error"], windowMs: 1500 },
};

export interface CueGate<Name extends string> {
  /**
   * True when `name` may play at `now` — and, if so, RECORDS it as played (so a
   * later rule can see it). False when throttled or suppressed by a rule.
   */
  admit(name: Name, now: number): boolean;
}

export function createCueGate<Name extends string>(
  rules: Readonly<Record<string, CueSuppressionRule>> = CUE_SUPPRESSION_RULES,
  throttleMs: number = CUE_THROTTLE_MS,
): CueGate<Name> {
  const lastPlayedAt = new Map<string, number>();
  const within = (name: string, now: number, windowMs: number): boolean => {
    const at = lastPlayedAt.get(name);
    return at !== undefined && now - at < windowMs;
  };
  return {
    admit(name, now) {
      if (within(name, now, throttleMs)) return false;
      const rule = rules[name];
      if (rule && rule.after.some((other) => within(other, now, rule.windowMs))) return false;
      lastPlayedAt.set(name, now);
      return true;
    },
  };
}
