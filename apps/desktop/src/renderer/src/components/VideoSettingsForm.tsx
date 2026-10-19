import { useId } from "react";
import { MonitorPlay } from "lucide-react";
import { RadioCard, RadioGroup, cn } from "@demli/ui";
import {
  CAMERA_FRAME_RATES,
  CAMERA_QUALITIES,
  CAMERA_QUALITY_PROFILES,
  SCREEN_SHARE_FRAME_RATES,
  SCREEN_SHARE_QUALITY_PROFILES,
  SCREEN_SHARE_RESOLUTIONS,
  screenShareFrameRateOf,
  screenShareQualityId,
  screenShareResolutionOf,
  type CameraFrameRate,
  type CameraQuality,
  type ScreenShareFrameRate,
  type ScreenShareResolution,
} from "@demli/media";
import { useAppTranslation } from "../lib/i18n";
import { useMediaSettings } from "../stores/media-settings";
import { SettingsBlock, SettingsGroup, SettingsNote } from "./settings-kit";

const CAMERA_QUALITY_LABEL = {
  auto: "desktop:videoSettings.cameraAuto",
  hd: "720p",
  fhd: "1080p",
} as const satisfies Record<CameraQuality, string>;
const SCREEN_RESOLUTION_LABEL = {
  "480p": "480p",
  "720p": "720p",
  "1080p": "1080p",
  "1440p": "2K",
} as const satisfies Record<ScreenShareResolution, string>;

/** A labelled radio grid of preset cards (label + optional detail line). */
function PresetRow<T extends string | number>({
  label,
  options,
  selected,
  onSelect,
  labelFor,
  detailFor,
  columns,
}: {
  label: string;
  options: readonly T[];
  selected: T;
  onSelect: (value: T) => void;
  labelFor: (value: T) => string;
  detailFor?: (value: T) => string;
  columns: 2 | 3 | 4;
}): JSX.Element {
  const labelId = useId();
  return (
    <SettingsBlock className="space-y-2 p-3">
      <p id={labelId} className="px-1 text-label font-medium text-fg-muted">
        {label}
      </p>
      <RadioGroup
        value={String(selected)}
        onValueChange={(next) => {
          const match = options.find((option) => String(option) === next);
          if (match !== undefined) onSelect(match);
        }}
        aria-labelledby={labelId}
        className={cn(
          "grid gap-1.5",
          columns === 2 ? "grid-cols-2" : columns === 3 ? "grid-cols-3" : "grid-cols-4",
        )}
      >
        {options.map((value) => (
          <RadioCard
            key={String(value)}
            value={String(value)}
            label={labelFor(value)}
            detail={detailFor?.(value)}
          />
        ))}
      </RadioGroup>
    </SettingsBlock>
  );
}

/**
 * "Görüntü" settings (Ayarlar → görüntü): camera capture quality (resolution +
 * FPS) and the screen-share (yayın) quality tier. State lives in the persisted
 * `useMediaSettings` store; the engine consumes the camera options at the next
 * camera publish and the screen-share tier at the next share.
 */
export function VideoSettingsForm(): JSX.Element {
  const { t } = useAppTranslation();
  const video = useMediaSettings((s) => s.video);
  const setCameraQuality = useMediaSettings((s) => s.setCameraQuality);
  const setCameraFrameRate = useMediaSettings((s) => s.setCameraFrameRate);
  const setScreenShareQuality = useMediaSettings((s) => s.setScreenShareQuality);

  const resolution = screenShareResolutionOf(video.screenShareQuality);
  const frameRate = screenShareFrameRateOf(video.screenShareQuality);
  const setScreenResolution = (next: ScreenShareResolution): void =>
    setScreenShareQuality(screenShareQualityId(next, frameRate));
  const setScreenFrameRate = (next: ScreenShareFrameRate): void =>
    setScreenShareQuality(screenShareQualityId(resolution, next));

  const cameraDetail = (quality: CameraQuality): string => {
    const profile = CAMERA_QUALITY_PROFILES[quality];
    return profile ? `${profile.width}×${profile.height}` : "—";
  };
  // Bitrate ceiling for a resolution at the CURRENTLY selected frame-rate.
  const screenResolutionDetail = (res: ScreenShareResolution): string => {
    const p = SCREEN_SHARE_QUALITY_PROFILES[screenShareQualityId(res, frameRate)];
    return `~${p.maxBitrateBps / 1_000_000} Mbps`;
  };

  return (
    <div className="space-y-8">
      <SettingsGroup title={t("desktop:videoSettings.cameraHeading")}>
        <PresetRow<CameraQuality>
          label={t("desktop:videoSettings.cameraQuality")}
          options={CAMERA_QUALITIES}
          selected={video.cameraQuality}
          onSelect={setCameraQuality}
          labelFor={(q) => (q === "auto" ? t(CAMERA_QUALITY_LABEL.auto) : CAMERA_QUALITY_LABEL[q])}
          detailFor={cameraDetail}
          columns={3}
        />
        <PresetRow<CameraFrameRate>
          label={t("desktop:videoSettings.frameRateLabel")}
          options={CAMERA_FRAME_RATES}
          selected={video.cameraFrameRate}
          onSelect={setCameraFrameRate}
          labelFor={(fps) => `${fps} FPS`}
          columns={2}
        />
      </SettingsGroup>

      <SettingsGroup title={t("desktop:videoSettings.screenHeading")}>
        <PresetRow<ScreenShareResolution>
          label={t("desktop:videoSettings.screenResolution")}
          options={SCREEN_SHARE_RESOLUTIONS}
          selected={resolution}
          onSelect={setScreenResolution}
          labelFor={(res) => SCREEN_RESOLUTION_LABEL[res]}
          detailFor={screenResolutionDetail}
          columns={4}
        />
        <PresetRow<ScreenShareFrameRate>
          label={t("desktop:videoSettings.frameRateLabel")}
          options={SCREEN_SHARE_FRAME_RATES}
          selected={frameRate}
          onSelect={setScreenFrameRate}
          labelFor={(fps) => `${fps} FPS`}
          columns={3}
        />
      </SettingsGroup>

      <SettingsNote icon={MonitorPlay}>{t("desktop:videoSettings.note")}</SettingsNote>
    </div>
  );
}
