import { Platform, View } from "react-native";
import { MonitorPlay, ScreenShare } from "lucide-react-native";
import {
  ANDROID_SCREEN_CAPTURE_MAX_FPS,
  screenShareFrameRatesUpTo,
  SCREEN_SHARE_QUALITY_PROFILES,
  SCREEN_SHARE_RESOLUTIONS,
  screenShareFrameRateOf,
  screenShareQualityId,
  screenShareResolutionOf,
  type ScreenShareResolution,
} from "@demli/media";
import { useAppTranslation } from "@/lib/i18n";
import { useMediaSettings } from "@/stores/media-settings";
import { space } from "@/theme/theme";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { Sheet } from "../ui/Sheet";
import { Text } from "../ui/Text";

/** Resolution tier → chip label (1440p is marketed as 2K). */
const SCREEN_RESOLUTION_LABEL: Record<ScreenShareResolution, string> = {
  "480p": "480p",
  "720p": "720p",
  "1080p": "1080p",
  "1440p": "2K",
};

/**
 * Screen-share QUALITY sheet (founder P0 #112, mobile parity with the desktop
 * SourcePicker's quality picker). Opens when the user starts a share: pick
 * resolution + frame-rate — persisted to `useMediaSettings` so the next share opens
 * with the same choice AND the engine publishes at exactly this cell — then
 * "Start sharing" runs the real `onConfirm` (the parent's screen-share toggle, which
 * triggers the OS MediaProjection/broadcast consent).
 *
 * On Android it also carries the "Entire screen" guidance (single-app projection is
 * not reliably captured — see VoiceControls), so this one sheet replaces the old
 * bare Alert while adding the quality controls. Engine boundary (CLAUDE.md §11): the
 * sheet only writes the persisted preference + calls the parent toggle; it never
 * touches the engine's VoiceState or acquires a track itself.
 *
 * Drawn by the kit: the draggable Sheet, radio Chips for each axis (the chosen one
 * in the coral wash), the Android guidance as an info Banner, and the primary
 * action pinned in the footer so it never scrolls away.
 */
export function ScreenShareQualitySheet({
  visible,
  onClose,
  onConfirm,
}: {
  visible: boolean;
  onClose: () => void;
  /** Start the share (the parent's screen-share toggle — the sheet only opens while OFF). */
  onConfirm: () => void;
}) {
  const { t } = useAppTranslation();
  const screenShareQuality = useMediaSettings((s) => s.video.screenShareQuality);
  const setScreenShareQuality = useMediaSettings((s) => s.setScreenShareQuality);

  const resolution = screenShareResolutionOf(screenShareQuality);
  const frameRate = screenShareFrameRateOf(screenShareQuality);
  const profile = SCREEN_SHARE_QUALITY_PROFILES[screenShareQuality];
  const summary = `${profile.height}p · ${profile.frameRate} fps · ~${
    profile.maxBitrateBps / 1_000_000
  } Mbps`;

  const start = (): void => {
    onConfirm();
    onClose();
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={t("mobile:voice.shareQuality.title")}
      description={t("mobile:voice.shareQuality.subtitle")}
      footer={
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <Button
            variant="secondary"
            size="lg"
            label={t("mobile:voice.shareScreenHint.cancel")}
            onPress={onClose}
            style={{ flex: 1 }}
          />
          <Button
            variant="accent"
            size="lg"
            icon={ScreenShare}
            haptic="medium"
            label={t("mobile:voice.shareQuality.start")}
            onPress={start}
            style={{ flex: 2 }}
          />
        </View>
      }
    >
      <View style={{ paddingHorizontal: space.xs, gap: space.lg }}>
        {/* Resolution axis */}
        <View style={{ gap: space.sm }}>
          <Text type="label" tone="default">
            {t("mobile:voice.shareQuality.resolution")}
          </Text>
          <View accessibilityRole="radiogroup" style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
            {SCREEN_SHARE_RESOLUTIONS.map((res) => (
              <Chip
                key={res}
                role="radio"
                label={SCREEN_RESOLUTION_LABEL[res]}
                selected={res === resolution}
                haptic="light"
                onPress={() => setScreenShareQuality(screenShareQualityId(res, frameRate))}
              />
            ))}
          </View>
        </View>

        {/* Frame-rate axis */}
        <View style={{ gap: space.sm }}>
          <Text type="label" tone="default">
            {t("mobile:voice.shareQuality.frameRate")}
          </Text>
          <View accessibilityRole="radiogroup" style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
            {/* Android captures the screen at a fixed 30fps, so a 60 chip here
                would take the user's money in uplink and give back nothing (see
                ANDROID_SCREEN_CAPTURE_MAX_FPS). Filtered, not disabled: a greyed
                chip still asks "why not?", and the answer is that it isn't a tier. */}
            {screenShareFrameRatesUpTo(ANDROID_SCREEN_CAPTURE_MAX_FPS).map((fps) => (
              <Chip
                key={fps}
                role="radio"
                label={`${fps} FPS`}
                selected={fps === frameRate}
                haptic="light"
                onPress={() =>
                  setScreenShareQuality(screenShareQualityId(resolution, fps as 15 | 30 | 60))
                }
              />
            ))}
          </View>
        </View>

        {/* Live summary of the composed cell. */}
        <Text type="meta" tone="faint" style={{ fontVariant: ["tabular-nums"] }}>
          {summary}
        </Text>

        {/* Android-only "Entire screen" guidance (single-app capture is unreliable). */}
        {Platform.OS === "android" ? (
          <Banner
            variant="info"
            icon={MonitorPlay}
            title={t("mobile:voice.shareScreenHint.title")}
            description={t("mobile:voice.shareScreenHint.message")}
          />
        ) : null}
      </View>
    </Sheet>
  );
}
