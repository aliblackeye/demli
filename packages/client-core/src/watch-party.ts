/**
 * Pure client model for Watch Party (M20, ADR 0016) — no React, no DOM.
 *
 * The server is the only authority on "which video, where, playing or not, and
 * who is driving" (`apps/realtime/src/watch-party.ts`). This module holds the
 * three decisions the CLIENT has to make on its own, all of them pure and all of
 * them tested:
 *
 *  1. **Where should my player be right now** — projecting the server's
 *     `positionSec` forward from the instant it was stated ({@link expectedPositionSec}).
 *  2. **Should I seek** — the drift rule plus the hysteresis that stops a seek
 *     loop ({@link nextSeekDecision}). Ads are the reason this is not a plain
 *     comparison; see that function.
 *  3. **May I show controls** — host or server owner, and nothing else
 *     ({@link watchControlMode}).
 *
 * Plus the client-side half of the link grammar ({@link validateWatchLink}) and
 * the ONE place an embed URL is built ({@link buildEmbedUrl}), so no component
 * ever concatenates a YouTube URL by hand.
 *
 * ## Why this lives in client-core rather than next to a player
 *
 * Every constant below is a number two DIFFERENT machines have to agree on. If
 * desktop tolerated 2 s of drift and mobile 1.5 s, the phone would seek to a
 * position the laptop considers correct, the laptop would leave it alone, and the
 * phone would keep correcting — two members of the same room fighting over a
 * playhead. The same goes for the quiet period (a shorter one on either surface
 * re-introduces the seek loop the hysteresis exists to prevent) and for the
 * backoff ladder (a surface that does not back off re-seeks through every ad).
 * So there is one copy, imported by every renderer; the transport around it —
 * iframe on desktop/web, WebView on mobile — is the only part that differs.
 */

import {
  WATCH_DRIFT_TOLERANCE_SECONDS,
  parseYouTubeVideoId,
  isYouTubeVideoId,
} from "@demli/config";
import type { WatchSessionStatePayload, WatchSource } from "@demli/protocol";
import type { ChannelId, UserId } from "@demli/types";

// ---------------------------------------------------------------------------
// The embed origin — the ONLY host this feature ever frames
// ---------------------------------------------------------------------------

/**
 * The privacy-preserving embed origin. Hardcoded, and deliberately duplicated as
 * a literal in the two CSP `frame-src` directives (desktop
 * `electron.vite.config.ts`, web `Caddyfile`) — three copies that a reviewer can
 * diff by eye beats one that is assembled at runtime and therefore unreviewable.
 *
 * `postMessage` targetOrigin and the `message` event's origin check both use
 * this exact string, so a frame from anywhere else is neither talked to nor
 * listened to.
 */
export const YOUTUBE_EMBED_ORIGIN = "https://www.youtube-nocookie.com";

// ---------------------------------------------------------------------------
// Session view model
// ---------------------------------------------------------------------------

/**
 * A live session as the CLIENT holds it: the server's snapshot plus the local
 * clock reading of when it arrived.
 *
 * `receivedAtMs` exists because `serverTime` alone cannot be used to project the
 * playhead: the two machines' wall clocks can differ by minutes, and a client
 * whose clock is five minutes fast would compute a five-minute drift and seek
 * forever. So the elapsed time is measured LOCALLY (monotone-ish `Date.now`
 * deltas between two readings on the same machine) and `serverTime` is used only
 * for the one thing it is good for — a BOUNDED estimate of how long the frame
 * spent in flight (see {@link sessionFromPayload}).
 */
export interface WatchSession {
  channelId: ChannelId;
  hostId: UserId;
  source: WatchSource;
  /** Always the normalized 11-character id — the server never sends anything else. */
  videoId: string;
  /** Authoritative position at the moment the frame was stated. */
  positionSec: number;
  playing: boolean;
  /** Local `Date.now()` when this snapshot was applied. */
  receivedAtMs: number;
  /**
   * Estimated one-way travel time of the frame, in seconds, clamped to
   * [0, {@link MAX_LATENCY_COMPENSATION_SEC}]. Added to `positionSec` so a slow
   * link does not park everyone permanently behind the host.
   */
  latencySec: number;
}

/**
 * Upper bound on the latency compensation derived from `serverTime`. The raw
 * `receivedAt - serverTime` difference is clock SKEW plus travel time and we
 * cannot separate the two, so it is clamped: a real WS frame crosses in tens of
 * milliseconds, and anything larger is skew we must not believe. Half a second
 * is generous for the honest case and harmless for the dishonest one — it is
 * well inside {@link WATCH_DRIFT_TOLERANCE_SECONDS}, so a fully skewed clock can
 * never on its own push a client over the seek threshold.
 */
export const MAX_LATENCY_COMPENSATION_SEC = 0.5;

/** Build the client-side session view from a `watch.started` / `watch.state` frame. */
export function sessionFromPayload(
  payload: WatchSessionStatePayload,
  receivedAtMs: number,
): WatchSession {
  const statedAtMs = Date.parse(payload.serverTime);
  const rawLatencySec = Number.isFinite(statedAtMs) ? (receivedAtMs - statedAtMs) / 1000 : 0;
  return {
    channelId: payload.channelId,
    hostId: payload.hostId,
    source: payload.source,
    videoId: payload.videoId,
    positionSec: payload.positionSec,
    playing: payload.playing,
    receivedAtMs,
    latencySec: Math.min(Math.max(rawLatencySec, 0), MAX_LATENCY_COMPENSATION_SEC),
  };
}

/**
 * Where the video should be at `nowMs` on THIS machine.
 *
 * A playing session runs forward from the local instant the snapshot landed
 * (plus the bounded travel-time estimate); a paused one is frozen exactly where
 * the server left it. Never negative — a paused session at 0 is a real state and
 * a seek to a negative second is not.
 */
export function expectedPositionSec(session: WatchSession, nowMs: number): number {
  if (!session.playing) return Math.max(0, session.positionSec);
  const elapsedSec = Math.max(0, (nowMs - session.receivedAtMs) / 1000);
  return Math.max(0, session.positionSec + session.latencySec + elapsedSec);
}

// ---------------------------------------------------------------------------
// Drift correction with hysteresis
// ---------------------------------------------------------------------------

/**
 * Base quiet period after a seek WE issued. A seek is not instant: the player
 * reports the OLD `currentTime` for a few hundred milliseconds while it buffers
 * the new position, so a checker that re-measures immediately sees the same
 * drift it just corrected and seeks again — the classic seek loop. Three seconds
 * comfortably covers a buffer-and-resume on a slow connection while still being
 * shorter than the server's 5 s heartbeat, so a genuine correction is never
 * delayed by more than one tick.
 */
export const SEEK_COOLDOWN_MS = 3_000;

/**
 * Cap on the backoff multiplier. During a YouTube AD the player reports the
 * AD's timeline, not the video's, so the measured drift stays large and constant
 * for the whole ad break and no amount of seeking fixes it (ADR 0016 accepts
 * this: ads play per-viewer and cannot be removed on the free path). Backing the
 * cooldown off — 3 s, 6 s, 9 s, 12 s — means a 30-second ad costs a handful of
 * ignored corrections instead of one every heartbeat, and the counter resets the
 * moment a check lands inside tolerance, so the post-ad re-converge is immediate.
 */
export const SEEK_BACKOFF_MAX_STEPS = 4;

/** Hysteresis state carried between drift checks (one per player instance). */
export interface SeekHysteresis {
  /** `Date.now()` of the last seek we issued, or null if we have not seeked. */
  lastSeekAtMs: number | null;
  /** Consecutive corrections that have not yet converged (drives the backoff). */
  consecutiveSeeks: number;
}

export const initialSeekHysteresis: SeekHysteresis = {
  lastSeekAtMs: null,
  consecutiveSeeks: 0,
};

export interface SeekDecisionInput {
  /** Where the server says we should be (see {@link expectedPositionSec}). */
  expectedSec: number;
  /** Where our player actually is. */
  actualSec: number;
  /** Local clock reading for this check. */
  nowMs: number;
  hysteresis: SeekHysteresis;
  /** Override for tests; defaults to the shared `WATCH_DRIFT_TOLERANCE_SECONDS`. */
  toleranceSec?: number;
  /** Override for tests; defaults to {@link SEEK_COOLDOWN_MS}. */
  cooldownMs?: number;
}

export interface SeekDecision {
  /** The second to seek to, or null when the player should be left alone. */
  seekToSec: number | null;
  /** Hysteresis state to carry into the next check. */
  hysteresis: SeekHysteresis;
}

/**
 * Decide whether this drift check should move the playhead.
 *
 * Order matters. The cooldown is checked FIRST and does not touch the counter:
 * a check inside the quiet period is not evidence of anything (the player may
 * still be buffering the seek we just issued), so it must neither escalate the
 * backoff nor reset it.
 *
 * A check that lands within tolerance clears the backoff — that is the "we have
 * re-converged" signal, and it is what makes the post-ad recovery snap back to
 * the normal 3 s cadence.
 */
export function nextSeekDecision(input: SeekDecisionInput): SeekDecision {
  const tolerance = input.toleranceSec ?? WATCH_DRIFT_TOLERANCE_SECONDS;
  const baseCooldown = input.cooldownMs ?? SEEK_COOLDOWN_MS;
  const { hysteresis, nowMs } = input;

  if (hysteresis.lastSeekAtMs !== null) {
    const steps = Math.min(hysteresis.consecutiveSeeks, SEEK_BACKOFF_MAX_STEPS);
    const quietMs = baseCooldown * Math.max(1, steps);
    if (nowMs - hysteresis.lastSeekAtMs < quietMs) {
      return { seekToSec: null, hysteresis };
    }
  }

  const drift = Math.abs(input.expectedSec - input.actualSec);
  if (drift <= tolerance) {
    // In sync. Clear the backoff so the next genuine drift is corrected promptly.
    return {
      seekToSec: null,
      hysteresis:
        hysteresis.consecutiveSeeks === 0
          ? hysteresis
          : { lastSeekAtMs: hysteresis.lastSeekAtMs, consecutiveSeeks: 0 },
    };
  }

  return {
    seekToSec: input.expectedSec,
    hysteresis: {
      lastSeekAtMs: nowMs,
      consecutiveSeeks: hysteresis.consecutiveSeeks + 1,
    },
  };
}

// ---------------------------------------------------------------------------
// Who may drive
// ---------------------------------------------------------------------------

/**
 * What this user may do with a running session.
 *
 *  - `host`     — full transport controls (the native YouTube controls are
 *                 enabled and every change is broadcast).
 *  - `viewer`   — no transport controls at all. NOT disabled-with-a-tooltip:
 *                 §35 forbids a control that looks pressable and does nothing,
 *                 and the server would refuse the frame anyway (`NOT_HOST`).
 *                 The UI says who IS driving instead.
 */
export type WatchControlMode = "host" | "viewer";

export function watchControlMode(input: {
  session: WatchSession | null;
  userId: UserId | null;
  /** True when this user owns the server (the ADR's always-available override). */
  isOwner: boolean;
}): WatchControlMode {
  const { session, userId, isOwner } = input;
  if (!session || !userId) return "viewer";
  if (isOwner) return "host";
  return session.hostId === userId ? "host" : "viewer";
}

// ---------------------------------------------------------------------------
// Link validation (client half of the grammar)
// ---------------------------------------------------------------------------

export type WatchLinkResult =
  | { ok: true; videoId: string }
  | { ok: false; reason: "empty" | "invalid" };

/**
 * Pre-validate a pasted link with the SAME parser the gateway runs
 * (`parseYouTubeVideoId`, exported from `@demli/config` for exactly this).
 *
 * This is a UX affordance, NOT a security control: the server re-parses every
 * `videoRef` and only an 11-character id is ever stored or broadcast. Its whole
 * job is to say "that is not a YouTube link" the instant the user pastes it,
 * instead of after a WS round trip that comes back as a generic refusal.
 */
export function validateWatchLink(raw: string): WatchLinkResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  const videoId = parseYouTubeVideoId(trimmed);
  if (videoId === null) return { ok: false, reason: "invalid" };
  return { ok: true, videoId };
}

// ---------------------------------------------------------------------------
// Embed URL
// ---------------------------------------------------------------------------

export interface EmbedUrlInput {
  /** MUST already be a normalized id (server-sent). Re-checked here regardless. */
  videoId: string;
  /** Where to start playback, in whole seconds. */
  startSec: number;
  /**
   * Native YouTube controls. ON for the host — they drive with the real player
   * chrome and we mirror what they do (the player is never modified or hidden,
   * ADR 0016 / YouTube ToS). OFF for viewers, whose transport is the host's;
   * a viewer who could pause locally would simply be yanked back by the next
   * drift check, which is worse than not offering it.
   */
  controls: boolean;
}

/**
 * The one place an embed URL is built.
 *
 * Returns null when `videoId` is not a valid id. That branch should be
 * unreachable — the value comes from the server, which stores nothing else — but
 * "unreachable" is not a security argument: this string goes straight into an
 * iframe `src`, so it is re-checked against the shared pattern here too. A null
 * renders the error state, never a half-built URL.
 *
 * `enablejsapi=1` is what lets us drive the player over `postMessage` with NO
 * external script (`script-src 'self'` untouched — ADR 0016 §Security).
 * `origin` is deliberately NOT sent: the desktop renderer runs from `file://`,
 * whose serialized origin is "null", and handing YouTube that breaks the API
 * handshake outright.
 */
export function buildEmbedUrl(input: EmbedUrlInput): string | null {
  if (!isYouTubeVideoId(input.videoId)) return null;
  const start = Math.max(0, Math.floor(input.startSec));
  const params = new URLSearchParams({
    enablejsapi: "1",
    autoplay: "1",
    playsinline: "1",
    rel: "0",
    modestbranding: "1",
    controls: input.controls ? "1" : "0",
    disablekb: input.controls ? "0" : "1",
    start: String(start),
  });
  return `${YOUTUBE_EMBED_ORIGIN}/embed/${input.videoId}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Host → server: reading the host's own player
// ---------------------------------------------------------------------------

/**
 * How far the host's playhead may deviate from free-running playback before we
 * call it a SEEK rather than ordinary progress.
 *
 * It has to absorb two things at once: the coarse sampling of the player's own
 * position deliveries, and a stall (buffering, a dropped frame, the machine
 * sleeping for a moment) which also makes real time and playback time disagree.
 * 1.5 s is comfortably below the 2 s drift tolerance — so a scrub small enough
 * to slip past this detector is also small enough that nobody is corrected for
 * it — and comfortably above normal jitter.
 */
export const HOST_SEEK_DETECT_SECONDS = 1.5;

/** One reading of the host's own player. */
export interface HostPlaybackSnapshot {
  /** True only for PLAYING — buffering is not "playing" for this purpose. */
  playing: boolean;
  currentTime: number;
  /** Local `Date.now()` at the reading. */
  atMs: number;
}

export interface HostControlIntent {
  action: "play" | "pause" | "seek";
  positionSec: number;
}

/**
 * Turn two consecutive readings of the HOST's player into the control frame the
 * room needs, or null when nothing worth broadcasting happened.
 *
 * This is what lets the host drive with the REAL YouTube controls instead of a
 * bespoke transport bar we would have to build (and which the ToS forbids us
 * from replacing the player's own with). We watch, we do not intercept.
 *
 * The host never applies drift correction to itself, so nothing here can echo:
 * a frame we emit comes back as `watch.state`, the host ignores its position,
 * and no second intent is produced.
 */
export function detectHostControl(input: {
  previous: HostPlaybackSnapshot | null;
  current: HostPlaybackSnapshot;
}): HostControlIntent | null {
  const { previous, current } = input;
  // First reading only seeds the baseline — there is no transition to report,
  // and emitting one here would re-announce the state the server already set.
  if (!previous) return null;

  if (previous.playing !== current.playing) {
    return {
      action: current.playing ? "play" : "pause",
      positionSec: current.currentTime,
    };
  }

  // Same play/pause state: the only remaining event is the playhead moving to
  // somewhere it could not have reached on its own.
  const elapsedSec = current.playing ? Math.max(0, (current.atMs - previous.atMs) / 1000) : 0;
  const expected = previous.currentTime + elapsedSec;
  if (Math.abs(current.currentTime - expected) > HOST_SEEK_DETECT_SECONDS) {
    return { action: "seek", positionSec: current.currentTime };
  }
  return null;
}
