/**
 * The embedded YouTube player for a watch party (M20, ADR 0016).
 *
 * ## What this component is allowed to be
 *
 * The OFFICIAL `youtube-nocookie.com` iframe embed, unmodified. No ad blocking,
 * no chrome replacement, no proxying — that is a YouTube ToS line and also the
 * reason this feature costs nothing. It is driven over the embed's own
 * `postMessage` API (`enablejsapi=1`), NOT by loading `iframe_api`, so
 * `script-src 'self'` is untouched and the entire CSP change for this feature is
 * one `frame-src` line.
 *
 * ## The two roles are genuinely different code paths
 *
 * **Host** — the player has its REAL controls (`controls=1`). The host scrubs,
 * pauses and plays with YouTube's own transport bar and we merely WATCH what
 * happens ({@link detectHostControl}) and broadcast it. The host never applies
 * drift correction to itself: it is the source of truth, so there is no loop
 * for an echoed `watch.state` to start.
 *
 * **Viewer** — no controls (`controls=0`), and the iframe is `pointer-events-none`
 * so the surface is visibly inert instead of offering clicks that get yanked back
 * a second later by the corrector (§35). Playback follows the server: play/pause
 * is enforced every tick and the position is corrected when it drifts past
 * `WATCH_DRIFT_TOLERANCE_SECONDS`, with the hysteresis in
 * {@link nextSeekDecision} standing between us and a seek loop.
 *
 * ## Origin discipline
 *
 * Outbound frames are posted with an explicit `targetOrigin`; inbound `message`
 * events are ignored unless they came from THIS iframe's `contentWindow` AND
 * carry exactly {@link YOUTUBE_EMBED_ORIGIN}. Nothing else is read, ever.
 */

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Play, TriangleAlert } from "lucide-react";
import { Button, cn } from "@demli/ui";
import { useAppTranslation } from "../lib/i18n";
import { isYouTubeVideoId } from "@demli/config";
import {
  buildEmbedUrl,
  detectHostControl,
  expectedPositionSec,
  foldPlaying,
  initialSeekHysteresis,
  isEngaged,
  listeningFrame,
  loadVideoCommand,
  nextSeekDecision,
  parsePlayerMessage,
  pauseCommand,
  playCommand,
  playerErrorKind,
  seekCommand,
  unMuteCommand,
  PLAYER_STATE,
  YOUTUBE_EMBED_ORIGIN,
  type HostControlIntent,
  type HostPlaybackSnapshot,
  type PlayerState,
  type SeekHysteresis,
  type WatchSession,
  type WatchPlayerError,
} from "@demli/client-core";

/** How often we compare our playhead to the server's. */
const SYNC_TICK_MS = 1_000;

/**
 * How long the embed may sit un-engaged after we asked it to play before we call
 * it blocked and offer the viewer a real button. Long enough to cover a slow
 * first load on a cold connection, short enough that nobody stares at a frozen
 * frame wondering whether the app is broken.
 */
const AUTOPLAY_GRACE_MS = 2_500;

/** Handshake retries. The embed ignores `listening` until its JS is up. */
const HANDSHAKE_ATTEMPTS = 12;
const HANDSHAKE_INTERVAL_MS = 400;

export interface WatchPartyPlayerProps {
  session: WatchSession;
  /** True when THIS user drives (host, or the server owner override). */
  isHost: boolean;
  /** Called with what the host just did to their own player. */
  onHostControl: (intent: HostControlIntent) => void;
  /**
   * The video reached its end. Fired ONLY on the controlling client, with the id
   * that finished — see the ENDED block below for why it is not everyone's to
   * report. Optional so a surface that has no queue can mount the player
   * unchanged.
   */
  onEnded?: (videoId: string) => void;
  className?: string;
}

function WatchPartyPlayerImpl({
  session,
  isHost,
  onHostControl,
  onEnded,
  className,
}: WatchPartyPlayerProps): JSX.Element {
  const { t } = useAppTranslation();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // ── live player readings (refs: these tick several times a second and must
  //    not re-render the stage, §27) ──────────────────────────────────────────
  const playerStateRef = useRef<PlayerState | null>(null);
  const currentTimeRef = useRef<number | null>(null);
  const hostPlayingRef = useRef(false);
  const hostSnapshotRef = useRef<HostPlaybackSnapshot | null>(null);
  const hysteresisRef = useRef<SeekHysteresis>(initialSeekHysteresis);
  const blockedSinceRef = useRef<number | null>(null);
  /** The video the live iframe is actually showing (see the src block below). */
  const loadedVideoIdRef = useRef(session.videoId);
  const readyRef = useRef(false);
  /**
   * The live session, for the effects that must NOT be re-installed on every 5 s
   * heartbeat (the sync tick would be torn down and rebuilt twelve times a
   * minute, losing its interval phase each time).
   */
  const sessionRef = useRef(session);
  sessionRef.current = session;

  // ── the iframe src ────────────────────────────────────────────────────────
  // Rebuilt ONLY when the control mode flips, because that changes the `controls`
  // parameter and therefore needs a real reload. A video CHANGE does not touch
  // the src: it is applied with `loadVideoById`, so viewers keep their warm embed
  // (and its handshake) instead of paying a full iframe reload every time the
  // host picks a new video.
  const [frame, setFrame] = useState(() => ({
    isHost,
    src: buildEmbedUrl({
      videoId: session.videoId,
      startSec: expectedPositionSec(session, Date.now()),
      controls: isHost,
    }),
  }));
  if (frame.isHost !== isHost) {
    // Adjusting state during render on a prop change — the documented React
    // pattern, and the only way to avoid rendering one frame with the wrong
    // control set.
    setFrame({
      isHost,
      src: buildEmbedUrl({
        videoId: session.videoId,
        startSec: expectedPositionSec(session, Date.now()),
        controls: isHost,
      }),
    });
    // The fresh iframe loads this video itself, so the "has the host swapped the
    // video?" effect below must not ALSO fire a `loadVideoById` for it. Recorded
    // beside the adjustment it belongs to, rather than left for the effect to
    // rediscover.
    loadedVideoIdRef.current = session.videoId;
  }

  // The two things the USER has to be told about, so they are real state.
  const [playerError, setPlayerError] = useState<WatchPlayerError | null>(null);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);

  const post = useCallback((payload: string) => {
    // No optional-chaining shortcut here on purpose: posting to a null window
    // throws inside an interval, and an interval that throws stops ticking —
    // which would silently end drift correction for the rest of the session.
    const target = iframeRef.current?.contentWindow;
    if (!target) return;
    target.postMessage(payload, YOUTUBE_EMBED_ORIGIN);
  }, []);

  // Keep the latest host callback without making the message listener depend on
  // it (re-subscribing a window listener on every parent render is how you end
  // up with duplicated handlers).
  const onHostControlRef = useRef(onHostControl);
  onHostControlRef.current = onHostControl;
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;
  const isHostRef = useRef(isHost);
  isHostRef.current = isHost;
  /**
   * The video id we have already reported as finished.
   *
   * The embed delivers ENDED more than once for a single ending (and again if
   * the frame re-reports its state), and while the server is idempotent on the
   * id, there is no reason to send the same frame three times. Cleared when the
   * video changes, in the swap effect below.
   */
  const endedReportedRef = useRef<string | null>(null);

  // ── inbound: the embed's own messages ─────────────────────────────────────
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== YOUTUBE_EMBED_ORIGIN) return;
      const frameWindow = iframeRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow) return;

      const parsed = parsePlayerMessage(event.data);
      if (parsed.kind === "unknown") return;
      readyRef.current = true;

      if (parsed.kind === "ready") return;

      if (parsed.kind === "error") {
        setPlayerError(playerErrorKind(parsed.code));
        return;
      }

      // kind === "state": a delivery carries whichever fields it has; absent
      // ones must keep their previous value (see PlayerMessage).
      if (parsed.playerState !== null) playerStateRef.current = parsed.playerState;
      if (parsed.currentTime !== null) currentTimeRef.current = parsed.currentTime;

      // A state change means the video is alive — clear a stale error banner
      // (e.g. the host replaced an un-embeddable video with a working one).
      if (parsed.playerState === PLAYER_STATE.playing) setPlayerError(null);

      if (!isHostRef.current) return;

      // ── the video finished: advance the queue ────────────────────────────
      //
      // HOST ONLY, and that is the whole point. Every client hits the end at its
      // own moment — ads play per-viewer, buffering differs, drift correction
      // lands late — so if everyone reported it, the room would advance on
      // whichever member happened to run ahead, and a viewer whose ad finished
      // early would cut the last seconds of the video off for everybody. One
      // reporter: the one who already owns the transport.
      //
      // The id sent is the SESSION's video, not anything the embed told us. The
      // server refuses a report that does not name its current video, and the
      // session is our copy of what the server thinks is playing — reporting
      // what the iframe last loaded could name a video the room already left.
      if (
        parsed.playerState === PLAYER_STATE.ended &&
        endedReportedRef.current !== sessionRef.current.videoId
      ) {
        endedReportedRef.current = sessionRef.current.videoId;
        onEndedRef.current?.(sessionRef.current.videoId);
      }

      // Host only: read our own transport and tell the room what changed.
      const playing = foldPlaying(hostPlayingRef.current, playerStateRef.current);
      hostPlayingRef.current = playing;
      const currentTime = currentTimeRef.current;
      if (currentTime === null) return;

      const snapshot: HostPlaybackSnapshot = { playing, currentTime, atMs: Date.now() };
      const intent = detectHostControl({ previous: hostSnapshotRef.current, current: snapshot });
      hostSnapshotRef.current = snapshot;
      if (intent) onHostControlRef.current(intent);
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // ── handshake: without a `listening` frame the embed never talks back ──────
  useEffect(() => {
    readyRef.current = false;
    let attempts = 0;
    // The handshake id is OPAQUE and per-player, never the channel id.
    //
    // This string is postMessage'd to YouTube's frame and comes back in its
    // replies — the protocol assigns it no meaning beyond matching. Sending the
    // channel's uuid would hand every viewer of the same room an IDENTICAL value
    // to a third party that also sees their IP and (if signed in) their account:
    // a ready-made key for linking the members of a private friend group to each
    // other. That is exactly the correlation `youtube-nocookie` is chosen to
    // avoid, so the id carries no information about us at all.
    const handshakeId = `demli-watch-${crypto.randomUUID()}`;
    const send = (): void => {
      post(listeningFrame(handshakeId));
    };
    send();
    const timer = window.setInterval(() => {
      attempts += 1;
      if (readyRef.current || attempts >= HANDSHAKE_ATTEMPTS) {
        window.clearInterval(timer);
        return;
      }
      send();
    }, HANDSHAKE_INTERVAL_MS);
    return () => window.clearInterval(timer);
    // Re-handshakes when the iframe is actually re-created (mode flip) — the src
    // is the identity of the embed instance.
  }, [post, frame.src, session.channelId]);

  // ── the host swapped the video: load it in place ──────────────────────────
  useEffect(() => {
    if (session.videoId === loadedVideoIdRef.current) return;
    loadedVideoIdRef.current = session.videoId;
    // Read the position from the ref, so this effect can depend on the VIDEO
    // alone — `positionSec` changes on every heartbeat and would otherwise
    // re-run (and re-evaluate) this twelve times a minute for nothing.
    const startSec = sessionRef.current.positionSec;
    // A new video resets everything we knew about the old one, including the
    // backoff — otherwise a long ad on the PREVIOUS video would keep the next
    // one's corrections throttled.
    hysteresisRef.current = initialSeekHysteresis;
    hostSnapshotRef.current = null;
    currentTimeRef.current = null;
    playerStateRef.current = null;
    // A new video has not ended yet. Without this, a room that came back to the
    // same video (a replay, or a queue with a repeat) would never report its
    // second ending and would sit there instead of advancing.
    endedReportedRef.current = null;
    setPlayerError(null);
    // Re-validated here, not just in `buildEmbedUrl`. This is the ONE path where
    // a server-sent id reaches the player without passing through URL
    // construction, and the wave's own rule is that the client validates
    // independently of the server — a rule with a hole in it is not a rule.
    if (!isYouTubeVideoId(session.videoId)) return;
    post(loadVideoCommand(session.videoId, startSec));
  }, [post, session.videoId]);

  // ── the sync tick ─────────────────────────────────────────────────────────
  // Reads refs, not props-in-closure, so it is installed once per player and not
  // torn down and rebuilt on every 5 s heartbeat.
  useEffect(() => {
    const tick = (): void => {
      const live = sessionRef.current;
      const nowMs = Date.now();
      const state = playerStateRef.current;

      // 1. Enforce play/pause. Viewers only: the host IS the transport, and
      //    sending them a play command would fight the pause they just pressed.
      if (!isHostRef.current) {
        if (live.playing && !isEngaged(state)) {
          post(playCommand());
          if (blockedSinceRef.current === null) blockedSinceRef.current = nowMs;
          else if (nowMs - blockedSinceRef.current > AUTOPLAY_GRACE_MS) setAutoplayBlocked(true);
        } else {
          blockedSinceRef.current = null;
          setAutoplayBlocked(false);
          if (!live.playing && state === PLAYER_STATE.playing) post(pauseCommand());
        }
      }

      // 2. Drift. The host is authoritative and is never corrected; a player
      //    that has not reported a position yet has nothing to compare.
      if (isHostRef.current) return;
      const actual = currentTimeRef.current;
      if (actual === null) return;

      const decision = nextSeekDecision({
        expectedSec: expectedPositionSec(live, nowMs),
        actualSec: actual,
        nowMs,
        hysteresis: hysteresisRef.current,
      });
      hysteresisRef.current = decision.hysteresis;
      if (decision.seekToSec !== null) {
        post(seekCommand(decision.seekToSec));
        // Assume the seek lands, so the very next tick does not re-measure the
        // pre-seek position and re-decide. The player's own delivery overwrites
        // this within a few hundred ms either way.
        currentTimeRef.current = decision.seekToSec;
      }
    };

    const timer = window.setInterval(tick, SYNC_TICK_MS);
    return () => window.clearInterval(timer);
  }, [post]);

  /**
   * The viewer's escape hatch when Chromium refuses to autoplay. This is a REAL
   * attempt, not a placebo: the click gives our document a fresh user
   * activation, which (with `allow="autoplay"` on the iframe) is what the policy
   * was waiting for, and it also unmutes in case the embed fell back to muted
   * playback.
   */
  const onStartPlayback = (): void => {
    post(unMuteCommand());
    post(playCommand());
    blockedSinceRef.current = null;
    setAutoplayBlocked(false);
  };

  const errorMessage =
    playerError === null
      ? null
      : playerError === "embedDisabled"
        ? t("desktop:watchParty.errorEmbedDisabled")
        : playerError === "notFound"
          ? t("desktop:watchParty.errorNotFound")
          : t("desktop:watchParty.errorPlayback");

  return (
    <div className={cn("relative h-full w-full overflow-hidden rounded-xl bg-rail", className)}>
      {frame.src === null ? (
        // Unreachable in practice (the server only ever stores a normalized id),
        // but a null URL must render an explanation rather than an empty frame.
        <div className="flex h-full w-full items-center justify-center p-6 text-center">
          <p className="text-sm text-fg-muted">{t("desktop:watchParty.errorPlayback")}</p>
        </div>
      ) : (
        <iframe
          ref={iframeRef}
          key={frame.src}
          src={frame.src}
          title={t("desktop:watchParty.playerTitle")}
          // `autoplay` is DELEGATED to the frame on purpose: without it the
          // cross-origin embed cannot inherit our document's user activation and
          // every viewer would need a manual start. `encrypted-media` is what
          // YouTube itself requires for normal playback.
          allow="autoplay; encrypted-media; picture-in-picture"
          allowFullScreen
          // No `sandbox` attribute: the embed needs its own scripts, storage and
          // popups to function, so a sandbox that actually let it work would list
          // `allow-scripts allow-same-origin allow-popups` and grant strictly
          // more than the frame-src + navigation guards already allow. The real
          // containment is the CSP (only this one host may be framed) and the
          // main-process `will-frame-navigate` guard (the frame cannot navigate
          // itself anywhere else, and it can never move the top window).
          className={cn(
            "h-full w-full border-0",
            // Viewers get an inert surface. Not a click-eating overlay: a click
            // that visibly does nothing is exactly what §35 forbids, and the
            // "viewer mode" chip above the player says why it is inert.
            !isHost && "pointer-events-none",
          )}
        />
      )}

      {autoplayBlocked && !isHost && frame.src !== null && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 surface-scrim animate-fade-in">
          <p className="px-6 text-center text-sm text-fg">
            {t("desktop:watchParty.autoplayBlocked")}
          </p>
          <Button size="sm" variant="accent" onClick={onStartPlayback}>
            <Play className="size-4" />
            {t("desktop:watchParty.startPlayback")}
          </Button>
        </div>
      )}

      {errorMessage !== null && (
        <div role="alert" className="absolute inset-x-3 bottom-3 flex items-start gap-2 rounded-xl surface-glass-strong px-4 py-3 animate-fade-in">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          <p className="text-xs leading-relaxed text-fg">{errorMessage}</p>
        </div>
      )}
    </div>
  );
}

/**
 * Memoized (§27): the parent re-renders whenever the roster or anyone's presence
 * ticks, and none of that changes what is on screen here. With a stable
 * `onHostControl` the only prop that actually moves is `session`, so the player
 * re-renders on a real sync frame and on nothing else.
 */
export const WatchPartyPlayer = memo(WatchPartyPlayerImpl);
