/**
 * The floating "an update is here" pill shared by the OTA banner and the
 * optional-APK banner — Koyu Masa's raised glass pill (the landing's inset pill
 * line + the soft halo), never a bordered box with a warm lift shadow.
 *
 * It floats above the bottom chrome: the safe area, the floating tab bar on the
 * three tab screens, and the voice bar while a call is up — it is drawn after
 * (over) all of them, so anywhere lower would cover the call's mute and leave. It arrives on the toast
 * choreography (12px up + a hair of scale, position spring) and leaves on the
 * fast step; reduced motion drops the travel.
 */
import type { ReactNode } from "react";
import { View } from "react-native";
import Animated, { Easing, FadeOut, Keyframe, ReduceMotion } from "react-native-reanimated";
import { X, type LucideIcon } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { floatingBottom } from "@/lib/bottom-chrome";
import { useBottomChromeClearance } from "@/lib/use-bottom-chrome";
import { OVERLAY_MOTION } from "@/theme/motion-presets";
import { colors, elevation, motion, radius, space } from "@/theme/theme";
import { Glass } from "../components/ui/Glass";
import { IconButton } from "../components/ui/IconButton";
import { withAlpha } from "../components/ui/kit-math";
import { Text } from "../components/ui/Text";

const { from } = OVERLAY_MOTION.toast;
const ENTER = new Keyframe({
  0: { opacity: from.opacity, transform: [{ translateY: from.translateY }, { scale: from.scale }] },
  100: {
    opacity: 1,
    transform: [{ translateY: 0 }, { scale: 1 }],
    easing: Easing.bezier(...motion.easing.arrival).factory(),
  },
})
  .duration(motion.duration.standard)
  .reduceMotion(ReduceMotion.System);
const EXIT = FadeOut.duration(motion.duration.fast).reduceMotion(ReduceMotion.System);

const PILL_SHADOW = `${elevation.pillInset.boxShadow}, 0 8px 24px ${withAlpha(colors.rail, 0.6)}`;

export function UpdatePill({
  icon: Icon,
  label,
  action,
  footer,
  onDismiss,
}: {
  icon: LucideIcon;
  label: string;
  /** The one action (a kit Button), or a busy indicator while it works. */
  action: ReactNode;
  /** Under the label — the download's real progress bar. */
  footer?: ReactNode;
  onDismiss: () => void;
}) {
  const { t } = useAppTranslation();
  const clearance = useBottomChromeClearance();

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        paddingBottom: floatingBottom(clearance),
        paddingHorizontal: space.lg,
        alignItems: "center",
      }}
    >
      <Animated.View entering={ENTER} exiting={EXIT} style={{ maxWidth: 440, alignSelf: "stretch" }}>
        <Glass strong style={{ borderRadius: radius.xl, borderCurve: "continuous", boxShadow: PILL_SHADOW }}>
          <View
            accessibilityRole="summary"
            accessibilityLiveRegion="polite"
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: space.md,
              paddingLeft: space.lg,
              paddingRight: space.xs,
              paddingVertical: space.sm,
            }}
          >
            <Icon size={18} color={colors.accent} strokeWidth={2} />
            <View style={{ flex: 1, gap: space.xs + 2 }}>
              <Text numberOfLines={2} style={{ color: colors.fg, fontSize: 14, lineHeight: 19, fontWeight: "500" }}>
                {label}
              </Text>
              {footer}
            </View>
            {action}
            <IconButton icon={X} size="sm" label={t("common:buttons.close")} onPress={onDismiss} />
          </View>
        </Glass>
      </Animated.View>
    </View>
  );
}
