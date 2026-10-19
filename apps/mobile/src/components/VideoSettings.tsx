import { useAppTranslation } from "@/lib/i18n";
import { ChipSelect } from "@/components/ChipSelect";
import { SettingsBlock, SettingsSection } from "@/components/settings/SettingsSection";
import { useMediaSettings } from "@/stores/media-settings";
import {
  ANDROID_SCREEN_CAPTURE_MAX_FPS,
  screenShareFrameRatesUpTo,
  SCREEN_SHARE_RESOLUTIONS,
  screenShareFrameRateOf,
  screenShareQualityId,
  screenShareResolutionOf,
  type CameraFrameRate,
  type CameraQuality,
  type ScreenShareResolution,
} from "@demli/media";

/** Resolution tier → chip label (1440p is marketed as 2K). */
const SCREEN_RESOLUTION_LABEL: Record<ScreenShareResolution, string> = {
  "480p": "480p",
  "720p": "720p",
  "1080p": "1080p",
  "1440p": "2K",
};

/**
 * "Görüntü" settings — the mobile counterpart of the desktop VideoSettingsForm.
 * Camera capture quality (resolution + FPS) and the screen-share (yayın) quality
 * matrix (resolution × frame-rate), over the persisted `useMediaSettings` store.
 * Camera quality is consumed by the engine at the next camera publish; the
 * screen-share resolution/FPS is the persisted default the share-start quality sheet
 * (ScreenShareQualitySheet) opens with and the engine publishes at.
 */

export function VideoSettings() {
  const { t } = useAppTranslation();
  const video = useMediaSettings((s) => s.video);
  const setCameraQuality = useMediaSettings((s) => s.setCameraQuality);
  const setCameraFrameRate = useMediaSettings((s) => s.setCameraFrameRate);
  const setScreenShareQuality = useMediaSettings((s) => s.setScreenShareQuality);

  // Screen-share (yayın) quality decomposed onto its two axes (resolution + fps).
  const screenResolution = screenShareResolutionOf(video.screenShareQuality);
  const screenFrameRate = screenShareFrameRateOf(video.screenShareQuality);

  return (
    <SettingsSection title={t("mobile:video.section")} footer={t("mobile:video.note")}>
      <SettingsBlock label={t("mobile:video.cameraQuality")}>
        <ChipSelect
          accessibilityLabel={t("mobile:video.cameraQuality")}
          options={[
            { key: "auto", label: t("mobile:video.cameraAuto") },
            { key: "hd", label: "720p" },
            { key: "fhd", label: "1080p" },
          ]}
          selectedKey={video.cameraQuality}
          onSelect={(key) => setCameraQuality(key as CameraQuality)}
        />
      </SettingsBlock>

      <SettingsBlock label={t("mobile:video.frameRate")}>
        <ChipSelect
          accessibilityLabel={t("mobile:video.frameRate")}
          options={[
            { key: "30", label: "30 FPS" },
            { key: "60", label: "60 FPS" },
          ]}
          selectedKey={String(video.cameraFrameRate)}
          onSelect={(key) => setCameraFrameRate(Number(key) as CameraFrameRate)}
        />
      </SettingsBlock>

      <SettingsBlock label={t("mobile:video.screenResolution")}>
        <ChipSelect
          accessibilityLabel={t("mobile:video.screenResolution")}
          options={SCREEN_SHARE_RESOLUTIONS.map((res) => ({
            key: res,
            label: SCREEN_RESOLUTION_LABEL[res],
          }))}
          selectedKey={screenResolution}
          onSelect={(key) =>
            setScreenShareQuality(
              screenShareQualityId(key as ScreenShareResolution, screenFrameRate),
            )
          }
        />
      </SettingsBlock>

      <SettingsBlock label={t("mobile:video.screenFrameRate")}>
        <ChipSelect
          accessibilityLabel={t("mobile:video.screenFrameRate")}
          // 30 is Android's real capture ceiling — see ANDROID_SCREEN_CAPTURE_MAX_FPS.
          options={screenShareFrameRatesUpTo(ANDROID_SCREEN_CAPTURE_MAX_FPS).map((fps) => ({
            key: String(fps),
            label: `${fps} FPS`,
          }))}
          selectedKey={String(screenFrameRate)}
          onSelect={(key) =>
            setScreenShareQuality(
              screenShareQualityId(screenResolution, Number(key) as 15 | 30 | 60),
            )
          }
        />
      </SettingsBlock>
    </SettingsSection>
  );
}
