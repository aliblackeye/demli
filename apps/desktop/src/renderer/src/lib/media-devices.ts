/**
 * Shared media-device enumeration for the renderer — the ONE place that lists
 * mics / outputs / cameras via `navigator.mediaDevices`, so the device settings
 * picker (DeviceSettingsForm) and the camera PREVIEW dialog (CameraPreviewDialog)
 * agree on labels, the empty-until-permission behavior, and hot-plug refresh
 * (CLAUDE.md §23 — no duplicated enumeration logic).
 *
 * This is renderer UI plumbing only: the ENGINE (`@demli/media`) remains the
 * single source of truth for what is actually published (§11). Enumeration here
 * just drives which device the user can pick; the selection is handed to the
 * engine via the voice store's device setters.
 */

import { useEffect, useState } from "react";
import type { AppTFunction } from "./i18n";

export interface MediaDevice {
  deviceId: string;
  /** Raw OS label; empty until permission is granted — localized fallback at render. */
  label: string;
}

export type DeviceKind = "audioinput" | "audiooutput" | "videoinput";

/** The system-default pseudo-device Chromium/Electron always exposes (audio only). */
export const DEFAULT_DEVICE_ID = "default";

/**
 * Localized fallback so a picker is never empty or blank (CLAUDE.md §26).
 * Resolved at render time (not stored in state) so it follows live locale switches.
 */
export function fallbackLabel(
  kind: DeviceKind,
  deviceId: string,
  index: number,
  t: AppTFunction,
): string {
  if (deviceId === DEFAULT_DEVICE_ID) return t("desktop:devices.systemDefault");
  if (deviceId === "communications") return t("desktop:devices.communications");
  if (kind === "audioinput") return t("desktop:devices.microphoneN", { number: index + 1 });
  if (kind === "videoinput") return t("desktop:devices.cameraN", { number: index + 1 });
  return t("desktop:devices.speakerN", { number: index + 1 });
}

/**
 * Map enumerated devices of one kind. Audio kinds guarantee a system-default
 * entry so selection always works even before permission is granted; video has
 * no "default" pseudo-device (Chromium exposes one only for audio), so the
 * camera list is real cameras only — empty until camera access is granted.
 */
export function toDevices(infos: MediaDeviceInfo[], kind: DeviceKind): MediaDevice[] {
  const list = infos
    .filter((d) => d.kind === kind && d.deviceId)
    .map((d) => ({ deviceId: d.deviceId, label: d.label }));
  if (kind !== "videoinput" && !list.some((d) => d.deviceId === DEFAULT_DEVICE_ID)) {
    list.unshift({ deviceId: DEFAULT_DEVICE_ID, label: "" });
  }
  return list;
}

/**
 * Enumerate real audio input/output + camera devices via navigator.mediaDevices
 * and refresh on hot-plug (devicechange). Cheap and permission-tolerant: labels
 * populate once access is granted; before that audio shows fallbacks and the
 * camera list may be empty.
 */
export function useMediaDevices(): {
  inputs: MediaDevice[];
  outputs: MediaDevice[];
  cameras: MediaDevice[];
} {
  const [inputs, setInputs] = useState<MediaDevice[]>([
    { deviceId: DEFAULT_DEVICE_ID, label: "" },
  ]);
  const [outputs, setOutputs] = useState<MediaDevice[]>([
    { deviceId: DEFAULT_DEVICE_ID, label: "" },
  ]);
  const [cameras, setCameras] = useState<MediaDevice[]>([]);

  useEffect(() => {
    const media = navigator.mediaDevices;
    if (!media?.enumerateDevices) return;

    let cancelled = false;
    const refresh = (): void => {
      media
        .enumerateDevices()
        .then((infos) => {
          if (cancelled) return;
          setInputs(toDevices(infos, "audioinput"));
          setOutputs(toDevices(infos, "audiooutput"));
          setCameras(toDevices(infos, "videoinput"));
        })
        .catch(() => {
          // Enumeration unavailable — keep the system-default fallbacks.
        });
    };

    refresh();
    media.addEventListener?.("devicechange", refresh);
    return () => {
      cancelled = true;
      media.removeEventListener?.("devicechange", refresh);
    };
  }, []);

  return { inputs, outputs, cameras };
}
