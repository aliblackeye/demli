import { useEffect, useMemo } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { VideoTrack } from "@livekit/react-native";
import ExpoPip from "expo-pip";
import { pickSpeakingSubject } from "@demli/media";
import {
  useLocalCameraTrack,
  useRemoteCameras,
  useRemoteScreenShares,
  useVoiceStore,
} from "@/stores/voice-store";
import { colors } from "@/theme/theme";
import { useActiveSpeakers } from "./active-speakers";
import { PIP_OBJECT_FIT, resolvePipAspect, type PipSubjectKind } from "./pip-overlay";
import { toVideoTrackRef } from "./track-ref";
import { useIsInPipWindow } from "./use-pip-window";

/**
 * Android system Picture-in-Picture for live video (video-stage-requirements
 * #5-7, call-ux-plan K5). When the app is backgrounded (home button) during a
 * live video session, Android floats a small window that keeps the call's video
 * on screen while the user multitasks.
 *
 * Mechanism:
 *  - `expo-pip`'s config plugin sets `android:supportsPictureInPicture` on
 *    MainActivity (build-time). At runtime we set `autoEnterEnabled: true` while
 *    there is video worth showing, so the OS enters PiP automatically on
 *    background — no explicit enter call, no reliance on a lifecycle race. We
 *    turn it off when the session ends.
 *  - The window's ASPECT RATIO follows what we are about to show instead of a
 *    hardcoded 16:9 (see `resolvePipAspect`), clamped into the range Android
 *    accepts, and the video is drawn `contain` so it is never cropped.
 *  - `useIsInPip()` tracks the mode. Only while actually in PiP do we render a
 *    minimal full-bleed view of the subject on the brand backdrop, covering the
 *    app so the tiny window shows just that video (§7 "minimal view"). The render
 *    gate ALSO requires the app to be backgrounded (RN AppState) and a track to
 *    be present — see `shouldShowPipOverlay` — so a stale-true `isInPipMode` can
 *    never leave the cover stuck over the live app on resume.
 *
 * WHAT THE WINDOW SHOWS, in priority order (K5):
 *   remote screen share > the talking person's camera > the last talker's camera
 *   > any remote camera > your OWN camera.
 * "Who is talking" comes from the ONE shared `ActiveSpeakerTracker`
 * (`@demli/media`) via `useActiveSpeakers()` — with 300 ms attack / 5 s
 * release hysteresis, so the window does not change hands on every syllable, and
 * with a remembered last speaker, so a silent room keeps showing the person who
 * was just talking instead of snapping to whoever happens to be first in the
 * track list (the old `remoteCameras[0]` fallback, which is what the founder saw).
 *
 * Self camera is the LAST resort on purpose: you already know what you look like,
 * so it only takes the window when there is nothing else — but it does take it,
 * so PiP still works in a call where only your camera is on.
 *
 * Scope: Android only (`ExpoPip.isAvailable()` is Android-gated, and iOS WebRTC
 * PiP is a separate `VideoTrack iosPIP` path — deferred, this is an Android-first
 * wave). Everything degrades safely — expo-pip no-ops when the native module is
 * absent, and the effect is wrapped so a PiP config error can never break the app.
 *
 * Mounted once app-level (authed `_layout`), so it covers BOTH group voice and DM
 * calls (same engine/store). Renders null except while in PiP.
 */
interface PipVideoSubject {
  kind: PipSubjectKind;
  /** The live livekit track object (never copied into React state, §27). */
  track: object;
  /** True for our OWN camera — mirrored, like every other self-preview. */
  isSelf: boolean;
}

export function PipController() {
  const connected = useVoiceStore((s) => s.status === "connected");
  const remoteCameras = useRemoteCameras();
  const screenShares = useRemoteScreenShares();
  const localCamera = useLocalCameraTrack();
  const speakers = useActiveSpeakers();

  const subject = useMemo<PipVideoSubject | null>(() => {
    // 1. A remote screen share always wins — it is the thing people are looking
    //    at. With several, prefer the one whose owner is talking.
    const share = pickSpeakingSubject(screenShares, speakers) ?? screenShares[0];
    if (share) return { kind: "screen", track: share.track, isSelf: false };
    // 2. The talking (or most recently talking) remote camera. `pickSpeakingSubject`
    //    returns null when the talker has no camera on, so we fall through to any
    //    remote camera rather than showing nothing.
    const camera = pickSpeakingSubject(remoteCameras, speakers) ?? remoteCameras[0];
    if (camera) return { kind: "camera", track: camera.track, isSelf: false };
    // 3. Nothing remote to show: fall back to our own camera so PiP still works.
    if (localCamera) return { kind: "camera", track: localCamera, isSelf: true };
    return null;
  }, [screenShares, remoteCameras, localCamera, speakers]);

  // Auto-PiP is only worth enabling while connected with video to show.
  const canPip = connected && subject !== null;
  const aspect = resolvePipAspect({ kind: subject?.kind ?? null });

  useEffect(() => {
    if (Platform.OS !== "android") return;
    try {
      if (!ExpoPip.isAvailable()) return;
      ExpoPip.setPictureInPictureParams({
        autoEnterEnabled: canPip,
        seamlessResizeEnabled: true,
        // Shape follows the content (portrait camera → portrait window), clamped
        // to what Android accepts. Safe to call while already in PiP: the OS
        // resizes the live window.
        width: aspect.width,
        height: aspect.height,
      });
    } catch {
      // best-effort — never let a PiP config error break the app.
    }
  }, [canPip, aspect.width, aspect.height]);

  // Resume-safe "are we really in the small window" (see useIsInPipWindow): a
  // stale-true `isInPipMode` must never leave this cover stuck over the live app.
  const inPipWindow = useIsInPipWindow();

  const pipTrackRef = useMemo(
    () => (subject ? toVideoTrackRef(subject.track) : null),
    [subject],
  );

  // Render the full-bleed cover ONLY while the OS has us in a PiP window, we are
  // backgrounded, and there is a track to show. Anything else — foreground, no
  // track — renders null so the cover can never become a blank screen over the
  // live app. Non-interactive (PiP windows don't take touches).
  if (!inPipWindow || pipTrackRef === null) {
    return null;
  }
  return (
    <View
      style={[
        StyleSheet.absoluteFill,
        { backgroundColor: colors.rail, zIndex: 100, elevation: 100 },
      ]}
      pointerEvents="none"
    >
      <VideoTrack
        trackRef={pipTrackRef}
        // Never crop: a cropped portrait camera is the "half a face" the founder
        // reported. Letterboxing lands on the brand backdrop above.
        objectFit={PIP_OBJECT_FIT}
        mirror={subject?.isSelf ?? false}
        style={{ flex: 1, backgroundColor: colors.rail }}
      />
    </View>
  );
}
