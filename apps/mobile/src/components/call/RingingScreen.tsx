import { type ReactNode, useId } from "react";
import { View } from "react-native";
import Animated, { FadeIn, ReduceMotion, useAnimatedStyle } from "react-native-reanimated";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Avatar } from "@/components/Avatar";
import { useBreath } from "@/components/voice/stage-chrome";
import { colors, motion, space } from "@/theme/theme";
import { Text } from "../ui/Text";

/** The avatar at the centre of every ring surface. */
const AVATAR = 112;
/** The glow field behind it — wide enough that the light falls off before the edge. */
const GLOW = 300;

/**
 * Presentational full-screen ring layout shared by the incoming-call overlay, the
 * "Connecting…" hand-off, the ended outcome and the seat-away band (ADR 0012 /
 * Wave 7): the person, a status line, and a caller-supplied action area pinned to
 * the bottom.
 *
 * Koyu Masa "dem ışığı": the one warm light on the black page is a coral radial
 * glow behind the avatar (`accent-glow`, the landing's light motif). While the
 * call is genuinely RINGING it breathes — one slow 1.4s in-and-out, the design
 * system's incoming-call recipe — and nothing else on the screen moves. Settled
 * states (connecting, ended, seat away) keep the light but hold it still, so a
 * pulse always means "someone is waiting for an answer". Under reduced motion the
 * light is simply on.
 *
 * The content settles in on the arrival curve, so the ring never snaps over the
 * screen the user was on.
 */
export function RingingScreen({
  name,
  avatarUri,
  statusLine,
  pulse = true,
  statusTone = "muted",
  actions,
}: {
  name: string;
  avatarUri?: string | null;
  statusLine: string;
  /** Breathe the light while genuinely ringing; still for a settled state. */
  pulse?: boolean;
  /** `accent` for a live ring, `muted` for everything settled. */
  statusTone?: "muted" | "accent";
  actions: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const breath = useBreath(pulse);
  const glowId = useId();

  const glowStyle = useAnimatedStyle(() => ({
    // Still states rest at the full light; a ring breathes between 55% and 100%.
    opacity: pulse ? 0.55 + 0.45 * breath.value : 0.85,
    transform: [{ scale: pulse ? 0.9 + 0.12 * breath.value : 1 }],
  }));

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.rail,
        paddingTop: insets.top + space.xl,
        paddingBottom: insets.bottom + space.xl,
        paddingHorizontal: space.xl,
        alignItems: "center",
      }}
    >
      <Animated.View
        entering={FadeIn.duration(motion.duration.arrival).reduceMotion(ReduceMotion.System)}
        style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: space.xl }}
      >
        <View style={{ width: GLOW, height: GLOW, alignItems: "center", justifyContent: "center" }}>
          <Animated.View
            pointerEvents="none"
            importantForAccessibility="no-hide-descendants"
            style={[{ position: "absolute", width: GLOW, height: GLOW }, glowStyle]}
          >
            <Svg width={GLOW} height={GLOW}>
              <Defs>
                <RadialGradient id={glowId} cx="50%" cy="50%" r="50%">
                  <Stop offset="0" stopColor={colors.accent} stopOpacity={0.34} />
                  <Stop offset="0.45" stopColor={colors.accent} stopOpacity={0.14} />
                  <Stop offset="1" stopColor={colors.accent} stopOpacity={0} />
                </RadialGradient>
              </Defs>
              <Rect x="0" y="0" width={GLOW} height={GLOW} fill={`url(#${glowId})`} />
            </Svg>
          </Animated.View>
          <Avatar name={name} size={AVATAR} uri={avatarUri} ring ringColor={colors.rail} />
        </View>
        <View style={{ alignItems: "center", gap: space.sm, maxWidth: "100%" }}>
          <Text type="title" tone="display" numberOfLines={1} accessibilityRole="header" style={{ fontSize: 26, lineHeight: 32 }}>
            {name}
          </Text>
          <Text
            type="ui"
            tone={statusTone}
            accessibilityLiveRegion="polite"
            style={{ textAlign: "center", fontWeight: "500" }}
          >
            {statusLine}
          </Text>
        </View>
      </Animated.View>
      <View style={{ width: "100%" }}>{actions}</View>
    </View>
  );
}
