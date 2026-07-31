/**
 * Mobile screen-share ACQUISITION (task #45) — the RN counterpart of the desktop
 * renderer's Electron capture bridge + `getDisplayMedia`.
 *
 * The shared voice engine (`@demli/media`) owns screen-share PUBLISHING and
 * lifecycle: `engine.startScreenShare(acquire, { quality })` calls this injected
 * `acquire()` to get the already-captured track, then publishes it (source
 * `screen_share`), wires OS-initiated track-end, and flips the single
 * `screenShareEnabled` FSM flag (§11). This module is ONLY the platform
 * acquisition seam — it never imports the engine and never publishes.
 *
 * Android: `mediaDevices.getDisplayMedia()` (from `@livekit/react-native-webrtc`)
 * triggers the system MediaProjection consent dialog and, on grant, starts the
 * native `MediaProjectionService` — a foreground service typed `mediaProjection`
 * declared by the react-native-webrtc library manifest and enabled by
 * `LiveKitReactNative.setup()` (`enableMediaProjectionService = true`, wired via
 * plugins/with-livekit-setup.js). The app only needs the
 * `FOREGROUND_SERVICE_MEDIA_PROJECTION` permission (app.json). iOS goes through
 * the same `getDisplayMedia`, which presents the broadcast picker.
 *
 * SYSTEM AUDIO (the film's sound): NOT captured. `@livekit/react-native-webrtc`'s
 * `getDisplayMedia()` takes no constraints and returns a video-only stream
 * (`tracks: [track]` in its native bridge), so there is no loopback/system-audio
 * track to publish. Video-only is the agreed mobile MVP for #45 — the engine's
 * screen-share-audio path stays dormant (assets.audio = null). Desktop remains
 * the system-audio host.
 *
 * CAPTURE SIZE / FRAME RATE ARE NOT CONTROLLABLE FROM JS (verified against the
 * installed @livekit/react-native-webrtc, not assumed — this is the thing to
 * re-check when the library is upgraded):
 *  - `getDisplayMedia()` is declared `(): Promise<MediaStream>` and calls
 *    `WebRTCModule.getDisplayMedia()` with NO payload (src/getDisplayMedia.ts), so
 *    there is no constraints argument to pass. Desktop's equivalent DOES constrain
 *    (apps/desktop/.../screen-share.ts caps width/height/frameRate to the chosen
 *    profile); mobile structurally cannot.
 *  - Android `GetUserMediaImpl.createScreenTrack()` hardcodes the capture size to
 *    the activity's `DisplayMetrics`, and `ScreenCaptureController` hardcodes
 *    `DEFAULT_FPS = 30` (and an OrientationEventListener re-asserts both on every
 *    rotation).
 *  - `track.applyConstraints()` is not an escape hatch either: only
 *    `CameraCaptureController` overrides it; `ScreenCaptureController` inherits
 *    `AbstractVideoCaptureController.applyConstraints`, which rejects with
 *    `UnsupportedOperationException`.
 *
 * Consequences to keep in mind when reading the quality matrix (§ packages/media
 * quality.ts): on mobile the user's chosen tier reaches only the ENCODER, never the
 * capturer. The phone always encodes its full physical panel (~2.6 MP portrait), and
 * the 60fps tiers cannot be honoured — capture is pinned at 30. Making the tier real
 * on mobile requires a native patch/fork of the capture controller, which is a
 * separate, escalated piece of work.
 */
import { mediaDevices } from "@livekit/react-native-webrtc";
import type { AcquireScreenShare, ScreenShareAssets } from "@demli/media";
import { mediaError, normalizeMediaError } from "./permissions";

/**
 * Acquire the phone's screen as a publishable track. Resolves with the screen
 * VIDEO track (system audio unsupported on RN — see the file header, so
 * `audio` is always null). Rejects with a DOMException-named error the engine
 * classifies into a §26 message:
 *  - the user declining / cancelling the MediaProjection (Android) or broadcast
 *    (iOS) consent → `NotAllowedError` → `permission_denied(screen)`.
 *  - a rare capture failure (no active surface, native error) → passed through
 *    normalized; unknown shapes fall back to `NotAllowedError` because the only
 *    realistic screen-capture failure on mobile is a declined/aborted consent.
 */
export const acquireScreenShare: AcquireScreenShare = async (): Promise<ScreenShareAssets> => {
  let stream;
  try {
    stream = await mediaDevices.getDisplayMedia();
  } catch (err) {
    // getDisplayMedia rejects with a react-native-webrtc `MediaStreamError`
    // ({ name?, message? }) when consent is declined/aborted or capture fails.
    // Normalize known DOM names; otherwise treat as a declined consent (the
    // dominant mobile case) so the banner reads "screen share was denied".
    const normalized = normalizeMediaError(err);
    if (normalized.name === "NotFoundError" || normalized.name === "NotAllowedError") {
      throw normalized;
    }
    throw mediaError(
      "NotAllowedError",
      normalized.message || "Screen share was cancelled.",
    );
  }

  const video = stream.getVideoTracks()[0];
  if (!video) {
    // Consent granted but no video surface came back — stop anything dangling
    // and surface a declined-style error rather than publishing an empty share.
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // best-effort
      }
    }
    throw mediaError("NotAllowedError", "No screen surface was captured.");
  }

  // The engine's ScreenShareAssets.video is the DOM `MediaStreamTrack` type; the
  // RN track is structurally compatible for what the engine uses (publishTrack,
  // add/removeEventListener('ended'), stop()). Cast at this single seam — the
  // same loose-cast the RN adapter already applies for publishTrack.
  return { video: video as unknown as MediaStreamTrack, audio: null };
};
