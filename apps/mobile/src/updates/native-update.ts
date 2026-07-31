/**
 * Native-update DECISION logic (pure — no React, no expo-native imports).
 *
 * This is the NATIVE counterpart to the OTA flow in `updates.ts`/`updates-store`
 * and runs in PARALLEL to it: OTA ships JS bundles for the installed native
 * runtime, whereas this decides whether the installed APK's native runtime has
 * itself fallen behind and needs a manual reinstall (the sideloaded APK cannot
 * receive a new native runtime over OTA).
 *
 * Kept import-clean (only semver) so it unit-tests in the node vitest env without
 * mocking `expo-constants` / react-native. The store (`native-update-store.ts`)
 * owns the native reads (device runtime, Linking) and calls this.
 */
import { isOlder, isValidVersion } from "./semver";

/**
 * What the app should do about the installed native runtime:
 *   none     — up to date (or undecidable); show nothing.
 *   optional — a newer runtime exists; show a dismissible banner.
 *   forced   — below the supported floor; show a blocking screen.
 */
export type NativeUpdateLevel = "none" | "optional" | "forced";

export interface NativeUpdateInput {
  /** The device's own `runtimeVersion` (from expo-constants); null when unknown. */
  currentRuntime: string | null | undefined;
  /** Newest shipped runtime advertised by GET /mobile/version. */
  latestRuntimeVersion: string;
  /** Optional forced-update floor; absent ⇒ never forced. */
  minSupportedRuntimeVersion?: string | null;
}

/**
 * Decide the update level from the device runtime and the server-advertised
 * versions. Fail-safe by construction — anything undecidable resolves to `none`
 * so a missing/garbage runtime or a misconfigured server NEVER blocks the user:
 *
 *  - unknown or non-numeric device runtime            → none
 *  - non-numeric `latestRuntimeVersion`               → none
 *  - device < min (when min is a valid version)       → forced
 *  - device < latest                                  → optional
 *  - otherwise                                        → none
 */
export function decideNativeUpdate(input: NativeUpdateInput): NativeUpdateLevel {
  const { currentRuntime, latestRuntimeVersion, minSupportedRuntimeVersion } = input;

  // Can't trust an unknown/garbage device runtime → never nag or block.
  if (!currentRuntime || !isValidVersion(currentRuntime)) return "none";
  // A misconfigured server value must not drive UI either.
  if (!isValidVersion(latestRuntimeVersion)) return "none";

  if (
    minSupportedRuntimeVersion &&
    isValidVersion(minSupportedRuntimeVersion) &&
    isOlder(currentRuntime, minSupportedRuntimeVersion)
  ) {
    return "forced";
  }

  if (isOlder(currentRuntime, latestRuntimeVersion)) return "optional";

  return "none";
}

/**
 * Deterministic on-disk filename for a given runtime version's downloaded APK.
 *
 * Pure (no FS, no native imports) so it unit-tests in the node env and so BOTH
 * the download path and the "already-downloaded?" lookup derive the same name —
 * that shared, version-keyed name is what lets a cancelled OS install re-launch
 * on next launch WITHOUT re-downloading (the file's presence is the pending-install
 * marker). Any character that isn't a safe filename char is collapsed to `_` so a
 * hostile/garbage server version can never escape the updates directory.
 */
export function apkFileName(version: string): string {
  const safe = version.replace(/[^0-9A-Za-z._-]/g, "_");
  return `demli-${safe}.apk`;
}
