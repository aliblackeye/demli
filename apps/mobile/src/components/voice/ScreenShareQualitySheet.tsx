import { Modal, Platform, Pressable, View } from "react-native";
import { Text } from "../ui/Text";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
import { haptics } from "@/lib/haptics";
import { ChipSelect } from "@/components/ChipSelect";
import { useMediaSettings } from "@/stores/media-settings";
import { colors, radius, space } from "@/theme/theme";

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
  const insets = useSafeAreaInsets();
  const screenShareQuality = useMediaSettings((s) => s.video.screenShareQuality);
  const setScreenShareQuality = useMediaSettings((s) => s.setScreenShareQuality);

  const resolution = screenShareResolutionOf(screenShareQuality);
  const frameRate = screenShareFrameRateOf(screenShareQuality);
  const profile = SCREEN_SHARE_QUALITY_PROFILES[screenShareQuality];
  const summary = `${profile.height}p · ${profile.frameRate} fps · ~${
    profile.maxBitrateBps / 1_000_000
  } Mbps`;

  const start = (): void => {
    haptics.medium();
    onConfirm();
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        accessibilityLabel={t("common:buttons.close")}
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" }}
      >
        {/* Card. Its own Pressable swallows taps so they don't dismiss the sheet. */}
        <Pressable
          onPress={() => {}}
          style={{
            backgroundColor: colors.surface,
            borderTopLeftRadius: radius.lg,
            borderTopRightRadius: radius.lg,
            borderCurve: "continuous",
            borderTopWidth: 1,
            borderColor: colors.stroke,
            paddingTop: space.md,
            paddingBottom: space.md + insets.bottom,
            paddingHorizontal: space.lg,
            gap: space.md,
          }}
        >
        {/* Grab handle. */}
        <View
          style={{
            alignSelf: "center",
            width: 36,
            height: 4,
            borderRadius: radius.pill,
            backgroundColor: colors.strokeStrong,
          }}
        />

        <View style={{ gap: 2 }}>
          <Text variant="display" style={{ color: colors.fg, fontSize: 17, fontWeight: "800" }}>
            {t("mobile:voice.shareQuality.title")}
          </Text>
          <Text style={{ color: colors.fgMuted, fontSize: 13 }}>
            {t("mobile:voice.shareQuality.subtitle")}
          </Text>
        </View>

        {/* Resolution axis */}
        <View style={{ gap: space.sm }}>
          <Text style={{ color: colors.fg, fontSize: 14, fontWeight: "600" }}>
            {t("mobile:voice.shareQuality.resolution")}
          </Text>
          <ChipSelect
            options={SCREEN_SHARE_RESOLUTIONS.map((res) => ({
              key: res,
              label: SCREEN_RESOLUTION_LABEL[res],
            }))}
            selectedKey={resolution}
            onSelect={(key) =>
              setScreenShareQuality(
                screenShareQualityId(key as ScreenShareResolution, frameRate),
              )
            }
          />
        </View>

        {/* Frame-rate axis */}
        <View style={{ gap: space.sm }}>
          <Text style={{ color: colors.fg, fontSize: 14, fontWeight: "600" }}>
            {t("mobile:voice.shareQuality.frameRate")}
          </Text>
          <ChipSelect
            // Android captures the screen at a fixed 30fps, so a 60 chip here
            // would take the user's money in uplink and give back nothing (see
            // ANDROID_SCREEN_CAPTURE_MAX_FPS). Filtered, not disabled: a greyed
            // chip still asks "why not?", and the answer is that it isn't a tier.
            options={screenShareFrameRatesUpTo(ANDROID_SCREEN_CAPTURE_MAX_FPS).map((fps) => ({
              key: String(fps),
              label: `${fps} FPS`,
            }))}
            selectedKey={String(frameRate)}
            onSelect={(key) =>
              setScreenShareQuality(
                screenShareQualityId(resolution, Number(key) as 15 | 30 | 60),
              )
            }
          />
        </View>

        {/* Live summary of the composed cell. */}
        <Text style={{ color: colors.fgFaint, fontSize: 12 }}>{summary}</Text>

        {/* Android-only "Entire screen" guidance (single-app capture is unreliable). */}
        {Platform.OS === "android" ? (
          <View
            style={{
              flexDirection: "row",
              gap: space.sm,
              backgroundColor: colors.surfaceRaised,
              borderRadius: radius.md,
              borderCurve: "continuous",
              padding: space.md,
            }}
          >
            <MonitorPlay size={18} color={colors.fgMuted} style={{ marginTop: 1 }} />
            <Text style={{ flex: 1, color: colors.fgMuted, fontSize: 12, lineHeight: 17 }}>
              {t("mobile:voice.shareScreenHint.message")}
            </Text>
          </View>
        ) : null}

        <View style={{ flexDirection: "row", gap: space.sm }}>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            style={({ pressed }) => ({
              flex: 1,
              minHeight: 48,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: radius.md,
              borderCurve: "continuous",
              backgroundColor: colors.surfaceRaised,
              opacity: pressed ? 0.85 : 1,
            })}
          >
            <Text style={{ color: colors.fg, fontSize: 15, fontWeight: "700" }}>
              {t("mobile:voice.shareScreenHint.cancel")}
            </Text>
          </Pressable>
          <Pressable
            onPress={start}
            accessibilityRole="button"
            style={({ pressed }) => ({
              flex: 2,
              minHeight: 48,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: space.sm,
              borderRadius: radius.md,
              borderCurve: "continuous",
              backgroundColor: colors.accent,
              opacity: pressed ? 0.85 : 1,
            })}
          >
            <ScreenShare size={18} color={colors.onAccent} />
            <Text style={{ color: colors.onAccent, fontSize: 15, fontWeight: "700" }}>
              {t("mobile:voice.shareQuality.start")}
            </Text>
          </Pressable>
        </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
