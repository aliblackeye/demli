/**
 * Download links — the SINGLE source of "where do I get Demli for <platform>".
 *
 * Every surface that offers a build (the rail's download dialog, the web-only
 * DownloadPrompt pill) reads this module. Nothing hardcodes a URL at the call
 * site, so redirect changes are one edit / one env var, not a grep-and-pray.
 *
 * ── HONESTY CONTRACT (CLAUDE.md §35: no dead buttons) ───────────────────────
 * A platform is only `"available"` when a REAL, runnable artifact exists behind
 * a link. Everything else is either `"soon"` (a build path exists in the repo
 * but has never produced a published artifact) or `"none"` (no build, no plan —
 * the UI must not render it at all). We never invent a URL to fill a row.
 *
 *   windows  available  NSIS installer, shipping; electron-updater feed.
 *   android  available  EAS APK, shipping; in-app self-updater installs over it.
 *   macos    soon       Packaging target + build pipeline landed (M19) but have
 *                       NEVER been run — there is no artifact to link to. Set
 *                       VITE_DOWNLOAD_URL_MACOS the day one is published and the
 *                       row flips to a live button with no code change.
 *   linux    none       No packaging target, no plan. Not rendered.
 *   ios      none       No App Store build, no plan. Not rendered.
 *
 * ── URL RESOLUTION ──────────────────────────────────────────────────────────
 * `VITE_DOWNLOAD_URL_<PLATFORM>` (build-time, Vite-inlined) wins; otherwise the
 * baked default below. The defaults point at the `getdemli.com/download/*`
 * redirects (founder-owned domain, devops wires the redirect targets) so the
 * link is stable across releases — unlike the version-pinned installer filename
 * on the release feed, which changes every publish.
 *
 * Only `https://` is accepted. A download link that ships an installer over
 * plaintext is not one we will offer, and the check runs here — at resolution —
 * so a bad override degrades to "soon" instead of becoming a dead button.
 */
import { openExternalUrl } from "@demli/app-ui";

/** Platforms the UI knows about (whether or not they have a build today). */
export type DownloadPlatformId = "windows" | "macos" | "linux" | "android" | "ios";

/** Which section of the download dialog a platform belongs to. */
export type DownloadSurface = "desktop" | "mobile";

/**
 * `available` → live link, enabled button.
 * `soon`      → shown with a "soon" badge and a DISABLED button (no URL).
 * `none`      → not rendered at all (no build, no plan).
 */
export type DownloadAvailability = "available" | "soon" | "none";

export interface DownloadTarget {
  id: DownloadPlatformId;
  surface: DownloadSurface;
  availability: DownloadAvailability;
  /** Absolute https URL — non-null if and only if `availability === "available"`. */
  url: string | null;
}

/** Render order within each section. */
const ORDER: readonly DownloadPlatformId[] = ["windows", "macos", "linux", "android", "ios"];

const SURFACE: Record<DownloadPlatformId, DownloadSurface> = {
  windows: "desktop",
  macos: "desktop",
  linux: "desktop",
  android: "mobile",
  ios: "mobile",
};

/** Baked defaults — only platforms with a real, shipping artifact get one. */
const DEFAULT_URL: Partial<Record<DownloadPlatformId, string>> = {
  windows: "https://getdemli.com/download/windows",
  android: "https://getdemli.com/download/android",
};

/**
 * What a platform WITHOUT a resolved URL degrades to. `soon` means "the build
 * path exists, the artifact does not yet"; `none` means "we have not started" —
 * and `none` rows never reach the screen, so an absent platform is never
 * implicitly promised.
 */
const WITHOUT_URL: Record<DownloadPlatformId, Exclude<DownloadAvailability, "available">> = {
  // Both of these ship today and carry a default URL, so they only land here if
  // someone deliberately blanks it — "soon" is then the honest read.
  windows: "soon",
  android: "soon",
  macos: "soon",
  linux: "none",
  ios: "none",
};

/**
 * Build-time overrides. Written as literal `import.meta.env.X` member accesses
 * on purpose — Vite statically replaces exactly this form; a computed lookup
 * would resolve to `undefined` in a production bundle.
 */
const ENV_URL: Record<DownloadPlatformId, unknown> = {
  windows: import.meta.env.VITE_DOWNLOAD_URL_WINDOWS,
  macos: import.meta.env.VITE_DOWNLOAD_URL_MACOS,
  linux: import.meta.env.VITE_DOWNLOAD_URL_LINUX,
  android: import.meta.env.VITE_DOWNLOAD_URL_ANDROID,
  ios: import.meta.env.VITE_DOWNLOAD_URL_IOS,
};

/** An https URL, or null for anything empty/non-string/non-https (see header). */
function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && /^https:\/\//i.test(trimmed) ? trimmed : null;
}

function resolveTarget(id: DownloadPlatformId): DownloadTarget {
  const url = httpsUrl(ENV_URL[id]) ?? DEFAULT_URL[id] ?? null;
  return {
    id,
    surface: SURFACE[id],
    availability: url !== null ? "available" : WITHOUT_URL[id],
    url,
  };
}

/** Every known platform, in render order — including the `none` ones. */
export const DOWNLOAD_TARGETS: readonly DownloadTarget[] = ORDER.map(resolveTarget);

/** Look one platform up (the web pill resolves the visitor's OS this way). */
export function downloadTarget(id: DownloadPlatformId): DownloadTarget {
  // ORDER covers the whole union, so this is always found.
  return DOWNLOAD_TARGETS.find((target) => target.id === id) as DownloadTarget;
}

/**
 * The rows a section should actually render: `none` platforms are dropped
 * entirely so the dialog never shows a platform we have made no promise about.
 */
export function visibleDownloadTargets(surface: DownloadSurface): DownloadTarget[] {
  return DOWNLOAD_TARGETS.filter(
    (target) => target.surface === surface && target.availability !== "none",
  );
}

/**
 * Open an external download in the OS browser.
 *
 * Goes through the shared `openExternalUrl` seam (@demli/app-ui), NOT
 * `window.open`. On desktop the main process' `setWindowOpenHandler` is an
 * unconditional deny — a `window.open` there now does nothing at all — so the
 * seam routes to the validated `externalLinks.open` preload verb; on web it is a
 * plain `noopener` tab. Same user-visible result on both: the OS browser.
 *
 * The https check stays here on top of the seam's http(s) check: a DOWNLOAD link
 * must be https specifically (see the header), which is stricter.
 */
export function openDownloadUrl(url: string): void {
  if (httpsUrl(url) === null) return;
  openExternalUrl(url);
}
