/**
 * The frame of the two blocking update screens (forced OTA, forced APK): the
 * boot splash's surface — black page, the mark under the one coral light — with
 * a display-face title, one honest line of what is happening, and the screen's
 * own progress / actions below. These screens replace the app until the update
 * lands, so they must feel like part of Demli's start-up, not an error page.
 */
import type { ReactNode } from "react";
import { View } from "react-native";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BrandMark } from "../components/BrandMark";
import { Glow } from "../components/ui/Glow";
import { Text } from "../components/ui/Text";
import { colors, motion, space } from "../theme/theme";

export function UpdateScreenFrame({
  title,
  body,
  children,
}: {
  title: string;
  /** What is happening right now — re-announced when it changes. */
  body: string;
  children?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.rail,
        alignItems: "center",
        justifyContent: "center",
        paddingHorizontal: space.xl,
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
      }}
    >
      <View style={{ width: "100%", maxWidth: 360, alignItems: "center", gap: space.xl }}>
        <View style={{ width: 96, height: 96, alignItems: "center", justifyContent: "center" }}>
          <Glow size={360} style={{ top: -132, left: -132 }} />
          <BrandMark size="lg" />
        </View>
        <View style={{ alignItems: "center", gap: space.sm }}>
          <Text
            variant="display"
            accessibilityRole="header"
            style={{ color: colors.fgDisplay, fontSize: 24, lineHeight: 30, fontWeight: "600", letterSpacing: -0.2, textAlign: "center" }}
          >
            {title}
          </Text>
          <Animated.View key={body} entering={FadeIn.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}>
            <Text
              accessibilityLiveRegion="polite"
              style={{ color: colors.fgMuted, fontSize: 15, lineHeight: 21, textAlign: "center" }}
            >
              {body}
            </Text>
          </Animated.View>
        </View>
        {children ? <View style={{ alignSelf: "stretch", gap: space.md }}>{children}</View> : null}
      </View>
    </View>
  );
}
