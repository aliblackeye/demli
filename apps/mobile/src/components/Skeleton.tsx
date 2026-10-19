import { useEffect, type ReactNode } from "react";
import { View, type DimensionValue, type ViewStyle } from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  cancelAnimation,
  makeMutable,
  useAnimatedStyle,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useAppTranslation } from "@/lib/i18n";
import { useReducedMotion } from "../theme/motion";
import { colors, radius as radii, space } from "../theme/theme";

/**
 * Loading placeholders: blocks in the `wash-strong` tone (the design-system
 * skeleton fill, so they read on every container tone) with an opacity pulse —
 * the desktop `Skeleton`'s Tailwind `animate-pulse`, step for step: full
 * opacity → 50% → full over 2s on cubic-bezier(0.4, 0, 0.6, 1). Content taking
 * shape rather than a bare spinner; no gradient sweep (the system's choice is
 * the pulse, on both platforms).
 *
 * Performance (§27): ONE module-level shared value drives every block on
 * screen, on the UI thread. It is ref-counted, so the loop runs only while at
 * least one animated skeleton is mounted and is cancelled the moment the last
 * one unmounts — any number of skeletons cost one timing animation, never a
 * per-item JS loop, and no block measures itself or mounts extra views.
 *
 * Reduced motion: no pulse — the blocks render static at full fill, and the
 * loop is not even started for a viewer who asked for less motion.
 */

/** Half of the desktop 2s pulse: one way, then reversed. */
const PULSE_HALF_MS = 1000;
/** The pulse's low point (Tailwind `pulse` keyframe at 50%). */
const PULSE_LOW = 0.5;
const pulse = makeMutable(0);
let animatedCount = 0;

function acquirePulse(): void {
  animatedCount += 1;
  if (animatedCount === 1) {
    pulse.value = 0;
    pulse.value = withRepeat(
      withTiming(1, {
        duration: PULSE_HALF_MS,
        easing: Easing.bezier(0.4, 0, 0.6, 1),
        reduceMotion: ReduceMotion.System,
      }),
      -1,
      true,
    );
  }
}

function releasePulse(): void {
  animatedCount = Math.max(0, animatedCount - 1);
  if (animatedCount === 0) {
    cancelAnimation(pulse);
    pulse.value = 0;
  }
}

/** A single placeholder block. */
export function Skeleton({
  width,
  height,
  radius = radii.sm,
  style,
}: {
  width: DimensionValue;
  height: DimensionValue;
  radius?: number;
  style?: ViewStyle;
}) {
  const reduced = useReducedMotion();
  useEffect(() => {
    if (reduced) return;
    acquirePulse();
    return releasePulse;
  }, [reduced]);
  const pulseStyle = useAnimatedStyle(() => ({
    opacity: reduced ? 1 : 1 - (1 - PULSE_LOW) * pulse.value,
  }));
  return (
    <Animated.View
      style={[
        {
          width,
          height,
          borderRadius: radius,
          borderCurve: "continuous",
          backgroundColor: colors.washStrong,
        },
        style,
        pulseStyle,
      ]}
    />
  );
}

/**
 * The accessible wrapper every composed placeholder uses: one "loading"
 * announcement for the whole block instead of a dozen empty shapes.
 */
function LoadingRegion({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const { t } = useAppTranslation();
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t("mobile:ui.loading")}
      accessibilityState={{ busy: true }}
      style={style}
    >
      {children}
    </View>
  );
}

/**
 * One list-row placeholder: a leading avatar/icon plus one or two text lines —
 * the shape shared by the DM list, servers list, and friends list.
 */
export function SkeletonRow({
  lines = 2,
  leadingSize = 44,
  leadingRadius = radii.pill,
}: {
  lines?: 1 | 2;
  leadingSize?: number;
  leadingRadius?: number;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        paddingVertical: space.sm,
        paddingHorizontal: space.xs,
      }}
    >
      <Skeleton width={leadingSize} height={leadingSize} radius={leadingRadius} />
      <View style={{ flex: 1, gap: space.sm }}>
        <Skeleton width="52%" height={13} radius={radii.sm} />
        {lines > 1 ? <Skeleton width="78%" height={11} radius={radii.sm} /> : null}
      </View>
    </View>
  );
}

/** A vertical stack of {@link SkeletonRow}s for a list's first load. */
export function SkeletonList({
  count = 7,
  lines = 2,
  leadingSize = 44,
  leadingRadius = radii.pill,
}: {
  count?: number;
  lines?: 1 | 2;
  leadingSize?: number;
  leadingRadius?: number;
}) {
  return (
    <LoadingRegion style={{ gap: space.sm }}>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonRow key={i} lines={lines} leadingSize={leadingSize} leadingRadius={leadingRadius} />
      ))}
    </LoadingRegion>
  );
}

/**
 * Channel-list placeholder: a small square glyph + a single name line, matching
 * the group screen's channel rows (a section label sits above via the caller).
 */
export function SkeletonChannelRows({ count = 5 }: { count?: number }) {
  return (
    <LoadingRegion style={{ paddingHorizontal: space.md, gap: space.xs }}>
      {Array.from({ length: count }).map((_, i) => (
        <View
          key={i}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: space.md,
            paddingHorizontal: space.lg,
            paddingVertical: space.md,
            backgroundColor: colors.surface,
            borderRadius: radii.lg,
            borderCurve: "continuous",
          }}
        >
          <Skeleton width={20} height={20} radius={radii.sm} />
          <Skeleton width={`${40 + ((i * 13) % 35)}%`} height={13} radius={radii.sm} />
        </View>
      ))}
    </LoadingRegion>
  );
}

/**
 * Chat first-load placeholder: a handful of upright message rows (avatar + author
 * line + one or two content lines) with alternating widths so it reads like a
 * thread rather than a uniform grid. Rendered top-aligned (NOT inverted), so it
 * drops straight into a loading branch above the composer.
 */
export function SkeletonMessages({ count = 6 }: { count?: number }) {
  return (
    <LoadingRegion style={{ flex: 1, paddingHorizontal: space.md, paddingTop: space.md, gap: space.lg }}>
      {Array.from({ length: count }).map((_, i) => {
        const twoLines = i % 3 !== 1;
        return (
          <View key={i} style={{ flexDirection: "row", gap: space.md }}>
            <Skeleton width={40} height={40} radius={radii.pill} />
            <View style={{ flex: 1, gap: space.sm, paddingTop: 2 }}>
              <Skeleton width={`${28 + ((i * 11) % 22)}%`} height={12} radius={radii.sm} />
              <Skeleton width={`${62 + ((i * 17) % 30)}%`} height={12} radius={radii.sm} />
              {twoLines ? (
                <Skeleton width={`${40 + ((i * 23) % 35)}%`} height={12} radius={radii.sm} />
              ) : null}
            </View>
          </View>
        );
      })}
    </LoadingRegion>
  );
}
