/// <reference types="vite/client" />

/**
 * Build-time env the web client reads. All optional — `platform/env.ts` supplies
 * production defaults so a bare build still points at the live backend.
 */
interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_REALTIME_URL?: string;
  readonly VITE_LIVEKIT_URL?: string;
  readonly VITE_APP_VERSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
