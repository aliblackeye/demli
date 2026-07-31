import type { FastifyInstance } from "fastify";

/**
 * Native-version advertisement (task "native-update-prompt").
 *
 * The Android app is SIDELOADED (a fixed public APK, not on the Play Store), so
 * it cannot self-update its NATIVE runtime. OTA (expo-updates, `src/updates/`)
 * only ships JS bundles compatible with the installed native runtime; a new
 * native `runtimeVersion` can never reach an old APK over OTA — the user must
 * reinstall the APK by hand.
 *
 * This PUBLIC, unauthenticated endpoint lets the app discover that on launch: it
 * returns the newest shipped runtime, the stable APK link, and an optional
 * forced-update floor. The client reads its OWN runtimeVersion, does the semver
 * comparison locally (the server intentionally does NOT — it only serves the
 * facts), and shows an advisory banner or a blocking screen accordingly.
 *
 * No auth (it runs before sign-in, on every cold launch) and no DB. Lightly
 * rate-limited per IP so a public route cannot be used to hammer the server (§28).
 *
 * It stays OUTSIDE the client gate (`plugins/client-gate.ts`): an install that
 * cannot ask what to update to has no way out of being old.
 */

/** Response DTO — mirrored in @demli/client-core `MobileVersionInfo`. */
interface MobileVersionResponse {
  /** Newest shipped native `runtimeVersion` (e.g. "2.0.0"). */
  latestRuntimeVersion: string;
  /** Stable public APK download link (opened via Linking on the device). */
  apkUrl: string;
  /** Optional forced-update floor; omitted when unset (advisory-only). */
  minSupportedRuntimeVersion?: string;
}

/** Per-IP budget for this public, pre-auth, every-cold-launch route. */
const PUBLIC_ROUTE_RATE_LIMIT = {
  rateLimit: { max: 120, timeWindow: "1 minute" },
} as const;

export async function registerMobileVersionModule(server: FastifyInstance): Promise<void> {
  server.get(
    "/mobile/version",
    { config: PUBLIC_ROUTE_RATE_LIMIT },
    async (): Promise<MobileVersionResponse> => {
      const { mobileLatestRuntime, mobileApkUrl, mobileMinRuntime } = server.apiEnv;
      const body: MobileVersionResponse = {
        latestRuntimeVersion: mobileLatestRuntime,
        apkUrl: mobileApkUrl,
      };
      // Only advertise the floor when configured — its absence means "advisory
      // only" on the client (never a hard block).
      if (mobileMinRuntime) body.minSupportedRuntimeVersion = mobileMinRuntime;
      return body;
    },
  );
}
