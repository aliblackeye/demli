/**
 * What should the rail's bottom "download" button DO on this device?
 *
 * One decision, three outcomes, resolved once so the button, its label and its
 * click handler can never disagree:
 *
 *   hidden  — not the web build at all (the installed app offering itself), or a
 *             device we have no runnable artifact for. A button that opens a list
 *             of things you cannot install is a dead control (CLAUDE.md §35).
 *   direct  — exactly ONE artifact can run here (a phone). Downloading it is the
 *             whole interaction, so the button starts the download; opening a
 *             one-row dialog first would be a step that decides nothing.
 *   dialog  — a desktop browser, where the visitor genuinely chooses between
 *             Windows / macOS / Android. Unchanged from before.
 *
 * ── Why a phone never sees the Windows row (founder, 2026-07-29) ────────────
 * The download dialog lists every platform because on a PC that is a real menu:
 * "install it here, or grab it for your phone too". On a phone the desktop half
 * of that menu is noise — the visitor cannot run an NSIS installer — and the
 * dialog itself was the surface that rendered badly on a small screen. So on a
 * mobile OS we collapse to the single artifact that device can actually install.
 *
 * The OS test is the User-Agent, deliberately NOT the viewport width — see
 * lib/device-platform.ts for why a narrow desktop window is not a phone.
 */
import { detectDevicePlatform } from "./device-platform";
import { downloadTarget, type DownloadPlatformId } from "./download-links";
import { isWebSurface } from "./surface";

export type RailDownloadAction =
  /** Render no button at all. */
  | { kind: "hidden" }
  /** Start this download immediately; no intermediate dialog. */
  | { kind: "direct"; platform: DownloadPlatformId; url: string }
  /** Open the full platform picker (desktop browser). */
  | { kind: "dialog" };

const HIDDEN: RailDownloadAction = { kind: "hidden" };

/**
 * Resolve the rail download affordance for the current surface + device.
 *
 * Pure and cheap (a UA regex plus a lookup in the static availability matrix),
 * so callers may call it during render without memoising.
 */
export function railDownloadAction(): RailDownloadAction {
  // Surface gate first: inside the installed desktop app there is nothing to
  // download — updates are surfaced by the UpdateBadge instead.
  if (!isWebSurface()) return HIDDEN;

  const platform = detectDevicePlatform();
  if (platform !== "android" && platform !== "ios") return { kind: "dialog" };

  // A phone: at most one artifact is relevant. Today android → APK and
  // ios → nothing (no App Store build, `availability: "none"`), but the answer
  // is read from the shared matrix so publishing an iOS build lights this up
  // with no change here.
  const target = downloadTarget(platform);
  if (target.availability !== "available" || target.url === null) return HIDDEN;
  return { kind: "direct", platform, url: target.url };
}
