/**
 * Banner — an inline, in-flow notice for one screen or form: "this needs your
 * attention, here". The design system's form-level alert ("form düzeyi =
 * uyarı bandı"), the connection strip, a permission that is off.
 *
 * Borderless: the variant's 12% wash carries the tone, the glyph and title take
 * its ink, the body stays muted so a banner never shouts louder than the
 * screen. It drops in from 12px above on the standard step and retracts on the
 * fast one (framer `bannerDrop`). Danger/warning banners are announced as
 * alerts; info/success politely.
 */
import { View, type StyleProp, type ViewStyle } from "react-native";
import Animated, { Easing, Keyframe, ReduceMotion } from "react-native-reanimated";
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X, type LucideIcon } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { OVERLAY_MOTION } from "@/theme/motion-presets";
import { colors, motion, radius, space } from "@/theme/theme";
import { withAlpha } from "./kit-math";
import { Text } from "./Text";
import { Touchable } from "./Touchable";

export type BannerVariant = "info" | "success" | "warning" | "danger";

const BANNER: Record<BannerVariant, { bg: string; ink: string; icon: LucideIcon }> = {
  info: { bg: colors.surface, ink: colors.fgMuted, icon: Info },
  success: { bg: withAlpha(colors.success, 0.12), ink: colors.success, icon: CheckCircle2 },
  warning: { bg: withAlpha(colors.warning, 0.12), ink: colors.warning, icon: AlertTriangle },
  danger: { bg: colors.dangerSurface, ink: colors.danger, icon: AlertCircle },
};

const EASE = Easing.bezier(...motion.easing.standard).factory();
const { from, exitTo } = OVERLAY_MOTION.banner;
const ENTER = new Keyframe({
  0: { opacity: from.opacity, transform: [{ translateY: from.translateY }] },
  100: { opacity: 1, transform: [{ translateY: 0 }], easing: EASE },
})
  .duration(motion.duration.standard)
  .reduceMotion(ReduceMotion.System);
const EXIT = new Keyframe({
  0: { opacity: 1, transform: [{ translateY: 0 }] },
  100: { opacity: exitTo.opacity, transform: [{ translateY: exitTo.translateY }], easing: EASE },
})
  .duration(motion.duration.fast)
  .reduceMotion(ReduceMotion.System);

export function Banner({
  variant = "info",
  title,
  description,
  icon,
  action,
  onDismiss,
  live,
  style,
}: {
  variant?: BannerVariant;
  title: string;
  description?: string;
  /** Override the variant's glyph. */
  icon?: LucideIcon;
  /** One text action ("Tekrar dene", "Ayarları aç"). */
  action?: { label: string; onPress: () => void };
  /** Shows a close control. Omit for a banner that clears itself (offline strip). */
  onDismiss?: () => void;
  /**
   * Override how a CHANGE of the banner's text is announced. Default: assertive
   * for danger/warning, polite otherwise. A banner whose text ticks (a live
   * countdown) passes "none" — it is still an alert when it appears, but a
   * screen reader must not re-read it every second.
   */
  live?: "polite" | "assertive" | "none";
  style?: StyleProp<ViewStyle>;
}) {
  const { t } = useAppTranslation();
  const b = BANNER[variant];
  const Icon = icon ?? b.icon;
  const urgent = variant === "danger" || variant === "warning";
  return (
    <Animated.View
      entering={ENTER}
      exiting={EXIT}
      accessibilityRole={urgent ? "alert" : "summary"}
      accessibilityLiveRegion={live ?? (urgent ? "assertive" : "polite")}
      style={[
        {
          flexDirection: "row",
          alignItems: "flex-start",
          gap: space.md,
          backgroundColor: b.bg,
          borderRadius: radius.lg,
          borderCurve: "continuous",
          paddingVertical: space.md,
          paddingLeft: space.md + 2,
          paddingRight: onDismiss ? space.xs : space.md + 2,
          overflow: "hidden",
        },
        style,
      ]}
    >
      <Icon size={18} color={b.ink} strokeWidth={2} style={{ marginTop: 1 }} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: variant === "info" ? colors.fg : b.ink, fontSize: 14, lineHeight: 20, fontWeight: "600" }}>
          {title}
        </Text>
        {description ? (
          <Text style={{ color: colors.fgMuted, fontSize: 13, lineHeight: 18 }}>{description}</Text>
        ) : null}
        {action ? (
          <Touchable
            onPress={action.onPress}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            pressedTone={colors.wash}
            hitSlop={8}
            style={{ alignSelf: "flex-start", marginTop: space.xs, borderRadius: radius.sm, paddingVertical: 2 }}
          >
            <Text style={{ color: colors.accent, fontSize: 13, lineHeight: 18, fontWeight: "600" }}>
              {action.label}
            </Text>
          </Touchable>
        ) : null}
      </View>
      {onDismiss ? (
        <Touchable
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel={t("common:buttons.close")}
          pressedTone={colors.washStrong}
          hitSlop={6}
          style={{
            width: 32,
            height: 32,
            marginTop: -6,
            borderRadius: radius.pill,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <X size={16} color={colors.fgMuted} strokeWidth={2} />
        </Touchable>
      ) : null}
    </Animated.View>
  );
}
