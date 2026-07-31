/**
 * Every deployment-specific URL on the landing page, resolved once.
 *
 * Each value comes from a build-time `VITE_*` var with a production default, so
 * relocating the app or the download endpoints is a `.env` change rather than a
 * code edit. Blank/whitespace-only values fall back to the default — an empty
 * string in a CI environment must not produce `href=""`.
 */

function fromEnv(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : fallback;
}

/** The web client ("Open Demli"). */
export const APP_URL = fromEnv(import.meta.env.VITE_APP_URL, "https://app.getdemli.com");

/** Windows installer — redirected by devops to the current file in the desktop feed. */
export const DOWNLOAD_WINDOWS_URL = fromEnv(
  import.meta.env.VITE_DOWNLOAD_WINDOWS_URL,
  "https://getdemli.com/download/windows",
);

/** Android APK — redirected by devops to the fixed EAS build link. */
export const DOWNLOAD_ANDROID_URL = fromEnv(
  import.meta.env.VITE_DOWNLOAD_ANDROID_URL,
  "https://getdemli.com/download/android",
);

/**
 * Public repository. NO default on purpose: the repo is private today, and
 * CLAUDE.md §35 forbids shipping a button that goes nowhere. Blank hides the
 * open-source row completely.
 */
export const GITHUB_URL = import.meta.env.VITE_GITHUB_URL?.trim() ?? "";
