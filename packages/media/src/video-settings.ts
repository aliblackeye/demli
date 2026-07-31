/**
 * User-level VIDEO settings model (Ayarlar → görüntü) — the typed source of
 * truth for camera capture quality (resolution + FPS) and the screen-share
 * (yayın) quality tier. Like audio-settings.ts this lives in `@demli/media`
 * so the capture-option logic is not scattered across UIs: both clients persist
 * a {@link VideoSettings} and hand it to `engine.configureVideo(settings)`.
 *
 * Livekit-free / DOM-free (RN-safe): pure data + a camera-capture resolver. The
 * engine maps the camera resolution/FPS onto livekit's `VideoCaptureOptionsLike`
 * at camera publish; the screen-share tier reuses the existing quality.ts preset
 * (`ScreenShareQuality`) which already maps to the `screenShareEncoding` ceiling.
 */

import type {
  SimulcastLayerLike,
  VideoCaptureOptionsLike,
  VideoPublishOptionsLike,
} from "./room-adapter.js";
import {
  DEFAULT_SCREEN_SHARE_QUALITY,
  normalizeScreenShareQuality,
  type ScreenShareQuality,
} from "./quality.js";

/**
 * Camera quality (Kamera kalitesi):
 *  - auto (Otomatik): no resolution cap — let the device/livekit decide.
 *  - hd (720p): 1280×720.
 *  - fhd (1080p): 1920×1080.
 */
export type CameraQuality = "auto" | "hd" | "fhd";

/** Ordered for UIs. */
export const CAMERA_QUALITIES: readonly CameraQuality[] = ["auto", "hd", "fhd"];

/** Camera frame-rate (FPS) — cameras must support up to 60fps. */
export type CameraFrameRate = 30 | 60;

/** Ordered for UIs. */
export const CAMERA_FRAME_RATES: readonly CameraFrameRate[] = [30, 60];

/** Pixel dimensions per camera tier; `null` for auto (unconstrained). */
export const CAMERA_QUALITY_PROFILES: Readonly<
  Record<CameraQuality, { width: number; height: number } | null>
> = {
  auto: null,
  hd: { width: 1280, height: 720 },
  fhd: { width: 1920, height: 1080 },
};

/**
 * Explicit PUBLISH bitrate ceiling (bits/sec) per camera tier. livekit's own
 * defaults are conservative — h720 = 1.7 Mbps, h1080 = 3 Mbps — so a 1080p camera
 * looks soft out of the box (and simulcast splits that budget further). These are
 * aggressive by design: this is a private friend call, bandwidth is fine, and the
 * founder wants the camera visibly sharp.
 *  - auto: 2.5 Mbps — a genuinely good default (livekit picks ~720p capture; the
 *    ceiling makes it crisp instead of the soft 1.7 Mbps default).
 *  - hd (720p): 2.5 Mbps.
 *  - fhd (1080p): 5 Mbps.
 */
export const CAMERA_QUALITY_MAX_BITRATE_BPS: Readonly<Record<CameraQuality, number>> = {
  auto: 2_500_000,
  hd: 2_500_000,
  fhd: 5_000_000,
};

/**
 * Encoder degradation trade for the published CAMERA track — deliberately NOT the
 * screen-share trade (see `SCREEN_SHARE_DEGRADATION_PREFERENCE` in quality.ts, which
 * is `maintain-framerate` for a film). A camera and a shared film want opposite
 * things and the two profiles must never be unified.
 *
 * `balanced` is what libwebrtc/livekit themselves use for a camera track, and it is
 * the ONLY value that cannot freeze the picture:
 *  - `maintain-resolution` (what we shipped before, as a "mobile blur fix") forbids
 *    the encoder from ever scaling down, so a CPU/thermally constrained phone can
 *    only shed FRAME-RATE — libwebrtc walks it down to its ~2fps floor. Viewers read
 *    that as the camera being FROZEN (the founder's mobile-camera-freeze P0). It is
 *    also the wrong premise: livekit's own camera default was never
 *    `maintain-framerate`, it is `balanced` (`getDefaultDegradationPreference` only
 *    picks `maintain-resolution` for screen share or a ≥1080p constraint).
 *  - `maintain-framerate` is the film trade: hold fps, let resolution collapse. On a
 *    face that reads as a permanent blur.
 *  - `balanced` sheds RESOLUTION first at HD sizes and only allows modest frame-rate
 *    steps once the picture is already small (libwebrtc's `BalancedDegradationSettings`
 *    keeps an fps floor per resolution bucket). The picture always keeps MOVING.
 *
 * Applied to every tier, including `fhd` — we deviate from livekit's ≥1080p
 * `maintain-resolution` heuristic on purpose: a frozen call is never an acceptable
 * trade for sharpness (CLAUDE.md §6, voice/call quality bar). Sharpness at 1080p is
 * carried by {@link CAMERA_QUALITY_MAX_BITRATE_BPS} + the simulcast top layer, not by
 * forbidding the encoder to adapt. Desktop rarely degrades at all, so this is a
 * mobile-visible change only.
 */
export const CAMERA_DEGRADATION_PREFERENCE = "balanced" as const;

/**
 * The custom LOW simulcast layer for the camera — 640×360 @ 500 kbps, deliberately
 * far above livekit's soft 320×180 @ ~160 kbps default low layer, so a weak or
 * small-tile subscriber rides something legible instead of stalling on a single
 * full-quality stream (the founder's freeze report). Capped at 30fps so the fallback
 * stays light even when the top layer is 60fps.
 *
 * SCOPE — read this before reasoning about camera layers. Since the switch to VP9
 * (`VIDEO_CODEC`, see livekit.ts `publishDefaults`) this layer applies only to the
 * VP8 BACKUP stream served to a subscriber that cannot decode VP9. The PRIMARY
 * camera stream does not use simulcast at all: for an SVC codec livekit ignores
 * `videoSimulcastLayers` and publishes ONE encode with `scalabilityMode: 'L3T3_KEY'`
 * — three SPATIAL layers at full, 1/2 and 1/4 resolution (1280×720 / 640×360 /
 * 320×180 for a 720p capture). So the camera already has a three-step ladder, and
 * adding a "middle" entry here would change nothing for almost every viewer.
 *
 * The corollary matters more: because SVC is a single encode, ALL THREE spatial
 * layers are always produced whether or not anyone subscribes to them. Which layer a
 * viewer receives is therefore a pure DOWNLINK/forwarding decision with zero effect
 * on the publisher's uplink — see the `adaptiveStream` note in livekit.ts.
 */
export const CAMERA_LOW_SIMULCAST_LAYER: SimulcastLayerLike = {
  width: 640,
  height: 360,
  encoding: { maxBitrate: 500_000, maxFramerate: 30 },
};

/**
 * The capture floor for MOBILE (720p @ 30fps). The default camera tier is "auto",
 * whose capture options are `undefined` (see {@link cameraCaptureOptionsFor}) so
 * the platform decides. On desktop livekit's built-in default already lands on
 * 720p; on React Native the raw `react-native-webrtc` default can be far lower
 * (an arbitrary low camera format), which is exactly why the mobile self-view —
 * and what peers received — looked soft. The mobile room hands THIS to livekit's
 * `videoCaptureDefaults.resolution` so the default ("auto") path captures a solid
 * 720p on the phone too, deterministically. Explicit HD/FHD tiers still override
 * it via {@link cameraCaptureOptionsFor}. Desktop does not use this (its default
 * is already correct); keeping it mobile-only avoids changing desktop capture.
 */
export const MOBILE_CAMERA_CAPTURE_DEFAULT: Readonly<{
  width: number;
  height: number;
  frameRate: number;
}> = { width: 1280, height: 720, frameRate: 30 };

export interface VideoSettings {
  cameraQuality: CameraQuality;
  cameraFrameRate: CameraFrameRate;
  /** Screen-share (yayın) tier — the existing quality.ts preset, unified here. */
  screenShareQuality: ScreenShareQuality;
}

export const DEFAULT_VIDEO_SETTINGS: VideoSettings = {
  cameraQuality: "auto",
  cameraFrameRate: 30,
  screenShareQuality: DEFAULT_SCREEN_SHARE_QUALITY,
};

/**
 * The livekit `VideoCaptureOptions` (resolution + frameRate) for a camera tier.
 * Returns `undefined` for the pure-default case (auto quality at 30fps) so the
 * default publish path is byte-for-byte livekit's default. For `auto` at 60fps
 * we still pin a 720p base so the higher frame-rate actually takes effect (a
 * resolution is required to carry frameRate through livekit's VideoResolution).
 */
export function cameraCaptureOptionsFor(
  quality: CameraQuality,
  frameRate: CameraFrameRate,
): VideoCaptureOptionsLike | undefined {
  const profile = CAMERA_QUALITY_PROFILES[quality];
  if (!profile) {
    // auto: only constrain when the user opts into 60fps (30 is already ~default).
    return frameRate === 60
      ? { resolution: { width: 1280, height: 720, frameRate: 60 } }
      : undefined;
  }
  return { resolution: { width: profile.width, height: profile.height, frameRate } };
}

/**
 * The livekit camera PUBLISH options (explicit `videoEncoding` ceiling +
 * degradation trade) for a tier + frame-rate. Always returns options — even
 * `auto` — because the whole point is to REPLACE livekit's soft defaults so the
 * camera is sharp:
 *  - `videoEncoding` pins an aggressive bitrate (livekit's default is
 *    conservative) with `maxFramerate` matching the capture FPS so 60fps tiers get
 *    a 60fps encode budget.
 *  - `degradationPreference` is `balanced` so a constrained device (esp. a phone)
 *    sheds resolution progressively and the picture never STOPS — see
 *    {@link CAMERA_DEGRADATION_PREFERENCE} for why the camera must not reuse the
 *    screen-share trade, and why `maintain-resolution` froze mobile cameras.
 *  - `simulcast` is ON with CUSTOM 2-layer presets (see {@link CAMERA_LOW_SIMULCAST_LAYER}
 *    and {@link VideoPublishOptionsLike.videoSimulcastLayers}): a usable low layer
 *    (640×360 @ 500 kbps) + the aggressive top (`videoEncoding`). A single full-quality
 *    layer (the previous `simulcast: false`) had no fallback, so a weak subscriber
 *    couldn't keep up and the picture STALLED/FROZE (the founder's freeze report).
 *    With two layers a weak/small-tile viewer rides the smooth low layer while a
 *    focused/fullscreen tile — large enough that adaptiveStream requests HIGH — pulls
 *    the sharp top layer. Quality where it matters, no stall where the network is weak
 *    (CLAUDE.md §6/§33).
 */
export function cameraPublishOptionsFor(
  quality: CameraQuality,
  frameRate: CameraFrameRate,
): VideoPublishOptionsLike {
  return {
    videoEncoding: {
      maxBitrate: CAMERA_QUALITY_MAX_BITRATE_BPS[quality],
      maxFramerate: frameRate,
    },
    // Custom 2-layer simulcast: one low preset + the top `videoEncoding` above. See
    // the doc block and VideoPublishOptionsLike.{simulcast,videoSimulcastLayers}.
    simulcast: true,
    videoSimulcastLayers: [CAMERA_LOW_SIMULCAST_LAYER],
    degradationPreference: CAMERA_DEGRADATION_PREFERENCE,
  };
}

// ---------------------------------------------------------------------------
// Type guards + normalization for untrusted persisted values.
// ---------------------------------------------------------------------------

export function isCameraQuality(value: unknown): value is CameraQuality {
  return value === "auto" || value === "hd" || value === "fhd";
}

export function isCameraFrameRate(value: unknown): value is CameraFrameRate {
  return value === 30 || value === 60;
}

/** Build a valid {@link VideoSettings} from an untrusted persisted blob. */
export function normalizeVideoSettings(raw: unknown): VideoSettings {
  const r = (raw ?? {}) as Partial<Record<keyof VideoSettings, unknown>>;
  return {
    cameraQuality: isCameraQuality(r.cameraQuality)
      ? r.cameraQuality
      : DEFAULT_VIDEO_SETTINGS.cameraQuality,
    cameraFrameRate: isCameraFrameRate(r.cameraFrameRate)
      ? r.cameraFrameRate
      : DEFAULT_VIDEO_SETTINGS.cameraFrameRate,
    // Legacy tiers (smooth/balanced/cinema) map to their nearest matrix cell so an
    // old persisted settings blob survives the matrix evolution (P0: persist must
    // not break); an unknown value falls back to the default.
    screenShareQuality: normalizeScreenShareQuality(r.screenShareQuality),
  };
}
