/**
 * This build's identity mark for the server's client gate — `demli-mobile/<rt>`.
 *
 * The version reported is the native `runtimeVersion`, not `expo.version`,
 * because runtimeVersion is what actually identifies the INSTALLED binary: an
 * OTA update replaces the JS but never the runtime, so two installs running the
 * same JS can be different native builds and only this value tells them apart.
 * `native-update-store.ts` reads the same field for the same reason.
 *
 * Unreadable input degrades to a still-VALID mark (`formatClientSignature`
 * guarantees it) — a client with no mark is a client the gate refuses, and no
 * missing constant is worth locking a live user out over.
 */

import Constants from "expo-constants";
import { formatClientSignature } from "@demli/config";

/** The device's baked native runtime, or null in dev / when unreadable. */
function deviceRuntimeVersion(): string | null {
  const rv = Constants.expoConfig?.runtimeVersion;
  return typeof rv === "string" ? rv : null;
}

/** The mark this app sends on every API request and WS handshake. */
export const CLIENT_SIGNATURE: string = formatClientSignature(
  "mobile",
  deviceRuntimeVersion(),
);
