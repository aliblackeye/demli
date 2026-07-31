import { MonitorPlay, Video } from "lucide-react";
import { cn } from "@demli/ui";
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

function Section({ children }: { children: React.ReactNode }): JSX.Element {
  return <section className="rounded-xl border border-stroke bg-surface p-1.5">{children}</section>;
}
function SectionHeading({ children }: { children: string }): JSX.Element {
  return <h2 className="px-3.5 pb-1 pt-2.5 text-sm font-semibold text-fg">{children}</h2>;
}

/** A labelled radio row of preset cards (label + optional detail line). */
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
  columns: number;
}): JSX.Element {
  return (
    <div className="p-1.5">
      <p className="px-2 pb-1.5 text-2xs font-semibold uppercase tracking-wider text-fg-faint">
        {label}
      </p>
      <div
        role="radiogroup"
        aria-label={label}
        className="grid gap-1"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {options.map((value) => {
          const isSelected = value === selected;
          return (
            <button
              key={String(value)}
              type="button"
              role="radio"
              aria-checked={isSelected}
              onClick={() => onSelect(value)}
              className={cn(
                "cursor-pointer rounded-md border px-2 py-2 text-center transition-colors motion-instant",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                isSelected
                  ? "border-accent/60 bg-accent/10"
                  : "border-stroke bg-raised hover:border-stroke-strong",
              )}
            >
              <span
                className={cn(
                  "block text-sm font-medium",
                  isSelected ? "text-fg" : "text-fg-muted",
                )}
              >
                {labelFor(value)}
              </span>
              {detailFor && (
                <span className="mt-0.5 block truncate text-2xs text-fg-faint">
                  {detailFor(value)}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
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
    <div className="space-y-6">
      <Section>
        <SectionHeading>{t("desktop:videoSettings.cameraHeading")}</SectionHeading>
        <PresetRow<CameraQuality>
          label={t("desktop:videoSettings.cameraQuality")}
          options={CAMERA_QUALITIES}
          selected={video.cameraQuality}
          onSelect={setCameraQuality}
          labelFor={(q) => (q === "auto" ? t(CAMERA_QUALITY_LABEL.auto) : CAMERA_QUALITY_LABEL[q])}
          detailFor={cameraDetail}
          columns={3}
        />
        <div className="border-t border-stroke/60">
          <PresetRow<CameraFrameRate>
            label={t("desktop:videoSettings.frameRateLabel")}
            options={CAMERA_FRAME_RATES}
            selected={video.cameraFrameRate}
            onSelect={setCameraFrameRate}
            labelFor={(fps) => `${fps} FPS`}
            columns={2}
          />
        </div>
      </Section>

      <Section>
        <SectionHeading>{t("desktop:videoSettings.screenHeading")}</SectionHeading>
        <PresetRow<ScreenShareResolution>
          label={t("desktop:videoSettings.screenResolution")}
          options={SCREEN_SHARE_RESOLUTIONS}
          selected={resolution}
          onSelect={setScreenResolution}
          labelFor={(res) => SCREEN_RESOLUTION_LABEL[res]}
          detailFor={screenResolutionDetail}
          columns={4}
        />
        <div className="border-t border-stroke/60">
          <PresetRow<ScreenShareFrameRate>
            label={t("desktop:videoSettings.frameRateLabel")}
            options={SCREEN_SHARE_FRAME_RATES}
            selected={frameRate}
            onSelect={setScreenFrameRate}
            labelFor={(fps) => `${fps} FPS`}
            columns={3}
          />
        </div>
      </Section>

      <div className="flex items-center gap-2">
        <Video className="size-3.5 text-fg-faint" />
        <MonitorPlay className="size-3.5 text-fg-faint" />
        <p className="text-xs leading-relaxed text-fg-faint">{t("desktop:videoSettings.note")}</p>
      </div>
    </div>
  );
}
