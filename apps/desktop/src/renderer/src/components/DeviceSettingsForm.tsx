import { Check, Mic, Video, Volume2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@demli/ui";
import { useAppTranslation } from "../lib/i18n";
import { useVoiceStore } from "../stores/voice-store";
import {
  DEFAULT_DEVICE_ID,
  fallbackLabel,
  useMediaDevices,
  type DeviceKind,
  type MediaDevice,
} from "../lib/media-devices";

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
  /** Shown instead of the radio list when no device is enumerated (camera before permission). */
  emptyHint?: string;
}): JSX.Element {
  const { t } = useAppTranslation();
  return (
    <fieldset>
      <legend className="flex items-center gap-1.5 pb-2 text-2xs font-semibold uppercase tracking-wider text-fg-faint">
        <Icon className="size-3.5" />
        {label}
      </legend>
      {devices.length === 0 && emptyHint ? (
        <p className="text-xs leading-relaxed text-fg-faint">{emptyHint}</p>
      ) : (
        <div role="radiogroup" aria-label={label} className="space-y-1">
          {devices.map((device, index) => {
            const selected = device.deviceId === selectedId;
            return (
              <button
                key={device.deviceId}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onSelect(device.deviceId)}
                className={cn(
                  "flex w-full cursor-pointer items-center justify-between gap-2 rounded-md border px-3 py-2",
                  "text-left text-sm transition-colors motion-instant",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                  selected
                    ? "border-accent/60 bg-accent/10 text-fg"
                    : "border-stroke bg-raised text-fg-muted hover:border-stroke-strong hover:text-fg",
                )}
              >
                <span className="min-w-0 truncate">
                  {device.label || fallbackLabel(kind, device.deviceId, index, t)}
                </span>
                {selected && <Check className="size-4 shrink-0 text-accent" />}
              </button>
            );
          })}
        </div>
      )}
    </fieldset>
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
    <div className="space-y-6">
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
      <p className="text-xs leading-relaxed text-fg-faint">{t("desktop:devices.note")}</p>
    </div>
  );
}
