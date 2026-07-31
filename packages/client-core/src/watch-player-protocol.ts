/**
 * The YouTube iframe `postMessage` wire — pure string in, typed value out.
 *
 * ADR 0016 forbids loading YouTube's `iframe_api` script, because that would
 * mean widening `script-src` beyond `'self'` for a feature that is not worth a
 * remote-code channel. The official embed already speaks a JSON postMessage
 * protocol when built with `enablejsapi=1` (it is what `iframe_api` itself
 * drives), so we speak it directly and the CSP change stays to the single
 * `frame-src` line.
 *
 * Two rules make that safe, and both are enforced by the caller
 * (`WatchPartyPlayer`) using the values here:
 *
 *  1. Every outbound frame is posted with an explicit `targetOrigin` of
 *     {@link YOUTUBE_EMBED_ORIGIN} — never `"*"`, which would leak our frames to
 *     whatever happens to be in the iframe.
 *  2. Every inbound `message` event is dropped unless `event.origin` is exactly
 *     that origin AND it came from the iframe's own `contentWindow`.
 *
 * Everything below is defensive by construction: the player is a third party
 * that can change its payload shape without telling us, so an unrecognized or
 * malformed frame becomes {@link PlayerMessage} `kind: "unknown"` and is ignored
 * rather than throwing inside a `message` listener.
 */

/**
 * `YT.PlayerState`. Named rather than inlined because two of them are routinely
 * misread: BUFFERING is what a player reports mid-SEEK (so it must never be
 * treated as a pause), and UNSTARTED is what an autoplay-blocked player sits in
 * (so it is the signal for the "start playback" gate, not an error).
 */
export const PLAYER_STATE = {
  unstarted: -1,
  ended: 0,
  playing: 1,
  paused: 2,
  buffering: 3,
  cued: 5,
} as const;

export type PlayerState = (typeof PLAYER_STATE)[keyof typeof PLAYER_STATE];

/**
 * True for the states that mean "the user is watching" — playing OR buffering
 * its way back into playing. Used by the autoplay gate, which must not accuse a
 * player of being blocked while it is merely loading.
 */
export function isEngaged(state: PlayerState | null): boolean {
  return state === PLAYER_STATE.playing || state === PLAYER_STATE.buffering;
}

/**
 * Fold a player state into the boolean "is this playback running", carrying the
 * previous answer through the states that do not decide it.
 *
 * BUFFERING is the reason this exists. A player that stalls mid-video reports
 * state 3, and a naive `state === playing` would read that as the user pressing
 * pause — so the host's client would broadcast a `watch.control` pause and stop
 * the film for the whole room because their connection hiccuped. Only PLAYING,
 * PAUSED and ENDED are decisions; UNSTARTED, BUFFERING and CUED are transitions
 * and keep whatever was true before.
 */
export function foldPlaying(previous: boolean, state: PlayerState | null): boolean {
  if (state === PLAYER_STATE.playing) return true;
  if (state === PLAYER_STATE.paused || state === PLAYER_STATE.ended) return false;
  return previous;
}

// ---------------------------------------------------------------------------
// Outbound frames
// ---------------------------------------------------------------------------

/**
 * The handshake. Until the embed receives a `listening` frame it sends nothing
 * back, so no `infoDelivery` arrives and drift correction has nothing to
 * measure. `channel: "widget"` is the value the official API uses; `id` is any
 * stable per-player identifier and comes back on the replies.
 */
export function listeningFrame(playerId: string): string {
  return JSON.stringify({ event: "listening", id: playerId, channel: "widget" });
}

/** A player command (`playVideo`, `pauseVideo`, `seekTo`, …). */
export function commandFrame(func: string, args: readonly unknown[] = []): string {
  return JSON.stringify({ event: "command", func, args });
}

export const playCommand = (): string => commandFrame("playVideo");
export const pauseCommand = (): string => commandFrame("pauseVideo");

/**
 * Seek. `allowSeekAhead: true` asks the player to request the unbuffered range
 * from the server rather than snapping to the nearest keyframe it already has —
 * without it a correction can land seconds short and be re-corrected forever.
 */
export const seekCommand = (seconds: number): string =>
  commandFrame("seekTo", [Math.max(0, seconds), true]);

/**
 * Swap the video in place. Used when the host changes the video mid-session, so
 * the iframe is NOT re-created — remounting it would restart the whole embed
 * (and its handshake) for every viewer.
 */
export const loadVideoCommand = (videoId: string, startSeconds: number): string =>
  commandFrame("loadVideoById", [
    { videoId, startSeconds: Math.max(0, Math.floor(startSeconds)) },
  ]);

/** Unmute. Only ever sent from a real user gesture (the autoplay gate). */
export const unMuteCommand = (): string => commandFrame("unMute");

// ---------------------------------------------------------------------------
// Inbound frames
// ---------------------------------------------------------------------------

/**
 * A normalized message from the player. `state` carries whatever the frame
 * happened to include: `currentTime`/`duration` are absent on a bare
 * `onStateChange`, and the caller must keep its own last-known values rather
 * than treating `null` as zero (a "seek to 0" on every state change would be a
 * spectacular bug).
 */
export type PlayerMessage =
  | { kind: "ready" }
  | {
      kind: "state";
      playerState: PlayerState | null;
      currentTime: number | null;
      duration: number | null;
    }
  | { kind: "error"; code: number }
  | { kind: "unknown" };

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toPlayerState(value: unknown): PlayerState | null {
  const numeric = toFiniteNumber(value);
  if (numeric === null) return null;
  const known: readonly number[] = Object.values(PLAYER_STATE);
  return known.includes(numeric) ? (numeric as PlayerState) : null;
}

/**
 * Parse one `MessageEvent.data`. Accepts the JSON string the embed actually
 * sends and, defensively, an already-parsed object — some Chromium versions
 * hand structured data through. Anything else is `unknown`.
 */
export function parsePlayerMessage(data: unknown): PlayerMessage {
  let payload: unknown = data;
  if (typeof data === "string") {
    try {
      payload = JSON.parse(data);
    } catch {
      return { kind: "unknown" };
    }
  }
  if (typeof payload !== "object" || payload === null) return { kind: "unknown" };

  const frame = payload as { event?: unknown; info?: unknown };
  const event = typeof frame.event === "string" ? frame.event : null;
  if (event === null) return { kind: "unknown" };

  if (event === "onReady") return { kind: "ready" };

  if (event === "onError") {
    const code = toFiniteNumber(frame.info);
    return code === null ? { kind: "unknown" } : { kind: "error", code };
  }

  // `onStateChange` carries the bare state as `info`; `infoDelivery` /
  // `initialDelivery` carry an object with the whole player snapshot. Both mean
  // "here is where the player is", so they normalize to the same message.
  if (event === "onStateChange") {
    const playerState = toPlayerState(frame.info);
    return playerState === null
      ? { kind: "unknown" }
      : { kind: "state", playerState, currentTime: null, duration: null };
  }

  if (event === "infoDelivery" || event === "initialDelivery") {
    if (typeof frame.info !== "object" || frame.info === null) return { kind: "unknown" };
    const info = frame.info as {
      currentTime?: unknown;
      playerState?: unknown;
      duration?: unknown;
    };
    const currentTime = toFiniteNumber(info.currentTime);
    const playerState = toPlayerState(info.playerState);
    const duration = toFiniteNumber(info.duration);
    // A delivery that carries none of the three tells us nothing (the embed
    // sends several such housekeeping frames per second).
    if (currentTime === null && playerState === null && duration === null) {
      return { kind: "unknown" };
    }
    return { kind: "state", playerState, currentTime, duration };
  }

  return { kind: "unknown" };
}

// ---------------------------------------------------------------------------
// Error taxonomy (§26 — never show a raw code)
// ---------------------------------------------------------------------------

/**
 * What actually went wrong, in terms a user can act on. The distinction that
 * matters is EMBED-DISABLED vs everything else: that one is not a bug, not a
 * network problem, and not fixable by retrying — the video's owner forbade
 * embedding and the host has to pick a different link (ADR 0016 accepts this as
 * a known limitation of the free path).
 */
export type WatchPlayerError = "embedDisabled" | "notFound" | "playbackFailed";

/**
 * Map a YouTube `onError` code.
 *  - 101 / 150: the owner disallowed embedded playback (150 is 101 proxied
 *    through a different host; they mean the same thing).
 *  - 100: the video is gone or private.
 *  - 2 (bad parameter) / 5 (HTML5 player failure) / anything unknown: a
 *    generic playback failure, because guessing at an unknown future code is
 *    how a user ends up reading a wrong explanation.
 */
export function playerErrorKind(code: number): WatchPlayerError {
  if (code === 101 || code === 150) return "embedDisabled";
  if (code === 100) return "notFound";
  return "playbackFailed";
}
