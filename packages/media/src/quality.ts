/**
 * Media quality presets — the screen-share (yayın) quality MATRIX and the mic
 * publish-bitrate mapping.
 *
 * Screen share is a full {resolution} × {frame-rate} matrix (founder P0 #112:
 * "let the streamer pick 15/30/60 × 480p/720p/1080p/2K"). A single source-of-truth
 * profile table ({@link SCREEN_SHARE_QUALITY_PROFILES}) maps every cell to a
 * CAPTURE size + frame-rate AND a HEALTHY encoder bitrate ceiling. There is no
 * uncapped tier — every profile has a finite `maxBitrateBps`, which is what keeps
 * the publisher from saturating the uplink and spiking everyone's ping / turning
 * the connection bar red (the bufferbloat report). The engine maps a profile onto
 * livekit publish options (`screenShareEncoding` for the screen video track); the
 * desktop renderer maps the SAME profile onto its getDisplayMedia capture
 * constraints (`SCREEN_SHARE_QUALITY_PROFILES[id].width/height/frameRate`), so
 * capture and encoder always agree on resolution/frame-rate.
 *
 * Livekit-free and platform-agnostic (RN-safe, like the rest of the package
 * root): pure data + mapping helpers.
 */

import type { AudioPresetLike, VideoEncodingLike } from "./room-adapter.js";

/** Screen-share resolution tiers (the vertical pixel count / label). 1440p == 2K. */
export type ScreenShareResolution = "480p" | "720p" | "1080p" | "1440p";

/** Screen-share frame-rate tiers, in fps. */
export type ScreenShareFrameRate = 15 | 30 | 60;

/**
 * A screen-share quality id — the `${resolution}${frameRate}` matrix cell, e.g.
 * `"1080p30"`, `"720p60"`, `"1440p60"`. This composite string is the single value
 * that persists and travels through the engine publish path; it decomposes back to
 * its axes via {@link screenShareResolutionOf} / {@link screenShareFrameRateOf} (a
 * table lookup, never string parsing).
 */
export type ScreenShareQuality = `${ScreenShareResolution}${ScreenShareFrameRate}`;

export interface ScreenShareQualityProfile {
  /** The resolution tier this profile belongs to (its label axis). */
  resolution: ScreenShareResolution;
  /** Capture width cap in px (the renderer constrains getDisplayMedia to this). */
  width: number;
  /** Capture height cap in px. */
  height: number;
  /** Capture + encoder frame-rate cap. */
  frameRate: ScreenShareFrameRate;
  /** Encoder bitrate ceiling in bits per second — never absent (no uncapped tier). */
  maxBitrateBps: number;
}

/** Resolution tiers, ordered low → high (for axis pickers). */
export const SCREEN_SHARE_RESOLUTIONS: readonly ScreenShareResolution[] = [
  "480p",
  "720p",
  "1080p",
  "1440p",
];

/** Frame-rate tiers, ordered low → high (for axis pickers). */
export const SCREEN_SHARE_FRAME_RATES: readonly ScreenShareFrameRate[] = [15, 30, 60];

/**
 * The highest frame rate ANDROID can actually capture from the screen: 30.
 *
 * `ScreenCaptureController.java` in `@livekit/react-native-webrtc` hard-codes
 * `DEFAULT_FPS = 30` and passes it to both the constructor and
 * `changeCaptureFormat`. `applyConstraints` is not an escape hatch either — the
 * controller does not override it, so the base class throws
 * `UnsupportedOperationException`. Nothing reachable from JavaScript changes it.
 *
 * So on Android a 60fps choice does not produce 60 frames. It raises the encoder's
 * bitrate CEILING (6.5 Mbps instead of 4.5 at 1080p) and asks the encoder for a
 * cadence the capturer never delivers — the user pays uplink for frames that do not
 * exist. 15fps is honest, because capping the ENCODER below the capture rate does
 * work; only the tier above 30 is the lie.
 *
 * Offering it anyway would be a §35 dead control, so mobile pickers filter through
 * {@link screenShareFrameRatesUpTo}. Desktop is unaffected: Electron's
 * `desktopCapturer` honours the requested rate. Raise this the day a native patch
 * makes the capture rate configurable — and not before, because the constant is a
 * claim about the platform, not a preference.
 */
export const ANDROID_SCREEN_CAPTURE_MAX_FPS: ScreenShareFrameRate = 30;

/**
 * The frame-rate tiers a surface should OFFER, given what it can capture.
 *
 * Filtering the list beats disabling chips: a greyed-out 60 still invites the
 * question "why not?", and the honest answer is that the tier does not exist here.
 */
export function screenShareFrameRatesUpTo(
  maxFps: ScreenShareFrameRate,
): readonly ScreenShareFrameRate[] {
  return SCREEN_SHARE_FRAME_RATES.filter((fps) => fps <= maxFps);
}

/**
 * Pull a saved quality id down to what this surface can capture.
 *
 * Needed because the setting is shared across devices and predates this filter: an
 * account that picked `1080p60` on desktop must not leave the phone's picker with
 * nothing selected, or worse, silently publishing at a tier that is not on screen.
 */
export function clampScreenShareQualityToFps(
  quality: ScreenShareQuality,
  maxFps: ScreenShareFrameRate,
): ScreenShareQuality {
  const frameRate = screenShareFrameRateOf(quality);
  if (frameRate <= maxFps) return quality;
  return screenShareQualityId(screenShareResolutionOf(quality), maxFps);
}

/** 16:9 pixel dimensions per resolution tier. */
const SCREEN_SHARE_DIMENSIONS: Readonly<
  Record<ScreenShareResolution, { width: number; height: number }>
> = {
  "480p": { width: 854, height: 480 },
  "720p": { width: 1280, height: 720 },
  "1080p": { width: 1920, height: 1080 },
  "1440p": { width: 2560, height: 1440 },
};

/**
 * Encoder bitrate CEILING (bits/sec) per {resolution × frame-rate} cell, calibrated
 * for MOTION / film content (the founder's movie-night use case) — higher than
 * livekit's slide-oriented `ScreenSharePresets` (which top out at 1080p30 @ 3 Mbps)
 * because a film has full-frame motion, but every value is a hard, sane cap:
 *
 *          15fps      30fps      60fps
 *   480p   0.8 Mbps   1.2 Mbps   1.8 Mbps
 *   720p   1.5 Mbps   2.5 Mbps   4.0 Mbps
 *  1080p   3.0 Mbps   4.5 Mbps   6.5 Mbps
 *  1440p   4.0 Mbps   5.0 Mbps   7.0 Mbps
 *
 * The ceilings scale ~1.5× per frame-rate doubling (a 60fps stream needs more
 * budget than 30fps for the same per-frame quality) and ~1.8× per resolution step.
 * 1440p60 (2K, 7 Mbps) is the top; it is still a CAP — GCC backs the encoder off
 * below it under congestion — so the publisher never floods a real uplink. Keeping
 * every cell capped is the direct remedy for the "stream on → ping spikes → bar goes
 * red" bufferbloat report: a bounded, motion-hinted stream can't monopolise the
 * egress queue the way an unbounded VBR burst does.
 *
 * The 2K (1440p) ceilings were trimmed (was 4.5/6.0/9.0 Mbps) when the publish codec
 * moved to VP9: VP9 is ~30-50% more efficient than the old VP8, so 7 Mbps of VP9 at
 * 1440p60 looks the same as — or better than — the old 9 Mbps of VP8, while a ~2 Mbps
 * lower peak is exactly the initial-burst headroom that keeps a 2K stream from
 * saturating a typical home uplink the instant it starts (before the adaptive
 * downgrade controller has data to act on). The mid/low cells were already efficient
 * enough that VP9 just buys them quality headroom, so they are unchanged.
 */
const SCREEN_SHARE_MAX_BITRATE_BPS: Readonly<
  Record<ScreenShareResolution, Record<ScreenShareFrameRate, number>>
> = {
  "480p": { 15: 800_000, 30: 1_200_000, 60: 1_800_000 },
  "720p": { 15: 1_500_000, 30: 2_500_000, 60: 4_000_000 },
  "1080p": { 15: 3_000_000, 30: 4_500_000, 60: 6_500_000 },
  "1440p": { 15: 4_000_000, 30: 5_000_000, 60: 7_000_000 },
};

/** Compose the matrix id for a (resolution, frame-rate) pair, e.g. `"1080p30"`. */
export function screenShareQualityId(
  resolution: ScreenShareResolution,
  frameRate: ScreenShareFrameRate,
): ScreenShareQuality {
  return `${resolution}${frameRate}`;
}

/** The full profile table — every {resolution × frame-rate} cell (single source of truth). */
export const SCREEN_SHARE_QUALITY_PROFILES: Readonly<
  Record<ScreenShareQuality, ScreenShareQualityProfile>
> = (() => {
  const profiles = {} as Record<ScreenShareQuality, ScreenShareQualityProfile>;
  for (const resolution of SCREEN_SHARE_RESOLUTIONS) {
    const dim = SCREEN_SHARE_DIMENSIONS[resolution];
    for (const frameRate of SCREEN_SHARE_FRAME_RATES) {
      profiles[screenShareQualityId(resolution, frameRate)] = {
        resolution,
        width: dim.width,
        height: dim.height,
        frameRate,
        maxBitrateBps: SCREEN_SHARE_MAX_BITRATE_BPS[resolution][frameRate],
      };
    }
  }
  return profiles;
})();

/** Default screen-share quality — 1080p @ 30 fps (the sensible film default). */
export const DEFAULT_SCREEN_SHARE_QUALITY: ScreenShareQuality = "1080p30";

/**
 * All quality ids ordered lowest → highest by bitrate ceiling (for a flat list UI).
 * Prefer the two-axis {@link SCREEN_SHARE_RESOLUTIONS}/{@link SCREEN_SHARE_FRAME_RATES}
 * pickers in product UIs; this stays for completeness / tests.
 */
export const SCREEN_SHARE_QUALITIES: readonly ScreenShareQuality[] = Object.keys(
  SCREEN_SHARE_QUALITY_PROFILES,
)
  .sort(
    (a, b) =>
      SCREEN_SHARE_QUALITY_PROFILES[a as ScreenShareQuality].maxBitrateBps -
      SCREEN_SHARE_QUALITY_PROFILES[b as ScreenShareQuality].maxBitrateBps,
  ) as ScreenShareQuality[];

/**
 * Legacy tier ids (pre-matrix: Smooth / Balanced / Cinema) → their closest matrix
 * cell, so a persisted value survives the model change (founder P0: "persist must
 * not break"). Not a `ScreenShareQuality` map — the keys are the OLD strings.
 */
const LEGACY_SCREEN_SHARE_QUALITY: Readonly<Record<string, ScreenShareQuality>> = {
  smooth: "720p30",
  balanced: "1080p30",
  cinema: "1080p60",
};

/** Type guard for untrusted values (e.g. a persisted localStorage string). */
export function isScreenShareQuality(value: unknown): value is ScreenShareQuality {
  return typeof value === "string" && value in SCREEN_SHARE_QUALITY_PROFILES;
}

/**
 * Coerce an untrusted persisted value to a valid {@link ScreenShareQuality}:
 * a current matrix id passes through; a legacy tier (`smooth`/`balanced`/`cinema`)
 * maps to its nearest cell; anything else falls back to the default. This is the
 * backward-compat seam so an old settings blob keeps working after the matrix
 * evolution.
 */
export function normalizeScreenShareQuality(value: unknown): ScreenShareQuality {
  if (isScreenShareQuality(value)) return value;
  if (typeof value === "string") {
    const legacy = LEGACY_SCREEN_SHARE_QUALITY[value];
    if (legacy) return legacy;
  }
  return DEFAULT_SCREEN_SHARE_QUALITY;
}

/** The resolution axis of a quality id (table lookup). */
export function screenShareResolutionOf(
  quality: ScreenShareQuality,
): ScreenShareResolution {
  return SCREEN_SHARE_QUALITY_PROFILES[quality].resolution;
}

/** The frame-rate axis of a quality id (table lookup). */
export function screenShareFrameRateOf(
  quality: ScreenShareQuality,
): ScreenShareFrameRate {
  return SCREEN_SHARE_QUALITY_PROFILES[quality].frameRate;
}

/**
 * How the screen-share encoder SHEDS quality under CPU / bandwidth pressure.
 * `maintain-framerate` is the film choice: under congestion the encoder scales the
 * RESOLUTION down but keeps the FRAME-RATE, so motion stays smooth (a stutter is
 * far more jarring than a briefly softer picture while watching a film together).
 * Applied to every screen-share publish by the engine; pairs with the `motion`
 * content hint below.
 */
export const SCREEN_SHARE_DEGRADATION_PREFERENCE = "maintain-framerate" as const;

/**
 * The MediaStreamTrack content hint for a screen share. `"motion"` tells the encoder
 * + congestion controller that this is full-frame motion video (a film), so it paces
 * a smooth CBR-ish stream and does NOT blow the bitrate on giant keyframes the way
 * the `"detail"`/text default does — the pacing half of the anti-bufferbloat fix.
 * The engine sets it on the screen video track before publishing.
 */
export const SCREEN_SHARE_CONTENT_HINT = "motion" as const;

/** The livekit `screenShareEncoding` publish option for a quality id. */
export function screenShareEncodingForQuality(
  quality: ScreenShareQuality,
): VideoEncodingLike {
  const profile = SCREEN_SHARE_QUALITY_PROFILES[quality];
  return { maxBitrate: profile.maxBitrateBps, maxFramerate: profile.frameRate };
}

/**
 * Mic publish bitrate steps in kbps — mirror livekit-client's `AudioPresets`
 * (telephone 12, speech 24, music 48, musicStereo 64, musicHighQuality 96,
 * musicHighQualityStereo 128). Kept as plain numbers so this module (and the
 * package root) stays livekit-free.
 */
export const MIC_BITRATE_STEPS_KBPS: readonly number[] = [12, 24, 48, 64, 96, 128];

/**
 * Snap a requested mic bitrate (kbps) to the nearest livekit AudioPreset step
 * and return it as a publish `audioPreset`. Ties round UP (prefer quality).
 */
export function micAudioPresetForBitrate(kbps: number): AudioPresetLike {
  let best = 12;
  for (const step of MIC_BITRATE_STEPS_KBPS) {
    const distance = Math.abs(step - kbps);
    const bestDistance = Math.abs(best - kbps);
    if (distance < bestDistance || (distance === bestDistance && step > best)) {
      best = step;
    }
  }
  return { maxBitrate: best * 1000 };
}
