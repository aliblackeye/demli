/**
 * BANDWIDTH PRESSURE — a general "something heavy is competing for this
 * connection right now" signal for the media engine.
 *
 * WHY THIS IS NOT A WATCH-PARTY FLAG. The first consumer is the watch party
 * (M20): every viewer plays the film LOCALLY in their own `youtube-nocookie`
 * iframe, so nobody screen-shares and the voice room has no idea that each
 * client just started pulling a multi-megabit video stream alongside it. But the
 * media package must not learn product concepts (§23 — media lifecycle stays
 * separate from feature UI), and the watch party is not the only thing that will
 * ever do this: an in-app video/preview player, a large attachment upload or
 * download, a metered/hotspot mobile connection and a future "listen together"
 * all put the SAME kind of load on the SAME link. So the engine is told about
 * the CONDITION ("a sustained background transfer is sharing this uplink"), not
 * about the feature that caused it.
 *
 * Sources are REF-COUNTED by an opaque string key so consumers compose: two
 * things can be heavy at once and releasing one does not cancel the other's
 * pressure. It is a boolean per source rather than a numeric level on purpose —
 * the engine has exactly one constrained mode, and a level would be a knob
 * nobody could calibrate or test.
 *
 * WHAT PRESSURE MAY TOUCH: video only.
 *   - The local CAMERA's capture size + publish ceiling (uplink).
 *   - The screen-share adaptive controller's floor (it may shed further).
 * WHAT IT MUST NEVER TOUCH: audio. Not the mic bitrate, not the capture
 * constraints, not a subscription. Voice is priority #1 (§6) and is a rounding
 * error next to video anyway (~48 kbps against 2.5-5 Mbps), so throttling it
 * would cost the one thing that matters and save nothing.
 *
 * Livekit-free / DOM-free (RN-safe), like the rest of the package root.
 */

import type { VideoCaptureOptionsLike, VideoPublishOptionsLike } from "./room-adapter.js";
import {
  CAMERA_DEGRADATION_PREFERENCE,
  CAMERA_LOW_SIMULCAST_LAYER,
} from "./video-settings.js";
import type { ScreenShareQuality } from "./quality.js";

/**
 * An opaque consumer key for {@link VoiceEngine.setBandwidthPressure}. Plain
 * strings so a new consumer needs no change here; the engine only ever counts
 * them. Kept as a named type so call sites read as intent, not as "some string".
 */
export type BandwidthPressureSource = string;

/** The watch party (M20) — the first consumer. Exported so both platforms agree on the key. */
export const BANDWIDTH_SOURCE_WATCH_PARTY: BandwidthPressureSource = "watch-party";

/**
 * Camera CAPTURE cap while under pressure — 640×360 @ 30fps.
 *
 * The trade is deliberate and context-driven: while a heavy background transfer
 * is running, the camera tiles are not what the user is looking at (during a
 * watch party the stage is the film and the cameras are a filmstrip), so 360p is
 * already more than the tile resolves. Capturing smaller — rather than only
 * lowering the bitrate on a 1080p capture — is what actually keeps the picture
 * CLEAN: an encoder squeezed to 800 kbps at 1080p produces mush, at 360p it
 * produces a sharp small image.
 */
export const PRESSURE_CAMERA_CAPTURE: Readonly<{
  width: number;
  height: number;
  frameRate: number;
}> = { width: 640, height: 360, frameRate: 30 };

/**
 * Camera PUBLISH ceiling while under pressure — 800 kbps.
 *
 * Sized just above {@link CAMERA_LOW_SIMULCAST_LAYER} (640×360 @ 500 kbps) so the
 * constrained encode is a genuinely good 360p rather than a starved one. Against
 * the normal tiers (2.5 Mbps for auto/hd, 5 Mbps for fhd) this frees ~1.7 Mbps —
 * or ~4.2 Mbps at 1080p — of UPLINK per constrained camera.
 *
 * Uplink is the direction that matters here. Home connections are asymmetric, and
 * a saturated uplink does not just hurt what we send: it delays the TCP ACKs of
 * the very download that caused the pressure (so the film stalls too) and it queues
 * our own RTP/STUN, which is what turns the connection bar red. It is also the only
 * camera cost we can control — the SVC publish is a SINGLE encode at the ceiling, so
 * which spatial layer a VIEWER subscribes to costs the publisher nothing (see the
 * `CAMERA_LOW_SIMULCAST_LAYER` doc block in video-settings.ts).
 */
export const PRESSURE_CAMERA_MAX_BITRATE_BPS = 800_000;

/**
 * The screen-share adaptive floor while under pressure. The controller may shed
 * one tier further than its normal 720p30 floor, because under pressure the link
 * genuinely has less headroom than the floor assumes. Only reachable through the
 * existing RTT-driven controller — pressure alone never drops a share.
 */
export const PRESSURE_SCREEN_SHARE_FLOOR: ScreenShareQuality = "480p30";

/**
 * Camera capture constraints while constrained. Always explicit (never
 * `undefined`), because the whole point is to override whatever the platform
 * default or the user's tier would have captured.
 */
export function constrainedCameraCaptureOptions(): VideoCaptureOptionsLike {
  return {
    resolution: {
      width: PRESSURE_CAMERA_CAPTURE.width,
      height: PRESSURE_CAMERA_CAPTURE.height,
      frameRate: PRESSURE_CAMERA_CAPTURE.frameRate,
    },
  };
}

/**
 * Camera publish options while constrained, derived from what the user's settings
 * WOULD have published (`selected`).
 *
 * The ceiling is `min(selected, PRESSURE_CAMERA_MAX_BITRATE_BPS)` so this can only
 * ever LOWER the bitrate — a user who has already chosen something lighter than the
 * constrained tier is left exactly where they are, never quietly raised. Frame-rate
 * is likewise capped, not forced. The degradation trade and the low simulcast layer
 * are unchanged: the picture must still keep MOVING under pressure (see
 * {@link CAMERA_DEGRADATION_PREFERENCE}).
 */
export function constrainedCameraPublishOptions(
  selected: VideoPublishOptionsLike | undefined,
): VideoPublishOptionsLike {
  const selectedBitrate = selected?.videoEncoding?.maxBitrate;
  const selectedFrameRate = selected?.videoEncoding?.maxFramerate;
  return {
    videoEncoding: {
      maxBitrate:
        typeof selectedBitrate === "number" && selectedBitrate > 0
          ? Math.min(selectedBitrate, PRESSURE_CAMERA_MAX_BITRATE_BPS)
          : PRESSURE_CAMERA_MAX_BITRATE_BPS,
      maxFramerate:
        typeof selectedFrameRate === "number" && selectedFrameRate > 0
          ? Math.min(selectedFrameRate, PRESSURE_CAMERA_CAPTURE.frameRate)
          : PRESSURE_CAMERA_CAPTURE.frameRate,
    },
    simulcast: true,
    videoSimulcastLayers: [CAMERA_LOW_SIMULCAST_LAYER],
    degradationPreference: CAMERA_DEGRADATION_PREFERENCE,
  };
}
