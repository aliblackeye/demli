/**
 * Pure render policy for the Android Picture-in-Picture overlay (PipController).
 *
 * The overlay is a full-bleed black View that covers the whole app so the tiny
 * PiP window shows ONLY the active speaker's camera (§7 "minimal view"). Because
 * it covers everything, it must appear ONLY while the OS actually has us shrunk
 * into a PiP window — and it must disappear the instant we are back in the
 * foreground. Getting that wrong turns the overlay into a black screen over the
 * live app.
 *
 * The bug this guards against: `expo-pip`'s `useIsInPip()` can leave
 * `isInPipMode` stale-true after the user expands the PiP window back to full
 * screen (a missed `onPictureInPictureModeChanged(false)` — a known flakiness).
 * On the old code the overlay was gated on `isInPipMode` alone, so a stale-true
 * left the black cover stuck → "join voice, background, reopen → black screen".
 *
 * The fix, encoded here as a dependency-free (unit-testable) decision:
 *  - `appActive` (RN AppState === "active") is the resume-safety guard. A
 *    foregrounded app is NEVER in a PiP window, so we never show the black cover
 *    while foregrounded — even if `isInPipMode` is stale-true. On Android,
 *    entering PiP pauses the activity (AppState → "background") and expanding it
 *    resumes the activity (AppState → "active"), so this tracks the real window
 *    state independently of the flaky PiP callback.
 *  - `hasCameraTrack` keeps the black cover from ever appearing with nothing to
 *    show (pure-audio session, or the watched camera turned off mid-PiP). Without
 *    a camera the overlay would be a pointless black box; hiding it lets the PiP
 *    window fall back to the real (shrunk) app UI instead.
 */
export function isInPipWindow(input: {
  /** OS PiP state per expo-pip's `useIsInPip()` — may be stale-true on resume. */
  isInPipMode: boolean;
  /** RN AppState === "active": the app is in the foreground (full screen). */
  appActive: boolean;
}): boolean {
  // A FOREGROUNDED app is never in a PiP window, so `!appActive` overrules a
  // stale-true `isInPipMode` — that is the resume safety.
  return input.isInPipMode && !input.appActive;
}

export function shouldShowPipOverlay(input: {
  /** OS PiP state per expo-pip's `useIsInPip()` — may be stale-true on resume. */
  isInPipMode: boolean;
  /** RN AppState === "active": the app is in the foreground (full screen). */
  appActive: boolean;
  /** There is an active-speaker camera track to render in the PiP window. */
  hasCameraTrack: boolean;
}): boolean {
  // Show ONLY while: the OS says we're in PiP, we are NOT in the foreground, and
  // we actually have a camera to fill the window.
  return isInPipWindow(input) && input.hasCameraTrack;
}

/**
 * What kind of video the PiP window is showing. The two behave differently
 * enough that the window's shape depends on it (see {@link resolvePipAspect}).
 */
export type PipSubjectKind = "screen" | "camera";

/** An integer width:height pair for Android's `PictureInPictureParams`. */
export interface PipAspect {
  width: number;
  height: number;
}

/**
 * Android's hard limits on `PictureInPictureParams.Builder#setAspectRatio`: the
 * ratio must be within [1/2.39, 2.39] inclusive, or the OS throws
 * IllegalArgumentException and the window keeps its PREVIOUS params (so an
 * out-of-range guess silently leaves the old, wrong shape in place). Every
 * candidate goes through {@link clampPipAspect} for that reason.
 */
export const PIP_MIN_ASPECT = 1 / 2.39;
export const PIP_MAX_ASPECT = 2.39;

/** The tallest ratio Android accepts, as the integer pair `Rational` needs. */
export const PIP_TALLEST_ASPECT: PipAspect = { width: 100, height: 239 };
/** The widest ratio Android accepts. */
export const PIP_WIDEST_ASPECT: PipAspect = { width: 239, height: 100 };

/** Phone-camera default: a portrait window for a portrait camera. */
export const PIP_PORTRAIT_ASPECT: PipAspect = { width: 9, height: 16 };
/** Screen-share default: shared screens and windows are landscape in practice. */
export const PIP_LANDSCAPE_ASPECT: PipAspect = { width: 16, height: 9 };

/**
 * Snap an aspect into the range Android accepts, as integers (`Rational` takes
 * ints). Garbage in (non-finite, zero, negative) falls back to the portrait
 * default rather than throwing — a PiP shape is never worth a crash.
 */
export function clampPipAspect(aspect: PipAspect): PipAspect {
  const width = Math.round(aspect.width);
  const height = Math.round(aspect.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return PIP_PORTRAIT_ASPECT;
  }
  const ratio = width / height;
  if (ratio < PIP_MIN_ASPECT) return PIP_TALLEST_ASPECT;
  if (ratio > PIP_MAX_ASPECT) return PIP_WIDEST_ASPECT;
  return { width, height };
}

/**
 * The PiP window shape for what we are about to show (call-ux-plan K5: "sabit
 * 16:9 yerine içeriğin oranı; boyut bilinmiyorsa 9:16").
 *
 * WHY THERE IS NO MEASURED CAMERA ORIENTATION. A portrait phone camera does NOT
 * travel as a portrait video: Android captures on a landscape sensor and sends
 * the rotation as frame METADATA (CVO). The renderer applies it natively — which
 * is why in-app tiles look right — but every JS-reachable dimension source
 * reports the UNROTATED buffer:
 *   - `RTCView`'s `onDimensionsChange` gets `frame.getBuffer().getWidth/Height()`
 *     from `SurfaceEglRenderer.onFrameResolutionChanged` and DROPS the rotation
 *     argument (see WebRTCView.java: the native layout swaps on
 *     `frameRotation % 180 != 0`, the JS event does not carry it);
 *   - remote tracks have no `getSettings()` width/height at all on RN (only
 *     `getUserMedia` tracks do);
 *   - the publisher's `TrackInfo` dimensions come from the capture format, which
 *     is landscape for both platforms (we request 1280x720).
 * So a portrait phone camera and a landscape webcam are INDISTINGUISHABLE from
 * the receiving JS. Given that, a camera gets the portrait default: phones are
 * what our cameras overwhelmingly are, and a landscape webcam rendered `contain`
 * inside a portrait window is merely small — never a cropped half-face, which is
 * the defect we are fixing. Screen shares carry rotation 0 from both platforms,
 * so their landscape default is simply true.
 *
 * `measured` is the seam for a future rotation-AWARE source (e.g. the publisher
 * broadcasting its real aspect as a participant attribute); when it is present it
 * wins, because then we actually know.
 */
export function resolvePipAspect(input: {
  kind: PipSubjectKind | null;
  measured?: PipAspect | null;
}): PipAspect {
  if (input.measured) return clampPipAspect(input.measured);
  return input.kind === "screen" ? PIP_LANDSCAPE_ASPECT : PIP_PORTRAIT_ASPECT;
}

/**
 * How the PiP video fills its window — always `contain`, never `cover`.
 *
 * `cover` was the bug the founder hit: a portrait camera forced into a 16:9
 * window got its sides kept and its top/bottom thrown away, i.e. "yarım bi şey"
 * — half a face. Showing a person small is strictly better than showing half of
 * them. And `contain` costs nothing when the window shape is right: with a
 * matching aspect the two are mathematically identical (no letterbox, no crop),
 * so we do not need to know the content aspect to make this call. The empty
 * space is filled by the brand backdrop the overlay paints behind the video.
 */
export const PIP_OBJECT_FIT = "contain" as const;
