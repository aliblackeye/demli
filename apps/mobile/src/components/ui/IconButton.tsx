/**
 * Icon-only button — the mobile twin of packages/ui `IconButton` + Tooltip.
 *
 * The label is REQUIRED: it is the accessible name (an icon alone says nothing
 * to TalkBack) and it is the tooltip a long press shows, Android's own idiom
 * for "what does this glyph do?". A caller with a real long-press action passes
 * `onLongPress` and the tooltip steps aside.
 *
 * `active` turns it into a toggle (mute, camera, deafen): announced as
 * selected, drawn in the coral wash (see TONES).
 *
 * The tooltip is a child of this button, placed in window coordinates
 * (kit-math `placeTooltip`): centred, kept inside the screen, flipped below
 * the button when the top bar leaves no room above. An ancestor with
 * `overflow: "hidden"` would still clip it — none of the toolbars do.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { View, useWindowDimensions, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import type { LucideIcon } from "lucide-react-native";
import { PRESS } from "@/theme/motion-presets";
import { colors, motion, radius, space } from "@/theme/theme";
import { placeTooltip, withAlpha } from "./kit-math";
import { Text } from "./Text";
import { CLEAR, Touchable, type HapticKind } from "./Touchable";

export type IconButtonVariant =
  | "ghost"
  | "secondary"
  | "accent"
  | "danger"
  | "dangerSolid"
  | "veil";

export type IconButtonSize = "sm" | "md" | "lg" | "xl";

/**
 * `active` (a toggle that is ON — muted, camera live, a selected tool) is the
 * coral wash with coral ink on every non-danger variant: the desktop
 * IconButton's `bg-accent-surface`, and the language the shipped mobile stage
 * controls already speak. Over video (`veil`) the wash is the strong one so it
 * still reads on a bright frame. Each state has its own pressed tone, so a
 * press always answers — an active control never flashes back to a neutral
 * tone, and an active danger control never drops to a faint wash.
 */
type Tones = {
  tone: string;
  pressed: string;
  ink: string;
  activeTone: string;
  activePressed: string;
  activeInk: string;
};

const CORAL_ACTIVE = {
  activeTone: colors.accentSurface,
  activePressed: colors.accentSurfaceStrong,
  activeInk: colors.accent,
} as const;

const TONES: Record<IconButtonVariant, Tones> = {
  ghost: {
    tone: CLEAR,
    pressed: colors.washStrong,
    ink: colors.fgMuted,
    ...CORAL_ACTIVE,
  },
  secondary: {
    tone: colors.surfaceRaised,
    pressed: colors.raisedHover,
    ink: colors.fg,
    ...CORAL_ACTIVE,
  },
  accent: {
    tone: colors.accent,
    pressed: colors.accentDeep,
    ink: colors.onAccent,
    ...CORAL_ACTIVE,
  },
  danger: {
    tone: colors.dangerSurface,
    pressed: withAlpha(colors.danger, 0.28),
    ink: colors.danger,
    activeTone: colors.danger,
    activePressed: withAlpha(colors.danger, 0.8),
    activeInk: colors.onAccent,
  },
  dangerSolid: {
    tone: colors.danger,
    pressed: withAlpha(colors.danger, 0.8),
    ink: colors.onAccent,
    activeTone: colors.danger,
    activePressed: withAlpha(colors.danger, 0.8),
    activeInk: colors.onAccent,
  },
  /** Over video / images: the translucent veil pill. */
  veil: {
    tone: colors.veil,
    pressed: withAlpha(colors.rail, 0.4),
    ink: colors.fgDisplay,
    activeTone: colors.accentSurfaceStrong,
    activePressed: withAlpha(colors.accent, 0.36),
    activeInk: colors.accent,
  },
};

/** Box size, glyph size, and the slop that brings every size to ≥44pt. */
const SIZES: Record<IconButtonSize, { box: number; icon: number; slop: number }> = {
  sm: { box: 32, icon: 16, slop: 6 },
  md: { box: 40, icon: 20, slop: 2 },
  lg: { box: 48, icon: 22, slop: 0 },
  xl: { box: 56, icon: 24, slop: 0 },
};

const TOOLTIP_MS = 1500;
/** The widest a tooltip pill may grow before its label wraps (2 lines max). */
const TOOLTIP_MAX_W = 200;

export type IconButtonProps = {
  icon: LucideIcon;
  /** Accessible name + long-press tooltip. */
  label: string;
  onPress?: () => void;
  onLongPress?: () => void;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  /** Round (call controls, media) or rounded-square (toolbars). */
  shape?: "circle" | "square";
  /** Drawn in the variant's active tone (a selected tool, a live control). */
  active?: boolean;
  /**
   * The button flips a setting (mute, camera): announced as a toggle with its
   * on/off state instead of as a plain button.
   */
  toggle?: boolean;
  disabled?: boolean;
  haptic?: HapticKind;
  /** A small counter / dot in the corner (a pending count, a live marker). */
  badge?: ReactNode;
  accessibilityHint?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
};

export function IconButton({
  icon: Icon,
  label,
  onPress,
  onLongPress,
  variant = "ghost",
  size = "md",
  shape = "circle",
  active = false,
  toggle = false,
  disabled = false,
  haptic,
  badge,
  accessibilityHint,
  testID,
  style,
}: IconButtonProps) {
  const t = TONES[variant];
  const s = SIZES[size];
  const { width: screenWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const host = useRef<View>(null);
  // Two steps: the anchor is measured in window coordinates on long press,
  // then the pill measures itself (invisible) and is placed — clamped inside
  // the screen and flipped below when there is no room above.
  const [anchor, setAnchor] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [pill, setPill] = useState<{ w: number; h: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const hideTip = () => {
    setAnchor(null);
    setPill(null);
  };

  const showTip = () => {
    host.current?.measureInWindow((x, y, w, h) => {
      setPill(null);
      setAnchor({ x, y, w, h });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(hideTip, TOOLTIP_MS);
    });
  };

  const onPillLayout = (e: LayoutChangeEvent) => {
    const { width: w, height: h } = e.nativeEvent.layout;
    if (!pill || pill.w !== w || pill.h !== h) setPill({ w, h });
  };

  const tipWidthCap = Math.min(TOOLTIP_MAX_W, screenWidth - 2 * space.sm);
  const placement =
    anchor && pill
      ? placeTooltip({
          anchorX: anchor.x,
          anchorY: anchor.y,
          anchorWidth: anchor.w,
          anchorHeight: anchor.h,
          tipWidth: pill.w,
          tipHeight: pill.h,
          screenWidth,
          safeTop: insets.top,
          margin: space.sm,
          gap: space.sm,
        })
      : null;

  return (
    <View ref={host} collapsable={false} style={[{ alignItems: "center" }, style]}>
      <Touchable
        onPress={onPress}
        onLongPress={onLongPress ?? showTip}
        disabled={disabled}
        haptic={haptic}
        tone={active ? t.activeTone : t.tone}
        pressedTone={active ? t.activePressed : t.pressed}
        pressScale={PRESS.scale.icon}
        hitSlop={s.slop}
        accessibilityRole={toggle ? "togglebutton" : "button"}
        accessibilityLabel={label}
        accessibilityHint={accessibilityHint}
        accessibilityState={toggle ? { checked: active } : { selected: active }}
        testID={testID}
        style={{
          width: s.box,
          height: s.box,
          borderRadius: shape === "circle" ? radius.pill : radius.lg,
          borderCurve: "continuous",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon size={s.icon} color={active ? t.activeInk : t.ink} strokeWidth={2} />
      </Touchable>
      {badge ? (
        <View pointerEvents="none" style={{ position: "absolute", top: -2, right: -2 }}>
          {badge}
        </View>
      ) : null}
      {anchor ? (
        // The box is as wide as the pill may grow and is NOT sized by this
        // 32-56px button (an absolute child is otherwise capped to its
        // parent's width, which squeezed the label to a few letters).
        <Animated.View
          exiting={FadeOut.duration(motion.duration.instant).reduceMotion(ReduceMotion.System)}
          pointerEvents="none"
          importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden
          style={{
            position: "absolute",
            top: placement ? placement.top : 0,
            left: placement ? placement.left : 0,
            width: tipWidthCap,
            alignItems: "flex-start",
            opacity: placement ? 1 : 0,
          }}
        >
          {placement ? (
            <Animated.View
              entering={FadeIn.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
              style={{
                width: pill?.w,
                backgroundColor: colors.glassStrong,
                borderRadius: radius.sm,
                borderCurve: "continuous",
                paddingHorizontal: space.sm,
                paddingVertical: space.xs,
              }}
            >
              <Text type="meta" tone="default" numberOfLines={2} style={{ textAlign: "center" }}>
                {label}
              </Text>
            </Animated.View>
          ) : (
            // Invisible measuring pass: shrink-wraps the label up to the cap.
            <View
              onLayout={onPillLayout}
              style={{ maxWidth: tipWidthCap, paddingHorizontal: space.sm, paddingVertical: space.xs }}
            >
              <Text type="meta" tone="default" numberOfLines={2} style={{ textAlign: "center" }}>
                {label}
              </Text>
            </View>
          )}
        </Animated.View>
      ) : null}
    </View>
  );
}
