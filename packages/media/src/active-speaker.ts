/**
 * ActiveSpeakerTracker — the SINGLE source of truth for "who is talking".
 *
 * Why this exists (call-ux-plan-2026-07-30, K3/K5): every surface that has to
 * answer "whose video do we show?" had grown its OWN ad-hoc picker —
 * `remoteCameras.find(speaking) ?? remoteCameras[0]` in the mobile OS-PiP
 * controller, `tiles.find(speaking) ?? sharer` in `ScreenShareStage`. Two
 * pickers, two behaviors, and both had the same two defects:
 *
 *  1. NO MEMORY. `speaking` is a momentary flag, so the instant everyone paused
 *     the picker fell back to "the first item in the list" — not the person who
 *     was just talking. That is the founder's report: "karşımdaki o an kim
 *     konuşuyorsa onun kamerasını göremiyorum".
 *  2. NO HYSTERESIS. Every syllable gap flipped the subject, so the window
 *     ping-ponged between people mid-conversation.
 *
 * This module is the pure core that fixes both, once, for every surface. It is
 * livekit-free and DOM-free (RN-safe like the rest of this package's root) and
 * driven by explicit `(samples, nowMs)` pushes, so it unit-tests with a fake
 * clock — the same shape as {@link ./speaking.ts}'s local detector.
 *
 * Model: each participant has a committed "recently active" state with a fast
 * ATTACK (needs `attackMs` of sustained speech to enter — a cough or a single
 * "hm" never steals the stage) and a slow RELEASE (stays for `releaseMs` after
 * they go quiet — bridges the natural gaps between sentences). On top of that,
 * `lastSpeaker` remembers the freshest talker INDEFINITELY, so a fully silent
 * room still has a sensible subject instead of collapsing to "list item 0".
 *
 * Consumers (mobile OS PiP, the screen-share filmstrip picker, and the desktop
 * speaker filmstrip in a later wave) read the snapshot and resolve it against
 * their own candidate list with {@link pickSpeakingSubject}; the priority chain
 * (screen share > camera > self, etc.) stays at the call site because it is
 * surface-specific, while "who is talking" lives only here.
 */

/** One participant's momentary speaking flag, as reported by the SFU/engine. */
export interface ActiveSpeakerSample {
  identity: string;
  speaking: boolean;
}

/** The committed view of the room's talking state. Arrays are recency-ordered. */
export interface ActiveSpeakerSnapshot {
  /**
   * Identities that are committed active AND still raw-speaking right now —
   * "who is talking at this instant", freshest first. Empty in a silent room.
   */
  readonly speaking: readonly string[];
  /**
   * Identities that spoke recently enough to still count (committed active,
   * i.e. inside the release window), freshest first, capped at `maxRecent`.
   * This is the filmstrip membership set (K3).
   */
  readonly recent: readonly string[];
  /**
   * The freshest talker, remembered even after they fall out of `recent`. Only
   * cleared when that participant leaves the room (or on {@link
   * ActiveSpeakerTracker.reset}). This is what keeps a silent room's video
   * subject stable instead of snapping back to the first list entry.
   */
  readonly lastSpeaker: string | null;
  /**
   * The single best subject: currently talking, else most recently talking,
   * else the remembered last speaker. `null` only when nobody has ever spoken.
   */
  readonly primary: string | null;
}

export interface ActiveSpeakerTrackerOptions {
  /** Sustained speech (ms) before a participant counts as active. Default 300. */
  attackMs?: number;
  /** Silence (ms) before an active participant is released. Default 5000. */
  releaseMs?: number;
  /** Ceiling on `recent` (the conditional-tile budget, K3). Default 5. */
  maxRecent?: number;
}

export interface ActiveSpeakerTracker {
  /** The current committed snapshot (no side effects). */
  readonly snapshot: ActiveSpeakerSnapshot;
  /**
   * Feed the room's speaking flags observed at `nowMs`. Identities MISSING from
   * `samples` are treated as gone from the room and dropped (including from
   * `lastSpeaker`) — a snapshot must never point at someone who left.
   */
  push(samples: readonly ActiveSpeakerSample[], nowMs: number): ActiveSpeakerSnapshot;
  /**
   * Re-evaluate pending attack/release timers at `nowMs` without new flags.
   * Needed because speaking flags arrive as EVENTS: someone can start talking
   * and produce no further event for seconds, so the attack must be committed by
   * a timer rather than by the next event. Drive it with
   * {@link ActiveSpeakerTracker.nextDeadlineMs}.
   */
  tick(nowMs: number): ActiveSpeakerSnapshot;
  /**
   * Milliseconds until the next state change would commit, or null when the
   * tracker is settled (nothing pending). Never negative.
   */
  nextDeadlineMs(nowMs: number): number | null;
  /** Forget everything (leaving a room / new session). */
  reset(): void;
}

/**
 * 300 ms of sustained speech to take the stage. Long enough that a cough, a
 * keyboard bump, or a one-syllable "ha" does not move the video subject; short
 * enough that a real sentence claims it before the speaker notices.
 */
export const DEFAULT_ACTIVE_SPEAKER_ATTACK_MS = 300;
/**
 * 5 s of silence before release. Sentence gaps are ~0.5-1.5 s, so this holds the
 * subject across a whole thought instead of strobing between participants — the
 * "titreme yok" requirement in K3.
 */
export const DEFAULT_ACTIVE_SPEAKER_RELEASE_MS = 5000;
/** At most 5 conditional tiles in a filmstrip (K3's tavan). */
export const DEFAULT_ACTIVE_SPEAKER_MAX_RECENT = 5;

/** The settled snapshot of a room where nobody has spoken. */
export const EMPTY_ACTIVE_SPEAKERS: ActiveSpeakerSnapshot = Object.freeze({
  speaking: Object.freeze([] as readonly string[]),
  recent: Object.freeze([] as readonly string[]),
  lastSpeaker: null,
  primary: null,
});

interface SpeakerRow {
  /** The last raw flag we were told. */
  raw: boolean;
  /** Committed "recently active" (post attack/release). */
  active: boolean;
  /** When `raw` started disagreeing with `active`; null when settled. */
  pendingSince: number | null;
  /** Last ms at which this row was both committed active and raw-speaking. */
  activeAt: number;
  /** Insertion order, the tie-breaker for equal `activeAt`. */
  seq: number;
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

export function createActiveSpeakerTracker(
  options: ActiveSpeakerTrackerOptions = {},
): ActiveSpeakerTracker {
  const attackMs = options.attackMs ?? DEFAULT_ACTIVE_SPEAKER_ATTACK_MS;
  const releaseMs = options.releaseMs ?? DEFAULT_ACTIVE_SPEAKER_RELEASE_MS;
  const maxRecent = options.maxRecent ?? DEFAULT_ACTIVE_SPEAKER_MAX_RECENT;

  const rows = new Map<string, SpeakerRow>();
  let seqCounter = 0;
  let lastSpeaker: string | null = null;
  let snapshot: ActiveSpeakerSnapshot = EMPTY_ACTIVE_SPEAKERS;

  /** Commit pending attack/release transitions that have matured by `nowMs`. */
  function evaluate(nowMs: number): void {
    for (const [identity, row] of rows) {
      if (row.raw === row.active) {
        // Settled — cancel any in-progress flip.
        row.pendingSince = null;
      } else {
        if (row.pendingSince === null) row.pendingSince = nowMs;
        const delay = row.raw ? attackMs : releaseMs;
        if (nowMs - row.pendingSince >= delay) {
          row.active = row.raw;
          row.pendingSince = null;
        }
      }
      // Keep recency fresh for whoever is committed AND still talking, so the
      // ordering follows the conversation rather than who started first.
      if (row.active && row.raw) {
        row.activeAt = nowMs;
        lastSpeaker = identity;
      }
    }
  }

  function build(): ActiveSpeakerSnapshot {
    const active: Array<{ identity: string; row: SpeakerRow }> = [];
    for (const [identity, row] of rows) if (row.active) active.push({ identity, row });
    active.sort((a, b) => b.row.activeAt - a.row.activeAt || a.row.seq - b.row.seq);

    const speaking: string[] = [];
    const recent: string[] = [];
    for (const entry of active) {
      if (entry.row.raw) speaking.push(entry.identity);
      if (recent.length < maxRecent) recent.push(entry.identity);
    }
    const primary = speaking[0] ?? recent[0] ?? lastSpeaker;

    // Referential stability (§27): hand back the SAME object when nothing moved,
    // so `useSyncExternalStore` consumers don't rerender on no-op speaking ticks.
    if (
      sameOrder(speaking, snapshot.speaking) &&
      sameOrder(recent, snapshot.recent) &&
      lastSpeaker === snapshot.lastSpeaker &&
      (primary ?? null) === snapshot.primary
    ) {
      return snapshot;
    }
    snapshot = {
      speaking,
      recent,
      lastSpeaker,
      primary: primary ?? null,
    };
    return snapshot;
  }

  return {
    get snapshot(): ActiveSpeakerSnapshot {
      return snapshot;
    },
    push(samples: readonly ActiveSpeakerSample[], nowMs: number): ActiveSpeakerSnapshot {
      const seen = new Set<string>();
      for (const sample of samples) {
        if (!sample.identity) continue;
        seen.add(sample.identity);
        const row = rows.get(sample.identity);
        if (row) {
          row.raw = sample.speaking;
        } else {
          seqCounter += 1;
          rows.set(sample.identity, {
            raw: sample.speaking,
            active: false,
            pendingSince: null,
            activeAt: 0,
            seq: seqCounter,
          });
        }
      }
      for (const identity of [...rows.keys()]) {
        if (seen.has(identity)) continue;
        rows.delete(identity);
        // Never remember someone who is no longer in the room — a stale
        // `lastSpeaker` would keep a departed participant as the video subject.
        if (lastSpeaker === identity) lastSpeaker = null;
      }
      evaluate(nowMs);
      return build();
    },
    tick(nowMs: number): ActiveSpeakerSnapshot {
      evaluate(nowMs);
      return build();
    },
    nextDeadlineMs(nowMs: number): number | null {
      let soonest: number | null = null;
      for (const row of rows.values()) {
        if (row.pendingSince === null || row.raw === row.active) continue;
        const delay = row.raw ? attackMs : releaseMs;
        const remaining = Math.max(0, row.pendingSince + delay - nowMs);
        if (soonest === null || remaining < soonest) soonest = remaining;
      }
      return soonest;
    },
    reset(): void {
      rows.clear();
      seqCounter = 0;
      lastSpeaker = null;
      snapshot = EMPTY_ACTIVE_SPEAKERS;
    },
  };
}

/**
 * Resolve a tracker snapshot against a surface's own candidate list: the
 * talking candidate if one is present, else the most recently talking one, else
 * the remembered last speaker. Returns `null` when NO candidate matches, so the
 * caller applies its own surface-specific fallback (the sharer, the first remote
 * camera, the self camera...) — the priority chain belongs to the surface, the
 * "who is talking" answer belongs to the tracker.
 *
 * Candidates the snapshot does not know about are simply never picked, which is
 * what makes this safe to call with any subset (only-cameras-on, only-sharers).
 */
export function pickSpeakingSubject<T extends { identity: string }>(
  candidates: readonly T[],
  snapshot: Pick<ActiveSpeakerSnapshot, "speaking" | "recent" | "lastSpeaker">,
): T | null {
  if (candidates.length === 0) return null;
  for (const identity of snapshot.speaking) {
    const hit = candidates.find((candidate) => candidate.identity === identity);
    if (hit) return hit;
  }
  for (const identity of snapshot.recent) {
    const hit = candidates.find((candidate) => candidate.identity === identity);
    if (hit) return hit;
  }
  if (snapshot.lastSpeaker !== null) {
    const hit = candidates.find((candidate) => candidate.identity === snapshot.lastSpeaker);
    if (hit) return hit;
  }
  return null;
}
