import { useId, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Stop } from "react-native-svg";
import { avatarTileGradient } from "@/theme/avatar-color";
import { useReducedMotion } from "@/theme/motion";
import { colors, motion } from "@/theme/theme";

/** The profile card banner's shape — the same 8:3 the desktop card and both crop editors use. */
export const BANNER_ASPECT = 8 / 3;

/**
 * A profile banner surface (M15, re-toned M16). Renders the uploaded `bannerUrl`
 * (GIF-capable via expo-image) when present, otherwise the per-user
 * deterministic gradient — the SAME hue that colours this person's cameraless
 * voice tile, so their colour is consistent across the app — under one soft
 * coral glow from the top edge (the design system's "mercan parıltı bandı").
 *
 * Size it with `height` (fixed) or `aspectRatio` (fills the width — the card
 * and the profile editor use {@link BANNER_ASPECT}). A failed photo falls back
 * to the gradient instead of a black hole, and is retried when the url changes.
 * Shared by the profile editor, the profile card and the crop editor's preview,
 * so the three can never draw a banner differently (CLAUDE.md §23).
 */
export function ProfileBannerImage({
  bannerUrl,
  seedId,
  height,
  aspectRatio,
  borderRadius = 0,
}: {
  bannerUrl?: string | null;
  /** Stable identity for the gradient fallback (usually the user id). */
  seedId: string;
  height?: number;
  aspectRatio?: number;
  borderRadius?: number;
}) {
  const id = useId();
  const glowId = `${id}-glow`;
  const reduced = useReducedMotion();
  const { from, to } = avatarTileGradient(seedId);
  const trimmed = bannerUrl?.trim() ? bannerUrl.trim() : null;
  const [failed, setFailed] = useState<string | null>(null);
  const showPhoto = trimmed !== null && failed !== trimmed;

  return (
    <View
      style={{
        height,
        aspectRatio: height === undefined ? (aspectRatio ?? BANNER_ASPECT) : undefined,
        width: height === undefined ? "100%" : undefined,
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
          <RadialGradient id={glowId} cx="50%" cy="0%" rx="70%" ry="90%">
            <Stop offset="0" stopColor={colors.accent} stopOpacity={0.24} />
            <Stop offset="1" stopColor={colors.accent} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${glowId})`} />
      </Svg>
      {showPhoto ? (
        <Image
          source={{ uri: trimmed }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          cachePolicy="memory-disk"
          transition={reduced ? 0 : motion.duration.fast}
          onError={() => setFailed(trimmed)}
          accessibilityIgnoresInvertColors
        />
      ) : null}
    </View>
  );
}
