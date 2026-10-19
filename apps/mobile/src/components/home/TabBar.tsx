/**
 * The bottom tab bar — Koyu Masa's floating nav pill, the phone reading of the
 * landing's nav hapı: a raised glass pill (the landing's inset pill line, the
 * design system's one allowed outer shadow — "mobil nav'ın yumuşak halesi")
 * floating over the page, content scrolling underneath it.
 *
 * One coral-wash indicator lives inside the pill and travels to the chosen tab
 * on the authored position spring (ζ≈1.34 — it arrives, it never overshoots).
 * Each tab's ink crossfades from faint to coral on the 200ms tone step as the
 * indicator reaches it. The Home tab's unread counter pops in when a count first
 * appears and out when it is cleared. Reduced motion jumps every one of these to
 * its end state.
 *
 * Geometry is pinned to TAB_BAR_CONTENT_HEIGHT (lib/tab-bar): the global voice
 * bar and every tab screen's bottom padding already clear exactly that much, so
 * the floating pill fits the space they reserve. The bar slides away while the
 * software keyboard is open (the Add-friend field must not be fought for).
 *
 * Navigation semantics are react-navigation's own: `tabPress` is emitted first
 * and honoured if a screen prevents it; long-press emits `tabLongPress`.
 */
import { useEffect, useState, type ComponentProps } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import Animated, {
  ReduceMotion,
  ZoomIn,
  ZoomOut,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import type { Tabs } from "expo-router";
import type { LucideIcon } from "lucide-react-native";
import { haptics } from "@/lib/haptics";
import { TAB_BAR_CONTENT_HEIGHT } from "@/lib/tab-bar";
import { useKeyboardHeight } from "@/lib/use-keyboard-height";
import { motionTo, useReducedMotion } from "@/theme/motion";
import { colors, elevation, motion, radius, space, typography } from "@/theme/theme";
import { CountPill } from "../ui/Badge";
import { Glass } from "../ui/Glass";
import { withAlpha } from "../ui/kit-math";
import { Text } from "../ui/Text";
import { Touchable } from "../ui/Touchable";
import { TAB_PILL_HEIGHT, TAB_PILL_PAD, tabIndicatorX, tabSlotWidth } from "./shell-math";

type TabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>["tabBar"]>>[0];

export type TabBarItem = {
  label: string;
  icon: LucideIcon;
  /** Pre-formatted counter (`unreadBadgeText`), or null for none. */
  badge?: { text: string; mention: boolean; a11y: string } | null;
};

/** The soft dark halo under the pill + the landing's inset pill line. */
const PILL_SHADOW = `${elevation.pillInset.boxShadow}, 0 8px 24px ${withAlpha(colors.rail, 0.6)}`;

export function DemliTabBar({
  state,
  navigation,
  insets,
  items,
}: TabBarProps & { items: Record<string, TabBarItem> }) {
  const reduced = useReducedMotion();
  const keyboard = useKeyboardHeight();
  const [width, setWidth] = useState(0);
  const count = state.routes.length;
  const slot = tabSlotWidth(width, count);

  const x = useSharedValue(0);
  const placed = useSharedValue(false);
  useEffect(() => {
    if (slot === 0) return;
    const target = tabIndicatorX(state.index, width, count);
    // First measurement: the indicator appears in place, it does not fly in.
    x.value = placed.value ? motionTo(target, "position", { reduced }) : target;
    placed.value = true;
  }, [state.index, width, count, slot, reduced, x, placed]);

  const hidden = useSharedValue(0);
  useEffect(() => {
    hidden.value = motionTo(keyboard > 0 ? 1 : 0, "fast", { reduced });
  }, [keyboard, reduced, hidden]);

  const indicator = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const barMotion = useAnimatedStyle(() => ({
    opacity: 1 - hidden.value,
    transform: [{ translateY: hidden.value * (TAB_BAR_CONTENT_HEIGHT + insets.bottom) }],
  }));

  return (
    <Animated.View
      pointerEvents={keyboard > 0 ? "none" : "box-none"}
      style={[
        {
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: TAB_BAR_CONTENT_HEIGHT + insets.bottom,
          paddingBottom: insets.bottom + (TAB_BAR_CONTENT_HEIGHT - TAB_PILL_HEIGHT),
          paddingHorizontal: space.lg,
          justifyContent: "flex-end",
        },
        barMotion,
      ]}
    >
      <Glass
        strong
        style={{
          height: TAB_PILL_HEIGHT,
          borderRadius: radius.pill,
          borderCurve: "continuous",
          boxShadow: PILL_SHADOW,
        }}
      >
        <View
          accessibilityRole="tablist"
          onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
          style={{ flex: 1, flexDirection: "row", padding: TAB_PILL_PAD }}
        >
          {slot > 0 ? (
            <Animated.View
              pointerEvents="none"
              style={[
                {
                  position: "absolute",
                  top: TAB_PILL_PAD,
                  bottom: TAB_PILL_PAD,
                  left: TAB_PILL_PAD,
                  width: slot,
                  borderRadius: radius.pill,
                  borderCurve: "continuous",
                  backgroundColor: colors.accentSurface,
                },
                indicator,
              ]}
            />
          ) : null}
          {state.routes.map((route, index) => {
            const item = items[route.name];
            if (!item) return null;
            const focused = state.index === index;
            return (
              <TabButton
                key={route.key}
                item={item}
                focused={focused}
                reduced={reduced}
                onPress={() => {
                  const event = navigation.emit({
                    type: "tabPress",
                    target: route.key,
                    canPreventDefault: true,
                  });
                  if (!focused && !event.defaultPrevented) {
                    haptics.selection();
                    navigation.navigate(route.name, route.params);
                  }
                }}
                onLongPress={() => navigation.emit({ type: "tabLongPress", target: route.key })}
              />
            );
          })}
        </View>
      </Glass>
    </Animated.View>
  );
}

function TabButton({
  item,
  focused,
  reduced,
  onPress,
  onLongPress,
}: {
  item: TabBarItem;
  focused: boolean;
  reduced: boolean;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const on = useSharedValue(focused ? 1 : 0);
  useEffect(() => {
    on.value = motionTo(focused ? 1 : 0, "tone", { reduced });
  }, [focused, reduced, on]);
  const activeLayer = useAnimatedStyle(() => ({ opacity: on.value }));
  const restLayer = useAnimatedStyle(() => ({ opacity: 1 - on.value }));
  const Icon = item.icon;
  const badge = item.badge ?? null;

  const layer = (ink: string) => (
    <>
      <Icon size={22} color={ink} strokeWidth={focused ? 2.2 : 2} />
      <Text
        selectable={false}
        numberOfLines={1}
        style={{ color: ink, fontSize: typography.size["2xs"], lineHeight: 14, fontWeight: "600" }}
      >
        {item.label}
      </Text>
    </>
  );

  return (
    <Touchable
      onPress={onPress}
      onLongPress={onLongPress}
      pressedTone={colors.wash}
      accessibilityRole="tab"
      accessibilityLabel={badge ? `${item.label}, ${badge.a11y}` : item.label}
      accessibilityState={{ selected: focused }}
      style={{
        flex: 1,
        borderRadius: radius.pill,
        borderCurve: "continuous",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <View style={{ alignItems: "center", justifyContent: "center" }}>
        <Animated.View style={[{ alignItems: "center", gap: 2 }, restLayer]}>{layer(colors.fgFaint)}</Animated.View>
        <Animated.View
          pointerEvents="none"
          style={[
            { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", gap: 2 },
            activeLayer,
          ]}
        >
          {layer(colors.accent)}
        </Animated.View>
        {badge ? (
          <Animated.View
            entering={ZoomIn.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
            exiting={ZoomOut.duration(motion.duration.instant).reduceMotion(ReduceMotion.System)}
            pointerEvents="none"
            style={{
              position: "absolute",
              top: -6,
              left: "50%",
              marginLeft: 6,
              borderRadius: radius.pill,
              borderWidth: 2,
              borderColor: colors.overlay,
            }}
          >
            <CountPill text={badge.text} tone={badge.mention ? "accent" : "neutral"} />
          </Animated.View>
        ) : null}
      </View>
    </Touchable>
  );
}
