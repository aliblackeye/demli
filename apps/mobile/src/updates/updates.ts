/**
 * Thin, typed wrapper around `expo-updates` (EAS Update / OTA).
 *
 * This is the ONLY file that talks to the `expo-updates` native API. Everything
 * above it (the store, the gate, the banner, Settings) works with plain values,
 * which keeps the OTA logic testable and the native surface in one place.
 *
 * Key rule: OTA is only active in a real release/preview build. In Expo Go and
 * in a dev client `Updates.isEnabled` is `false`, so every entry point here is
 * guarded and local development is never affected.
 */
import * as Updates from "expo-updates";

/**
 * `expo-updates` is only active in a release/preview build produced by EAS.
 * Returns false in Expo Go and in a dev client — callers must no-op then.
 */
export function updatesEnabled(): boolean {
  return Updates.isEnabled;
}

/**
 * Read the "critical" flag an incoming update declares about itself.
 *
 * `eas update` bakes the resolved Expo config into the published update
 * manifest, so the app config's `expo.extra` (set in `app.config.js`) surfaces
 * on the client as `manifest.extra.expoClient.extra`. A forced release is
 * published with `extra.critical === true` (see `app.config.js` for the exact
 * publish command). We read it defensively — a malformed manifest is treated as
 * non-critical rather than throwing.
 */
export function readCriticalFlag(manifest: unknown): boolean {
  if (!manifest || typeof manifest !== "object") return false;
  const extra = (manifest as { extra?: unknown }).extra;
  if (!extra || typeof extra !== "object") return false;

  const isTruthy = (v: unknown): boolean => v === true || v === "true" || v === 1;

  // New manifest format: the Expo config lands under extra.expoClient.
  const expoClient = (extra as { expoClient?: { extra?: Record<string, unknown> } }).expoClient;
  if (expoClient?.extra && isTruthy(expoClient.extra.critical)) return true;

  // Fallback: a flag set directly on manifest.extra.
  return isTruthy((extra as { critical?: unknown }).critical);
}

export type CheckOutcome =
  | { available: false; rollback: false }
  | { available: true; critical: boolean; rollback: boolean };

/**
 * Ask the update server whether a newer update exists for this runtime version.
 * The returned manifest is the *incoming* update's manifest, so the critical
 * flag we read reflects the update the user is about to receive.
 */
export async function checkForUpdate(): Promise<CheckOutcome> {
  const result = await Updates.checkForUpdateAsync();

  // A rollback-to-embedded directive has no manifest and cannot self-declare
  // critical, so we surface it as an available (optional) update the user
  // applies via reload.
  if (result.isRollBackToEmbedded) {
    return { available: true, critical: false, rollback: true };
  }
  if (!result.isAvailable) return { available: false, rollback: false };

  return { available: true, critical: readCriticalFlag(result.manifest), rollback: false };
}

/**
 * Download the pending update into the local cache. Returns whether a genuinely
 * new update was fetched. Once fetched, the update is applied automatically on
 * the next cold launch even if the user never taps "restart".
 */
export async function fetchUpdate(): Promise<boolean> {
  const result = await Updates.fetchUpdateAsync();
  return result.isNew === true;
}

/** Restart the app into the newest downloaded update. Does not return on success. */
export async function reloadWithUpdate(): Promise<void> {
  await Updates.reloadAsync();
}

/** Snapshot of the currently-running update, for diagnostics in Settings. */
export interface CurrentUpdateInfo {
  enabled: boolean;
  updateId: string | null;
  channel: string | null;
  runtimeVersion: string | null;
}

export function currentUpdateInfo(): CurrentUpdateInfo {
  return {
    enabled: Updates.isEnabled,
    updateId: Updates.updateId ?? null,
    channel: Updates.channel ?? null,
    runtimeVersion: Updates.runtimeVersion ?? null,
  };
}
