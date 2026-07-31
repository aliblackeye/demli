/**
 * Device metadata (M15) attached to every mobile login/register so the issued
 * session is labelled in the "active sessions" list. Built ONLY from react-native
 * `Platform` (no `expo-device` / new native module) so it stays OTA-safe. On
 * Android `Platform.constants` exposes the manufacturer + model; iOS has no model
 * name via `Platform`, so we use a generic idiom-based label.
 */
import { Platform } from "react-native";
import type { SessionDeviceMetadata } from "@demli/client-core";

function trimTitle(value: string): string {
  const t = value.trim();
  return t.length > 0 ? t : "";
}

function androidName(): string {
  // `Platform.constants` on Android carries Manufacturer/Model (typed via the
  // Android platform narrowing). Fall back to a generic label if either is blank.
  const c = Platform.constants as { Manufacturer?: string; Model?: string };
  const parts = [trimTitle(c.Manufacturer ?? ""), trimTitle(c.Model ?? "")].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "Android";
}

function iosName(): string {
  const c = Platform.constants as { interfaceIdiom?: string };
  return c.interfaceIdiom === "pad" ? "iPad" : "iPhone";
}

/** `{ deviceName: "<device> · Demli", platform: "mobile" }`. */
export function mobileSessionMetadata(): SessionDeviceMetadata {
  const device = Platform.OS === "android" ? androidName() : Platform.OS === "ios" ? iosName() : "Mobile";
  return { deviceName: `${device} · Demli`, platform: "mobile" };
}
