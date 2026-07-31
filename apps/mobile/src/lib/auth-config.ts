/**
 * Auth-screen feature flags (M15). Mirrors the desktop renderer's
 * `VITE_GOOGLE_AUTH_ENABLED` gate: the "Continue with Google" button ships now
 * as a visible-but-inactive placeholder ("yakında"), and flipping this env var in
 * a build un-greys it once the OAuth flow is wired. Read at module load from the
 * baked `EXPO_PUBLIC_*` env (the only env visible to the RN bundle), so it is a
 * pure JS toggle — no native module, OTA-deliverable.
 */
export const GOOGLE_AUTH_ENABLED =
  process.env.EXPO_PUBLIC_GOOGLE_AUTH_ENABLED === "true";
