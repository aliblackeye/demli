import { useEffect } from "react";
import { Animated, type DimensionValue, type ViewStyle } from "react-native";
import { colors, radius as radii, space } from "../theme/theme";

/**
 * Lightweight loading placeholders (audit #13) — an opacity "pulse" in place of a
 * bare spinner, so a first load reads as content taking shape rather than a blank
 * screen. Deliberately shimmer-free (no gradient sweep, no reanimated): a single
 * shared Animated value drives every placeholder off the native thread, so any
 * number of skeletons on screen cost one interpolation, never a per-item JS loop
 * (CLAUDE.md §27). OTA-safe — pure JS, no native module.
 */

// One module-level driver, ref-counted so the loop runs ONLY while skeletons are
// mounted and stops (resetting to a stable value) the moment the last one hides.
const pulse = new Animated.Value(0);
let mounted = 0;
let loop: Animated.CompositeAnimation | null = null;

function acquirePulse(): void {
  mounted += 1;
  if (mounted === 1) {
    loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 750, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 750, useNativeDriver: true }),
      ]),
    );
    loop.start();
  }
}

function releasePulse(): void {
  mounted -= 1;
  if (mounted <= 0) {
    mounted = 0;
    loop?.stop();
    loop = null;
    pulse.setValue(0);
  }
}

/** A single pulsing placeholder block. */
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
  useEffect(() => {
    acquirePulse();
    return releasePulse;
  }, []);

  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.7] });

  return (
    <Animated.View
      style={[
        {
          width,
          height,
          borderRadius: radius,
          borderCurve: "continuous",
          backgroundColor: colors.surfaceRaised,
          opacity,
        },
        style,
      ]}
    />
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
    <Animated.View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        paddingVertical: space.sm,
        paddingHorizontal: space.xs,
      }}
    >
      <Skeleton width={leadingSize} height={leadingSize} radius={leadingRadius} />
      <Animated.View style={{ flex: 1, gap: space.sm }}>
        <Skeleton width="52%" height={13} radius={radii.sm} />
        {lines > 1 ? <Skeleton width="78%" height={11} radius={radii.sm} /> : null}
      </Animated.View>
    </Animated.View>
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
    <Animated.View style={{ gap: space.sm }}>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonRow key={i} lines={lines} leadingSize={leadingSize} leadingRadius={leadingRadius} />
      ))}
    </Animated.View>
  );
}

/**
 * Channel-list placeholder: a small square glyph + a single name line, matching
 * the group screen's channel rows (a section label sits above via the caller).
 */
export function SkeletonChannelRows({ count = 5 }: { count?: number }) {
  return (
    <Animated.View style={{ paddingHorizontal: space.md, gap: space.xs }}>
      {Array.from({ length: count }).map((_, i) => (
        <Animated.View
          key={i}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: space.md,
            paddingHorizontal: space.lg,
            paddingVertical: space.md,
            backgroundColor: colors.surface,
            borderRadius: radii.md,
            borderCurve: "continuous",
          }}
        >
          <Skeleton width={20} height={20} radius={radii.sm} />
          <Skeleton width={`${40 + ((i * 13) % 35)}%`} height={13} radius={radii.sm} />
        </Animated.View>
      ))}
    </Animated.View>
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
    <Animated.View style={{ flex: 1, paddingHorizontal: space.md, paddingTop: space.md, gap: space.lg }}>
      {Array.from({ length: count }).map((_, i) => {
        const twoLines = i % 3 !== 1;
        return (
          <Animated.View key={i} style={{ flexDirection: "row", gap: space.md }}>
            <Skeleton width={40} height={40} radius={radii.pill} />
            <Animated.View style={{ flex: 1, gap: space.sm, paddingTop: 2 }}>
              <Skeleton width={`${28 + ((i * 11) % 22)}%`} height={12} radius={radii.sm} />
              <Skeleton width={`${62 + ((i * 17) % 30)}%`} height={12} radius={radii.sm} />
              {twoLines ? (
                <Skeleton width={`${40 + ((i * 23) % 35)}%`} height={12} radius={radii.sm} />
              ) : null}
            </Animated.View>
          </Animated.View>
        );
      })}
    </Animated.View>
  );
}
