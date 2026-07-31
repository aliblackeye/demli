import { useId } from "react";
import { StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { avatarTileGradient } from "@/theme/avatar-color";
import { colors } from "@/theme/theme";

/**
 * A profile banner surface (M15). Renders the uploaded `bannerUrl` (GIF-capable
 * via expo-image) when present, otherwise the per-user deterministic gradient —
 * the SAME hue that colors this person's cameraless voice tile, so their color is
 * consistent across the app. Shared by the profile edit screen and the profile
 * card so the two never diverge (CLAUDE.md §23).
 */
export function ProfileBannerImage({
  bannerUrl,
  seedId,
  height,
  borderRadius = 0,
}: {
  bannerUrl?: string | null;
  /** Stable identity for the gradient fallback (usually the user id). */
  seedId: string;
  height: number;
  borderRadius?: number;
}) {
  const id = useId();
  const { from, to } = avatarTileGradient(seedId);
  const trimmed = bannerUrl?.trim() ? bannerUrl.trim() : null;

  return (
    <View
      style={{
        height,
        borderRadius,
        borderCurve: "continuous",
        overflow: "hidden",
        backgroundColor: colors.surface,
      }}
    >
      <Svg width="100%" height="100%" style={StyleSheet.absoluteFill} pointerEvents="none">
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={from} />
            <Stop offset="1" stopColor={to} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
      {trimmed ? (
        <Image
          source={{ uri: trimmed }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={120}
          accessibilityIgnoresInvertColors
        />
      ) : null}
    </View>
  );
}
