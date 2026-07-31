/**
 * Device metadata (M15) attached to every desktop login/register so the issued
 * session is labelled in the "active sessions" list. Derived from the preload
 * `appInfo.platform` (Node `process.platform`) — no new capability, no PII beyond
 * the OS family. `platform: "desktop"` is the client surface the server records.
 */

import type { SessionDeviceMetadata } from "@demli/client-core";

function osLabel(): string {
  switch (window.demli.appInfo.platform) {
    case "win32":
      return "Windows";
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    default:
      return "Desktop";
  }
}

/** `{ deviceName: "Windows · Demli", platform: "desktop" }` (OS-aware label). */
export function desktopSessionMetadata(): SessionDeviceMetadata {
  return { deviceName: `${osLabel()} · Demli`, platform: "desktop" };
}
