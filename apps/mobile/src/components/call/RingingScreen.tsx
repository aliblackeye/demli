import { type ReactNode, useEffect, useRef } from "react";
import { Animated, Easing, View } from "react-native";
import { Text } from "../ui/Text";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Avatar } from "@/components/Avatar";
import { colors, space } from "@/theme/theme";

/**
 * Presentational full-screen ring layout shared by the incoming-call overlay and
 * the outgoing "Ringing…" state (ADR 0012 / Wave 7): a large avatar with a gentle
 * pulse, the peer name, a status line, and a caller-supplied action row pinned to
 * the bottom. Dark-first, deliberately calm (§7 — not a motion demo): one slow
 * opacity/scale pulse behind the avatar, nothing else.
 */
export function RingingScreen({
  name,
  avatarUri,
  statusLine,
  pulse = true,
  actions,
}: {
  name: string;
  avatarUri?: string | null;
  statusLine: string;
  /** Pulse the ring while genuinely ringing; off for a settled "Connecting…". */
  pulse?: boolean;
  actions: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!pulse) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, {
          toValue: 1,
          duration: 1100,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(anim, {
          toValue: 0,
          duration: 1100,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [anim, pulse]);

  const ringScale = anim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.35] });
  const ringOpacity = anim.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0] });

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.app,
        paddingTop: insets.top + space.xl,
        paddingBottom: insets.bottom + space.xl,
        paddingHorizontal: space.xl,
        alignItems: "center",
      }}
    >
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: space.lg }}>
        <View style={{ width: 120, height: 120, alignItems: "center", justifyContent: "center" }}>
          {pulse ? (
            <Animated.View
              style={{
                position: "absolute",
                width: 120,
                height: 120,
                borderRadius: 60,
                backgroundColor: colors.accent,
                opacity: ringOpacity,
                transform: [{ scale: ringScale }],
              }}
            />
          ) : null}
          <Avatar name={name} size={112} uri={avatarUri} />
        </View>
        <View style={{ alignItems: "center", gap: space.xs }}>
          <Text variant="display" style={{ color: colors.fg, fontSize: 24, fontWeight: "700" }} numberOfLines={1}>
            {name}
          </Text>
          <Text style={{ color: colors.fgMuted, fontSize: 15 }}>{statusLine}</Text>
        </View>
      </View>
      <View style={{ width: "100%" }}>{actions}</View>
    </View>
  );
}
