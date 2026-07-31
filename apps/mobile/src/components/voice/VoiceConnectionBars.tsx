import { useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { Text } from "../ui/Text";
import { useAppTranslation } from "@/lib/i18n";
import type { ConnectionQualityLevel } from "@demli/media";
import { useVoiceStore } from "@/stores/voice-store";
import { colors, space, typography } from "@/theme/theme";

/**
 * Ping / connection-quality indicator (task #55) — three signal bars, the mobile
 * counterpart of the desktop `VoiceConnectionBars`. Same data (the engine's
 * `connectionQuality`, sampled from livekit) and same mapping:
 * excellent → 3 bars green · good → 2 bars amber · poor → 1 bar red.
 *
 * RN has no hover tooltip, so tapping reveals a small inline ping label that
 * auto-dismisses. Rendered only while connected (quality is meaningless off-call).
 */
const LEVEL_META = {
  excellent: { bars: 3, color: colors.online, labelKey: "mobile:voice.qualityExcellent" },
  good: { bars: 2, color: colors.idle, labelKey: "mobile:voice.qualityGood" },
  poor: { bars: 1, color: colors.danger, labelKey: "mobile:voice.qualityPoor" },
  unknown: { bars: 0, color: colors.fgFaint, labelKey: "mobile:voice.qualityMeasuring" },
} as const satisfies Record<
  ConnectionQualityLevel,
  { bars: number; color: string; labelKey: string }
>;

/** Ascending bar heights (px), short → tall. */
const BAR_HEIGHTS = [6, 9, 12] as const;
/** Unlit bar colour — `colors.fgFaint` (#8a7361) at 35%. */
const INACTIVE_BAR = "rgba(138,115,97,0.35)";
/** How long the tapped ping label stays up (ms). */
const LABEL_TIMEOUT_MS = 2500;

export function VoiceConnectionBars() {
  const { t } = useAppTranslation();
  const status = useVoiceStore((s) => s.status);
  const quality = useVoiceStore((s) => s.connectionQuality);
  const [showLabel, setShowLabel] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // Quality is only meaningful in a live room; the engine reports unknown
  // otherwise, so the indicator hides entirely off-call.
  if (status !== "connected") return null;

  const meta = LEVEL_META[quality.level];
  const label =
    quality.rttMs !== null ? t("mobile:voice.pingMs", { ms: quality.rttMs }) : t(meta.labelKey);

  const onPress = () => {
    setShowLabel(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setShowLabel(false), LABEL_TIMEOUT_MS);
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${t("mobile:voice.connectionQuality")}: ${label}`}
      onPress={onPress}
      hitSlop={8}
      style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}
    >
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 2, height: 12 }}>
        {BAR_HEIGHTS.map((h, i) => (
          <View
            key={h}
            style={{
              width: 3,
              height: h,
              borderRadius: 1.5,
              backgroundColor: i < meta.bars ? meta.color : INACTIVE_BAR,
            }}
          />
        ))}
      </View>
      {showLabel ? (
        <Text style={{ color: colors.fgMuted, fontSize: typography.size["2xs"], fontWeight: "600" }}>{label}</Text>
      ) : null}
    </Pressable>
  );
}
