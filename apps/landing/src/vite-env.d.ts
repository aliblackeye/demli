/// <reference types="vite/client" />

/**
 * Build-time configuration. Every entry is optional: src/env.ts supplies a
 * production default for each, so an unconfigured build is still correct.
 * Keep this in sync with .env.example.
 */
interface ImportMetaEnv {
  /** Web client the "Open Demli" buttons point at. */
  readonly VITE_APP_URL?: string;
  /** Stable Windows installer endpoint (devops redirects it to the feed file). */
  readonly VITE_DOWNLOAD_WINDOWS_URL?: string;
  /** Stable Android APK endpoint (devops redirects it to the EAS APK link). */
  readonly VITE_DOWNLOAD_ANDROID_URL?: string;
  /** Public repository URL. Blank/absent hides the open-source row entirely. */
  readonly VITE_GITHUB_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
