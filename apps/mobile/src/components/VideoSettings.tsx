import { View } from "react-native";
import { Text } from "./ui/Text";
import { useAppTranslation } from "@/lib/i18n";
import { ChipSelect } from "@/components/ChipSelect";
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
import { colors, space, typography } from "@/theme/theme";

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

function SectionLabel({ children }: { children: string }) {
  return (
    <Text
      style={{
        color: colors.fgFaint,
        fontSize: typography.size["2xs"],
        fontWeight: "700",
        letterSpacing: 0.6,
        textTransform: "uppercase",
        paddingHorizontal: space.lg,
        paddingTop: space.lg,
        paddingBottom: space.xs,
      }}
    >
      {children}
    </Text>
  );
}

function FieldLabel({ children }: { children: string }) {
  return (
    <Text style={{ color: colors.fg, fontSize: 14, fontWeight: "600" }}>{children}</Text>
  );
}

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
    <View>
      <SectionLabel>{t("mobile:video.section")}</SectionLabel>

      <View style={{ paddingHorizontal: space.lg, gap: space.sm }}>
        <FieldLabel>{t("mobile:video.cameraQuality")}</FieldLabel>
        <ChipSelect
          options={[
            { key: "auto", label: t("mobile:video.cameraAuto") },
            { key: "hd", label: "720p" },
            { key: "fhd", label: "1080p" },
          ]}
          selectedKey={video.cameraQuality}
          onSelect={(key) => setCameraQuality(key as CameraQuality)}
        />
      </View>

      <View style={{ paddingHorizontal: space.lg, paddingTop: space.md, gap: space.sm }}>
        <FieldLabel>{t("mobile:video.frameRate")}</FieldLabel>
        <ChipSelect
          options={[
            { key: "30", label: "30 FPS" },
            { key: "60", label: "60 FPS" },
          ]}
          selectedKey={String(video.cameraFrameRate)}
          onSelect={(key) => setCameraFrameRate(Number(key) as CameraFrameRate)}
        />
      </View>

      <View style={{ paddingHorizontal: space.lg, paddingTop: space.md, gap: space.sm }}>
        <FieldLabel>{t("mobile:video.screenResolution")}</FieldLabel>
        <ChipSelect
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
      </View>

      <View style={{ paddingHorizontal: space.lg, paddingTop: space.md, gap: space.sm }}>
        <FieldLabel>{t("mobile:video.screenFrameRate")}</FieldLabel>
        <ChipSelect
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
      </View>

      <Text
        style={{
          color: colors.fgFaint,
          fontSize: 12,
          paddingHorizontal: space.lg,
          paddingTop: space.sm,
        }}
      >
        {t("mobile:video.note")}
      </Text>
    </View>
  );
}
