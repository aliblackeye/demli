import { Mic, Video, Volume2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { RadioGroup, RadioItem } from "@demli/ui";
import { useAppTranslation } from "../lib/i18n";
import { useVoiceStore } from "../stores/voice-store";
import {
  DEFAULT_DEVICE_ID,
  fallbackLabel,
  useMediaDevices,
  type DeviceKind,
  type MediaDevice,
} from "../lib/media-devices";

/**
 * One device kind (microphone / output / camera) as the design system's radio
 * rows: one tab stop per group, arrow keys move AND select (WAI-ARIA radio
 * group), the chosen device takes the coral wash. The selection goes straight to
 * the engine, which live-switches the running track when connected.
 */
function DeviceGroup({
  label,
  kind,
  icon: Icon,
  devices,
  selectedId,
  onSelect,
  emptyHint,
}: {
  label: string;
  kind: DeviceKind;
  icon: LucideIcon;
  devices: MediaDevice[];
  selectedId: string;
  onSelect: (deviceId: string) => void;
  /**
   * Shown instead of the radio list when no device is enumerated. Only the
   * camera can be empty: audio lists always carry the system-default entry
   * (lib/media-devices `toDevices`).
   */
  emptyHint?: string;
}): JSX.Element {
  const { t } = useAppTranslation();
  const headingId = `device-group-${kind}`;
  return (
    <section aria-labelledby={headingId} className="rounded-xl bg-surface p-2" data-testid={`device-group-${kind}`}>
      <h3
        id={headingId}
        className="flex items-center gap-1.5 px-2 pb-1.5 pt-1 text-2xs font-semibold uppercase tracking-wider text-fg-faint"
      >
        <Icon aria-hidden className="size-3.5" />
        {label}
      </h3>
      {devices.length === 0 && emptyHint ? (
        // Nothing enumerated (a camera before permission is granted): say so in
        // the group's own space instead of an empty box.
        <p className="px-2 pb-2 text-label leading-relaxed text-fg-faint">{emptyHint}</p>
      ) : (
        <RadioGroup
          aria-labelledby={headingId}
          value={selectedId}
          onValueChange={onSelect}
          className="gap-0.5"
        >
          {devices.map((device, index) => (
            <RadioItem
              key={device.deviceId}
              value={device.deviceId}
              label={
                <span className="block truncate">
                  {device.label || fallbackLabel(kind, device.deviceId, index, t)}
                </span>
              }
              className="[&>span:last-child]:min-w-0 [&>span:last-child]:flex-1"
            />
          ))}
        </RadioGroup>
      )}
    </section>
  );
}

/**
 * Device picker shared by DeviceSettingsDialog and the settings shell. Backed
 * by real enumeration; selections are delegated to the voice engine, which
 * live-switches the active track when connected and stores the preference
 * otherwise (packages/media). Covers microphone, audio output, and camera
 * (task #18).
 */
export function DeviceSettingsForm(): JSX.Element {
  const { t } = useAppTranslation();
  const { inputs, outputs, cameras } = useMediaDevices();
  const selectedInput = useVoiceStore((s) => s.selectedInputDeviceId) ?? DEFAULT_DEVICE_ID;
  const selectedOutput = useVoiceStore((s) => s.selectedOutputDeviceId) ?? DEFAULT_DEVICE_ID;
  // Camera has no "default" sentinel — highlight only an explicit selection.
  const selectedCamera = useVoiceStore((s) => s.selectedVideoDeviceId) ?? "";
  const setInputDevice = useVoiceStore((s) => s.setInputDevice);
  const setOutputDevice = useVoiceStore((s) => s.setOutputDevice);
  const setVideoDevice = useVoiceStore((s) => s.setVideoDevice);

  return (
    <div className="space-y-2.5">
      <DeviceGroup
        label={t("desktop:devices.input")}
        kind="audioinput"
        icon={Mic}
        devices={inputs}
        selectedId={selectedInput}
        onSelect={setInputDevice}
      />
      <DeviceGroup
        label={t("desktop:devices.output")}
        kind="audiooutput"
        icon={Volume2}
        devices={outputs}
        selectedId={selectedOutput}
        onSelect={setOutputDevice}
      />
      <DeviceGroup
        label={t("desktop:devices.camera")}
        kind="videoinput"
        icon={Video}
        devices={cameras}
        selectedId={selectedCamera}
        onSelect={setVideoDevice}
        emptyHint={t("desktop:devices.cameraNote")}
      />
      <p className="px-1 pt-1 text-2xs leading-relaxed text-fg-faint">{t("desktop:devices.note")}</p>
    </div>
  );
}
