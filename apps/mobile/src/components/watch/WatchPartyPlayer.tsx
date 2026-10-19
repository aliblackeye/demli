/**
 * The embedded YouTube player for a watch party, on the phone (M20 mobile parity).
 *
 * The RN twin of `apps/desktop/src/renderer/src/components/WatchPartyPlayer.tsx`.
 * Every DECISION is imported from `@demli/client-core` — the drift tolerance,
 * the seek cooldown and its backoff ladder, what counts as the host having
 * scrubbed, how a player frame is parsed, which origin may be framed. None of it
 * is re-derived here, because those numbers are agreements between two machines:
 * if the phone tolerated 1.5 s of drift and the laptop 2 s, the phone would seek
 * to a position the laptop considers correct, the laptop would leave it alone, and
 * the phone would keep correcting — two members of one room fighting over a
 * playhead. What this file owns is the TRANSPORT (a WebView instead of an iframe)
 * and the three things a phone has that a desktop does not: it gets backgrounded,
 * it is already carrying a voice call on its one audio path, and its screen wants
 * to turn itself off.
 *
 * ## The two roles are genuinely different code paths
 *
 * **Host** — the embed has its REAL controls (`controls=1`). The host scrubs,
 * pauses and plays with YouTube's own transport bar and we merely WATCH what
 * happens ({@link detectHostControl}) and broadcast it. The host never applies
 * drift correction to itself: it is the source of truth, so there is no loop for
 * an echoed `watch.state` to start.
 *
 * **Viewer** — no controls (`controls=0`), and the WebView is wrapped in a
 * `pointerEvents="none"` view so the surface is genuinely inert. That wrapper is
 * not decoration: without it a tap lands on a hidden YouTube hit target, the
 * viewer's player does something, and the corrector yanks it back a second later —
 * a control that appears to work and then undoes itself, which is exactly what
 * §35 forbids. Playback follows the server: play/pause is enforced every tick and
 * the position is corrected past `WATCH_DRIFT_TOLERANCE_SECONDS`, with the
 * hysteresis in {@link nextSeekDecision} standing between us and a seek loop.
 *
 * ## Backgrounding — the mobile-only failure this file exists to survive
 *
 * Android freezes a WebView's timers and stops its media when the activity goes
 * away, so a phone that spends ninety seconds in another app comes back with a
 * player ninety seconds behind a room that never stopped. The recovery is the one
 * the sync model already implies: {@link expectedPositionSec} projects the
 * server's stated position forward from the LOCAL instant the snapshot landed, so
 * it is correct across an arbitrarily long gap — a two-minute-old snapshot of a
 * playing session still names the right second. On return we therefore throw away
 * every local reading, clear the hysteresis (a cooldown left over from before the
 * gap must not swallow the one correction that matters), and seek there.
 *
 * The HOST is resynced the same way, and is deliberately NOT auto-paused on the
 * way out. A host who glances at a notification for three seconds must not stop
 * the film for everyone, so no `watch.control` frame is produced while we are
 * away: {@link HostPlaybackSnapshot} tracking is reset instead, which makes the
 * first reading after the return a baseline rather than a transition, so the
 * platform's own pause/resume is never mistaken for the host pressing anything.
 *
 * ## Audio — why this file does not touch the audio session
 *
 * The user is in a voice room. WebRTC hands the OS ONE playout track for the whole
 * room, configured once by `media/audio-profile.ts` before `Room.connect()`
 * (task #121), and the RN SDK exposes no live switch. Anything here that called
 * `AudioSession.configureAudio` would either be ignored or would break the
 * hardware echo canceller and Bluetooth mic capture for the call — the exact
 * trade that setting documents and leaves to the user.
 *
 * So the film's loudness is adjusted where it costs nothing: inside the player,
 * through the embed's own `setVolume`. It moves the video and only the video, the
 * voice path is not touched at all, and a user whose friends are drowned out has a
 * lever that cannot break their call to reach for.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, View } from "react-native";
import type { AppStateStatus } from "react-native";
import { WebView } from "react-native-webview";
import type { WebViewMessageEvent } from "react-native-webview";
import { Play, TriangleAlert } from "lucide-react-native";
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
  type HostControlIntent,
  type HostPlaybackSnapshot,
  type PlayerState,
  type SeekHysteresis,
  type WatchPlayerError,
  type WatchSession,
} from "@demli/client-core";
import { useAppTranslation } from "@/lib/i18n";
import { newId } from "@/lib/id";
import { colors, radius, space } from "@/theme/theme";
import { Button } from "../ui/Button";
import { Text } from "../ui/Text";
import {
  allowWatchNavigation,
  postToPlayerScript,
  volumeCommand,
  watchPlayerHtml,
  WATCH_DOCUMENT_BASE_URL,
} from "./watch-player-bridge";

/** How often we compare our playhead to the server's. Matches desktop. */
const SYNC_TICK_MS = 1_000;

/**
 * How long the embed may sit un-engaged after we asked it to play before we call
 * it blocked and offer a real button. Long enough to cover a slow first load on
 * mobile data, short enough that nobody stares at a black rectangle wondering
 * whether the app is broken.
 */
const AUTOPLAY_GRACE_MS = 2_500;

/** Handshake retries. The embed ignores `listening` until its own JS is up. */
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
   * report.
   */
  onEnded?: (videoId: string) => void;
  /**
   * Film volume, 0–100. Applied to the EMBED, never to the audio session — see
   * this file's header. Re-applied after every load, resync and handshake,
   * because a fresh embed starts at 100 and a user who turned the film down to
   * hear their friends must not be shouted at again by the next queued video.
   */
  volumePercent: number;
}

function WatchPartyPlayerImpl({
  session,
  isHost,
  onHostControl,
  onEnded,
  volumePercent,
}: WatchPartyPlayerProps) {
  const { t } = useAppTranslation();
  const webRef = useRef<WebView | null>(null);

  // ── live player readings ──────────────────────────────────────────────────
  // Refs, not state: these tick several times a second and must not re-render
  // the stage (§27), which on a phone shares a frame budget with a LiveKit room.
  const playerStateRef = useRef<PlayerState | null>(null);
  const currentTimeRef = useRef<number | null>(null);
  const hostPlayingRef = useRef(false);
  const hostSnapshotRef = useRef<HostPlaybackSnapshot | null>(null);
  const hysteresisRef = useRef<SeekHysteresis>(initialSeekHysteresis);
  const blockedSinceRef = useRef<number | null>(null);
  /** The video the live WebView is actually showing (see the swap effect). */
  const loadedVideoIdRef = useRef(session.videoId);
  const readyRef = useRef(false);
  /** False while the app is backgrounded — gates the tick and host reporting. */
  const foregroundRef = useRef(AppState.currentState === "active");
  /**
   * The live session, for the effects that must NOT be re-installed on every 5 s
   * heartbeat (the sync tick would be torn down and rebuilt twelve times a
   * minute, losing its interval phase each time).
   */
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const volumeRef = useRef(volumePercent);
  volumeRef.current = volumePercent;

  /**
   * The handshake id. OPAQUE and per-player, never the channel id.
   *
   * This string is posted to YouTube's frame and comes back on its replies; the
   * protocol assigns it no meaning beyond matching. Sending the channel's uuid
   * would hand every viewer of the same room an IDENTICAL value to a third party
   * that also sees their IP and (if signed in) their account — a ready-made key
   * for linking the members of a private friend group to each other. That is
   * exactly the correlation `youtube-nocookie` is chosen to avoid, so the id
   * carries no information about us at all.
   */
  // Minted lazily: `useRef(expr)` still EVALUATES `expr` on every render and
  // throws the result away, and this component re-renders on every 5 s
  // heartbeat — that would be a native crypto call twelve times a minute for a
  // string that never changes.
  const handshakeIdRef = useRef<string | null>(null);
  if (handshakeIdRef.current === null) {
    handshakeIdRef.current = `demli-watch-${newId()}`;
  }
  const handshakeId = handshakeIdRef.current;

  // ── the document ──────────────────────────────────────────────────────────
  // Rebuilt ONLY when the control mode flips, because that changes the `controls`
  // parameter and therefore needs a real reload. A video CHANGE does not touch
  // it: that is applied with `loadVideoById`, so viewers keep their warm embed
  // (and its handshake) instead of paying a full WebView reload — which on a
  // phone is not a cheap operation — every time the host picks a new video.
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
    // The fresh document loads this video itself, so the "has the host swapped
    // the video?" effect below must not ALSO fire a `loadVideoById` for it.
    loadedVideoIdRef.current = session.videoId;
  }

  /**
   * The WebView source, memoized on the HTML string.
   *
   * Load-bearing: `source` is an object prop that crosses the bridge, and a fresh
   * object literal on every render is a fresh prop value to the native side — the
   * WebView would reload, and therefore restart playback from zero, on every
   * 5 s heartbeat. Memoizing pins the identity to the only thing that should ever
   * cause a reload.
   */
  const source = useMemo(
    () =>
      frame.src === null
        ? null
        : {
            html: watchPlayerHtml(frame.src),
            // Without a base URL the WebView loads at an opaque origin and sends
            // no `Referer`, and the embed refuses with error 153 — see
            // WATCH_DOCUMENT_BASE_URL for the measurement and for why this is
            // our own origin rather than YouTube's.
            baseUrl: WATCH_DOCUMENT_BASE_URL,
          },
    [frame.src],
  );

  // The two things the USER has to be told about, so they are real state.
  const [playerError, setPlayerError] = useState<WatchPlayerError | null>(null);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);

  const post = useCallback((payload: string) => {
    // No optional-chaining shortcut on purpose: injecting into a torn-down
    // WebView throws inside an interval, and an interval that throws stops
    // ticking — which would silently end drift correction for the rest of the
    // session.
    const view = webRef.current;
    if (!view) return;
    try {
      view.injectJavaScript(postToPlayerScript(payload));
    } catch {
      // The view can be mid-teardown or mid-navigation. The next tick retries.
    }
  }, []);

  // Keep the latest callbacks without making the message handler depend on them
  // (a new handler identity on every parent render is a new prop across the
  // bridge for a component that must stay still).
  const onHostControlRef = useRef(onHostControl);
  onHostControlRef.current = onHostControl;
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;
  const isHostRef = useRef(isHost);
  isHostRef.current = isHost;
  /**
   * The video id we have already reported as finished.
   *
   * The embed delivers ENDED more than once for a single ending, and while the
   * server is idempotent on the id there is no reason to send the same frame
   * three times. Cleared when the video changes, in the swap effect below.
   */
  const endedReportedRef = useRef<string | null>(null);

  // ── inbound: the embed's own messages, relayed by our document ─────────────
  //
  // The origin and source checks that guard this on desktop live in the relay
  // (see watch-player-bridge.ts) — by the time a string arrives here it has
  // already been proven to come from the embed's own window at exactly
  // YOUTUBE_EMBED_ORIGIN. `parsePlayerMessage` is defensive regardless: the
  // player is a third party that can change its payload shape without telling
  // us, so anything unrecognized becomes `unknown` and is ignored.
  const onMessage = useCallback((event: WebViewMessageEvent) => {
    const parsed = parsePlayerMessage(event.nativeEvent.data);
    if (parsed.kind === "unknown") return;
    readyRef.current = true;

    if (parsed.kind === "ready") {
      // A fresh embed is at volume 100. Re-assert the user's choice before they
      // hear the difference.
      post(volumeCommand(volumeRef.current));
      return;
    }

    if (parsed.kind === "error") {
      setPlayerError(playerErrorKind(parsed.code));
      return;
    }

    // kind === "state": a delivery carries whichever fields it has; absent ones
    // must keep their previous value (see PlayerMessage).
    if (parsed.playerState !== null) playerStateRef.current = parsed.playerState;
    if (parsed.currentTime !== null) currentTimeRef.current = parsed.currentTime;

    // A state change means the video is alive — clear a stale error banner (e.g.
    // the host replaced an un-embeddable video with a working one).
    if (parsed.playerState === PLAYER_STATE.playing) setPlayerError(null);

    if (!isHostRef.current) return;

    // ── the video finished: advance the queue ──────────────────────────────
    //
    // HOST ONLY, and that is the whole point. Every client hits the end at its
    // own moment — ads play per-viewer, buffering differs, a phone that was
    // backgrounded lands late — so if everyone reported it, the room would
    // advance on whichever member happened to run ahead, and a viewer whose ad
    // finished early would cut the last seconds off for everybody. One reporter:
    // the one who already owns the transport.
    //
    // The id sent is the SESSION's video, not anything the embed told us. The
    // server refuses a report that does not name its current video, and the
    // session is our copy of what the server thinks is playing — reporting what
    // the WebView last loaded could name a video the room already left.
    if (
      parsed.playerState === PLAYER_STATE.ended &&
      endedReportedRef.current !== sessionRef.current.videoId
    ) {
      endedReportedRef.current = sessionRef.current.videoId;
      onEndedRef.current?.(sessionRef.current.videoId);
    }

    // While we are in the background the platform, not the user, decides what
    // this player does — Android pauses the media and resumes it on return.
    // Reporting either as a host action would stop the film for the whole room
    // because somebody glanced at a notification.
    if (!foregroundRef.current) return;

    // Host only: read our own transport and tell the room what changed.
    const playing = foldPlaying(hostPlayingRef.current, playerStateRef.current);
    hostPlayingRef.current = playing;
    const currentTime = currentTimeRef.current;
    if (currentTime === null) return;

    const snapshot: HostPlaybackSnapshot = { playing, currentTime, atMs: Date.now() };
    const intent = detectHostControl({ previous: hostSnapshotRef.current, current: snapshot });
    hostSnapshotRef.current = snapshot;
    if (intent) onHostControlRef.current(intent);
  }, [post]);

  // ── handshake: without a `listening` frame the embed never talks back ──────
  useEffect(() => {
    if (source === null) return;
    readyRef.current = false;
    let attempts = 0;
    const send = (): void => {
      post(listeningFrame(handshakeId));
    };
    send();
    const timer = setInterval(() => {
      attempts += 1;
      if (readyRef.current || attempts >= HANDSHAKE_ATTEMPTS) {
        clearInterval(timer);
        return;
      }
      send();
    }, HANDSHAKE_INTERVAL_MS);
    return () => clearInterval(timer);
    // Re-handshakes when the document is actually re-created (mode flip) — the
    // source object is the identity of the embed instance.
  }, [post, source]);

  // ── the host swapped the video: load it in place ──────────────────────────
  useEffect(() => {
    if (session.videoId === loadedVideoIdRef.current) return;
    loadedVideoIdRef.current = session.videoId;
    // Read the position from the ref, so this effect depends on the VIDEO alone —
    // `positionSec` changes on every heartbeat and would otherwise re-run this
    // twelve times a minute for nothing.
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
    // A `loadVideoById` gives us a fresh video at the embed's default volume.
    post(volumeCommand(volumeRef.current));
  }, [post, session.videoId]);

  // ── film volume ───────────────────────────────────────────────────────────
  // Its own effect, so changing it costs one injected command and touches
  // nothing else. Never reaches the audio session — see the file header.
  useEffect(() => {
    post(volumeCommand(volumePercent));
  }, [post, volumePercent]);

  /**
   * Throw away every local reading and re-seat the player on server truth.
   *
   * Called when the app returns to the foreground, where the readings we hold are
   * from before an arbitrarily long gap and the embed may have been frozen the
   * whole time. `expectedPositionSec` is correct across that gap by construction
   * (it projects from the LOCAL instant the snapshot landed), so the seek target
   * is right even if the last `watch.state` is minutes old.
   */
  const resync = useCallback(() => {
    const live = sessionRef.current;
    // A cooldown left over from before the gap would swallow exactly the one
    // correction that matters. The counter goes with it: a backoff earned by an
    // ad five minutes ago says nothing about now.
    hysteresisRef.current = initialSeekHysteresis;
    // Null, not stale: the first reading after the return must be a BASELINE, so
    // the platform's own resume cannot be read as the host pressing play.
    hostSnapshotRef.current = null;
    currentTimeRef.current = null;
    playerStateRef.current = null;
    blockedSinceRef.current = null;
    setAutoplayBlocked(false);

    // The relay may have been frozen with the rest of the document; re-asserting
    // `listening` is idempotent and costs one injected string.
    post(listeningFrame(handshakeId));
    post(seekCommand(expectedPositionSec(live, Date.now())));
    post(live.playing ? playCommand() : pauseCommand());
    post(volumeCommand(volumeRef.current));
  }, [post]);

  // ── app lifecycle ─────────────────────────────────────────────────────────
  useEffect(() => {
    const onChange = (next: AppStateStatus): void => {
      const nowForeground = next === "active";
      const wasForeground = foregroundRef.current;
      if (nowForeground === wasForeground) return;
      foregroundRef.current = nowForeground;

      if (nowForeground) {
        resync();
        return;
      }

      // Going away. A VIEWER's player is paused: nobody can see it, and letting
      // it run spends battery and mobile data on frames that are thrown away —
      // and would keep the film's audio playing in a pocket, over a call the
      // user is still in.
      //
      // The HOST's is deliberately NOT paused. Their player IS the room's
      // transport, so pausing it here would either stop the film for everyone
      // (if we broadcast) or desynchronize the host from the room (if we did
      // not). Instead the host's snapshot tracking is cleared, so whatever the
      // platform does while we are away produces no `watch.control` frame at
      // all, and the return path resyncs them like anybody else.
      hostSnapshotRef.current = null;
      if (!isHostRef.current) post(pauseCommand());
    };

    const subscription = AppState.addEventListener("change", onChange);
    return () => subscription.remove();
  }, [post, resync]);

  // ── the sync tick ─────────────────────────────────────────────────────────
  // Reads refs, not props-in-closure, so it is installed once per player and not
  // torn down and rebuilt on every 5 s heartbeat.
  useEffect(() => {
    const tick = (): void => {
      // Backgrounded: the embed's timers are frozen, so a reading is stale by
      // definition and a correction issued now would be applied at some
      // unknowable later moment. The foreground transition resyncs instead.
      if (!foregroundRef.current) return;

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

      // 2. Drift. The host is authoritative and is never corrected; a player that
      //    has not reported a position yet has nothing to compare.
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

    const timer = setInterval(tick, SYNC_TICK_MS);
    return () => clearInterval(timer);
  }, [post]);

  /**
   * The viewer's escape hatch when the WebView refuses to autoplay. A REAL
   * attempt, not a placebo: the tap is a user gesture inside the WebView's own
   * activity, which (with `mediaPlaybackRequiresUserAction` off) is what the
   * policy was waiting for, and it also unmutes in case the embed fell back to
   * muted playback.
   */
  const onStartPlayback = (): void => {
    post(unMuteCommand());
    post(volumeCommand(volumeRef.current));
    post(playCommand());
    blockedSinceRef.current = null;
    setAutoplayBlocked(false);
  };

  const errorMessage =
    playerError === null
      ? null
      : playerError === "embedDisabled"
        ? t("mobile:watchParty.errorEmbedDisabled")
        : playerError === "notFound"
          ? t("mobile:watchParty.errorNotFound")
          : t("mobile:watchParty.errorPlayback");

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.rail,
        borderRadius: radius.xl,
        borderCurve: "continuous",
        overflow: "hidden",
      }}
    >
      {source === null ? (
        // Unreachable in practice (the server only ever stores a normalized id),
        // but a null URL must render an explanation rather than a black box.
        <View
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            padding: space.lg,
          }}
        >
          <Text style={{ color: colors.fgMuted, fontSize: 13, textAlign: "center" }}>
            {t("mobile:watchParty.errorPlayback")}
          </Text>
        </View>
      ) : (
        // The inert wrapper for viewers. `pointerEvents="none"` on the PARENT is
        // what actually stops touches reaching the WebView — a prop on the
        // WebView itself is not honoured by the native view on Android.
        <View style={{ flex: 1 }} pointerEvents={isHost ? "auto" : "none"}>
          <WebView
            ref={webRef}
            source={source}
            onMessage={onMessage}
            // Top-frame containment. The embed may move around inside its own
            // subframes; it may never replace our player with a web page.
            onShouldStartLoadWithRequest={allowWatchNavigation}
            // `["*"]` is NOT a widened permission here — it disables a DIFFERENT
            // mechanism that would be actively wrong.
            //
            // react-native-webview applies `originWhitelist` BEFORE our handler,
            // and a URL that fails it is not cancelled: it is handed to
            // `Linking.openURL`, i.e. opened in the system browser. That is the
            // opposite of the desktop rule this feature is built on ("a refused
            // navigation is cancelled, NOT re-opened externally" — a frame
            // navigating itself is not a user asking to visit a page). It would
            // also fire on every subframe the embed navigates for consent and
            // ads, carpeting the phone with browser tabs during playback.
            //
            // So the whitelist is opened up and `allowWatchNavigation` becomes
            // the SOLE gate — and it genuinely cancels, because returning false
            // is what react-native-webview turns into "do not proceed".
            originWhitelist={["*"]}
            javaScriptEnabled
            // The embed keeps its playback/consent state here. Denying it does
            // not harden anything meaningful — the frame is already alone behind
            // a `default-src 'none'` CSP — and does break playback.
            domStorageEnabled
            // Autoplay: the whole feature is "everyone is at the same second",
            // which cannot survive every viewer having to tap first. The gate
            // above is the fallback for when the platform refuses anyway.
            mediaPlaybackRequiresUserAction={false}
            allowsInlineMediaPlayback
            // The host has YouTube's own chrome, including its fullscreen
            // button. Letting the WebView honour it keeps that button real
            // rather than a control that does nothing (§35).
            allowsFullscreenVideo
            // No second window may be opened from inside the frame.
            setSupportMultipleWindows={false}
            // Video decoding on the GPU layer. Software compositing a 720p embed
            // beside a live LiveKit room is what makes both stutter.
            androidLayerType="hardware"
            // Our document is a black shell; a white flash between mount and
            // first paint reads as a crash on a dark UI.
            style={{ flex: 1, backgroundColor: colors.rail }}
            containerStyle={{ backgroundColor: colors.rail }}
            startInLoadingState
            renderLoading={() => (
              <View
                style={{
                  ...StyleSheetAbsoluteFill,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: colors.rail,
                }}
              >
                <ActivityIndicator size="small" color={colors.accent} />
              </View>
            )}
          />
        </View>
      )}

      {autoplayBlocked && !isHost && source !== null ? (
        <View
          style={{
            ...StyleSheetAbsoluteFill,
            alignItems: "center",
            justifyContent: "center",
            gap: space.md,
            backgroundColor: colors.scrim,
            paddingHorizontal: space.lg,
          }}
        >
          <Text style={{ color: colors.fg, fontSize: 13, lineHeight: 18, textAlign: "center" }}>
            {t("mobile:watchParty.autoplayBlocked")}
          </Text>
          <Button
            variant="accent"
            icon={Play}
            haptic="light"
            label={t("mobile:watchParty.startPlayback")}
            onPress={onStartPlayback}
          />
        </View>
      ) : null}

      {errorMessage !== null ? (
        <View
          accessibilityRole="alert"
          style={{
            position: "absolute",
            left: space.sm,
            right: space.sm,
            bottom: space.sm,
            flexDirection: "row",
            alignItems: "flex-start",
            gap: space.sm,
            borderRadius: radius.lg,
            borderCurve: "continuous",
            backgroundColor: colors.glassStrong,
            paddingHorizontal: space.md,
            paddingVertical: space.sm,
          }}
        >
          <TriangleAlert size={16} color={colors.warning} strokeWidth={2} style={{ marginTop: 1 }} />
          <Text style={{ flex: 1, color: colors.fg, fontSize: 12, lineHeight: 17 }}>
            {errorMessage}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** `StyleSheet.absoluteFillObject`, inlined so the overlays read in one place. */
const StyleSheetAbsoluteFill = {
  position: "absolute",
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
} as const;

/**
 * Memoized (§27): the parent re-renders whenever the roster or anyone's presence
 * ticks, and none of that changes what is on screen here. With a stable
 * `onHostControl` the only props that actually move are `session` and the volume,
 * so the player re-renders on a real sync frame and on nothing else — which on a
 * phone is the difference between a smooth video and a stuttering one.
 */
export const WatchPartyPlayer = memo(WatchPartyPlayerImpl);
