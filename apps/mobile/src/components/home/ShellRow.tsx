/**
 * The ONE row language of the mobile shell — the twin of the desktop `shellRow`
 * (packages/app-ui/src/components/shellRow.ts). Channel rows, DM and group-chat
 * rows, roster rows and command-palette rows all paint their states from here,
 * so "selected" means the same thing — and looks the same — on every list, on
 * both platforms.
 *
 *   rest      no fill on the column; the label in muted ink
 *   pressed   one step deeper (`raised-pressed`) — a TONE change in on the 120ms
 *             step and out on the 200ms one. Nothing lifts, slides or scales
 *             (founder rule: a row never bounces)
 *   selected  coral wash + light-coral label — the landing's channel-list recipe
 *             and the same coral as the rail's selected pill
 *   unread    the label lifts to `fg`, and a short white pip sits on the column's
 *             left edge (coral when a mention waits) — the same signal, at the
 *             same edge, as the rail's short unread pill
 *   muted     the whole row quiets to 55% unless it is selected or unread
 */
import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import Animated, { ReduceMotion, ZoomIn } from "react-native-reanimated";
import { colors, motion, radius, space } from "@/theme/theme";
import { CLEAR, Touchable } from "../ui/Touchable";

export type ShellRowState = {
  selected?: boolean;
  unread?: boolean;
  muted?: boolean;
};

/** Label ink for a row in this state. */
export function shellRowInk({ selected = false, unread = false }: ShellRowState): string {
  if (selected) return colors.accentHover;
  if (unread) return colors.fg;
  return colors.fgMuted;
}

/** Leading-glyph ink: one step quieter than the label, coral when selected. */
export function shellRowIconInk({ selected = false, unread = false }: ShellRowState): string {
  if (selected) return colors.accent;
  if (unread) return colors.fg;
  return colors.fgFaint;
}

/** Rest + pressed fill for a row in this state. */
export function shellRowTones({ selected = false }: ShellRowState): { tone: string; pressed: string } {
  return selected
    ? { tone: colors.selected, pressed: colors.accentSurfaceStrong }
    : { tone: CLEAR, pressed: colors.raisedPressed };
}

/** Opacity for the muted state (never dims a selected or unread row). */
export function shellRowOpacity({ selected = false, unread = false, muted = false }: ShellRowState): number {
  return muted && !selected && !unread ? 0.55 : 1;
}

/**
 * The unread pip on a row's left edge. `gutter` peeks into the list's side
 * gutter (the list must leave ≥8px of padding there); `inset` sits on the row.
 */
export function UnreadPip({ mention, placement = "gutter" }: { mention: boolean; placement?: "gutter" | "inset" }) {
  return (
    <Animated.View
      entering={ZoomIn.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
      // No `exiting`: the pip lives in virtualized (removeClippedSubviews) list
      // cells, and an exit animation keeps a view alive past its React removal —
      // the reparenting pattern behind the Fabric "view already has a parent" P0.
      // Clearing an unread is an instant removal.
      pointerEvents="none"
      importantForAccessibility="no"
      style={{
        position: "absolute",
        left: placement === "gutter" ? -space.sm : 0,
        top: "50%",
        marginTop: -4,
        width: 4,
        height: 8,
        borderTopRightRadius: radius.pill,
        borderBottomRightRadius: radius.pill,
        backgroundColor: mention ? colors.accent : colors.fg,
      }}
    />
  );
}

export function ShellRow({
  selected = false,
  unread = false,
  mention = false,
  muted = false,
  pip = true,
  onPress,
  onLongPress,
  disabled,
  accessibilityLabel,
  accessibilityHint,
  testID,
  minHeight = 44,
  style,
  children,
}: ShellRowState & {
  /** The unread waiting includes a direct @mention (coral pip). */
  mention?: boolean;
  /** Draw the unread pip (rows that carry a count badge may still want it). */
  pip?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
  minHeight?: number;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const tones = shellRowTones({ selected });
  const interactive = !!(onPress || onLongPress);
  return (
    <View style={{ opacity: shellRowOpacity({ selected, unread, muted }) }}>
      {unread && pip && !selected ? <UnreadPip mention={mention} /> : null}
      <Touchable
        onPress={onPress}
        onLongPress={onLongPress}
        disabled={disabled}
        tone={tones.tone}
        pressedTone={interactive ? tones.pressed : tones.tone}
        accessibilityRole={interactive ? "button" : undefined}
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        accessibilityState={{ selected }}
        testID={testID}
        style={[
          {
            flexDirection: "row",
            alignItems: "center",
            gap: space.md,
            minHeight,
            paddingHorizontal: space.md,
            borderRadius: radius.lg,
            borderCurve: "continuous",
          },
          style,
        ]}
      >
        {children}
      </Touchable>
    </View>
  );
}
