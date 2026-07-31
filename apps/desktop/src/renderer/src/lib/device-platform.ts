/**
 * Which OS is this DEVICE running — i.e. which of our builds could it install?
 *
 * ── Why the User-Agent, and not the viewport ────────────────────────────────
 * This module answers a CAPABILITY question ("can this machine run our .exe or
 * our .apk?"), not a LAYOUT question ("is there room for four columns?"). The
 * two must not share a signal:
 *
 *   - Viewport width (`useIsMobileViewport`, MOBILE_MAX_WIDTH) is the right
 *     answer for layout and the WRONG answer here: a desktop browser dragged
 *     narrow, a split-screen window or a zoomed-in page is still a PC, and
 *     handing it an Android APK while hiding the Windows installer would be a
 *     download it cannot run (CLAUDE.md §35).
 *   - Pointer coarseness (`(pointer: coarse)`) is equally wrong in the other
 *     direction: a Windows touch laptop and a Surface both report coarse and
 *     both want the installer.
 *   - `navigator.userAgentData.mobile` would be the modern, honest signal but
 *     does not exist in Safari at all — and apps/web hard-targets iPhone 6 /
 *     Safari 12 (see apps/web vite plugin-legacy). It cannot be the primary.
 *
 * So the OS family comes from the UA string, which is the only signal every
 * target browser has. This is NOT the same as `lib/surface.ts` — that asks
 * "which BUILD am I (Electron vs browser)?" and is answered by the platform
 * bridge, never the UA. Surface first, then device: an Electron app on Windows
 * has a Chrome UA and must never be treated as a web visitor.
 */

/** OS family, collapsed to the granularity our download matrix cares about. */
export type DevicePlatform = "android" | "ios" | "windows" | "other";

/**
 * OS family from the User-Agent, including the iPadOS-reports-as-Mac probe.
 *
 * `other` covers macOS, Linux and anything unrecognised — every case where we
 * have no build to hand the visitor, so callers treat it as "nothing to offer".
 */
export function detectDevicePlatform(): DevicePlatform {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return "android";
  // iPadOS 13+ presents a desktop "Macintosh" UA; the touch-points probe
  // disambiguates it from a real Mac so we don't offer an iPad a Windows .exe.
  const iOSLike =
    /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  if (iOSLike) return "ios";
  if (/windows/i.test(ua)) return "windows";
  return "other";
}

/**
 * True on a phone/tablet OS. Used to decide WHICH artifacts are worth offering,
 * never to decide how wide a layout should be — see the header.
 */
export function isMobileDevice(): boolean {
  const platform = detectDevicePlatform();
  return platform === "android" || platform === "ios";
}
