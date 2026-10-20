/**
 * The app's bottom-sheet action menu — mobile's answer to a desktop right-click
 * context menu / row hover affordance.
 *
 * Same API as before (`visible`, `title`, `onClose`, children of `ActionRow` /
 * `ActionDivider`), now drawn by the kit's draggable {@link Sheet}: spring
 * open, drag or flick down to dismiss, scrim derived from the card's travel,
 * the Android back button, reduced motion honoured. Every call site keeps
 * working untouched.
 *
 * What the sheet still guarantees for every caller, because getting it wrong
 * is invisible until a particular device shows it:
 *
 *  - The body SCROLLS under a max height. The full user menu for a moderator is
 *    seventeen rows; without a cap it runs off the bottom of a short screen (or
 *    any screen in landscape) and the destructive entries — deliberately last —
 *    are exactly the ones that disappear.
 *  - The card lifts above the software keyboard by the REAL IME height rather
 *    than through KeyboardAvoidingView, which receives no keyboard inset under
 *    Android's edge-to-edge mode (see lib/use-keyboard-height, written for that
 *    founder bug on the composer). A sheet whose content is a text field is
 *    otherwise buried the moment it focuses.
 */

import type { ReactNode } from "react";
import { View } from "react-native";
import { colors, radius, space } from "@/theme/theme";
import { Sheet } from "./Sheet";
import { Text } from "./Text";
import { Touchable } from "./Touchable";

export function ActionSheet({
  visible,
  title,
  onClose,
  onClosed,
  dismissible = true,
  children,
}: {
  visible: boolean;
  /** Which object the menu acts on — a server name, a person, a channel. */
  title?: string;
  /**
   * The user asked to close (drag, flick, scrim, back). A caller may decline by
   * keeping `visible` true (an editor stepping back to its menu): the card then
   * springs back instead of leaving.
   */
  onClose: () => void;
  /** After the exit motion finished. */
  onClosed?: () => void;
  /**
   * `false` while a request the sheet started is running: drag, scrim and back
   * are refused so the outcome cannot be orphaned. Defaults to true.
   */
  dismissible?: boolean;
  children: ReactNode;
}) {
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      onClosed={onClosed}
      dismissible={dismissible}
      accessibilityLabel={title}
      contentPadding={space.sm}
    >
      {title ? (
        <Text
          numberOfLines={1}
          accessibilityRole="header"
          style={{
            color: colors.fgMuted,
            fontSize: 13,
            lineHeight: 18,
            fontWeight: "600",
            paddingHorizontal: space.md,
            paddingBottom: space.xs,
          }}
        >
          {title}
        </Text>
      ) : null}
      {children}
    </Sheet>
  );
}

/** One tappable row inside an {@link ActionSheet}. */
export function ActionRow({
  icon,
  label,
  hint,
  labelColor,
  trailing,
  disabled = false,
  onPress,
}: {
  icon: ReactNode;
  label: string;
  /**
   * Faint second line stating a rule where the action is taken rather than three
   * screens away — "only visible to you" under a note, "silences notifications,
   * does not block" under ignore. Read out with the label, so a screen reader
   * gets the caveat too.
   */
  hint?: string;
  /** Danger rows pass `colors.danger`; everything else takes the default. */
  labelColor?: string;
  /** Small trailing affordance (a chip, a check) aligned to the row's end. */
  trailing?: ReactNode;
  disabled?: boolean;
  onPress: () => void;
}) {
  const danger = labelColor === colors.danger;
  return (
    <Touchable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={hint ? `${label}. ${hint}` : label}
      // Press = tone only: the white wash on a neutral row, the pink wash on a
      // destructive one, so the feedback carries the row's meaning.
      pressedTone={danger ? colors.dangerSurface : colors.wash}
      style={{
        flexDirection: "row",
        // Two-line rows keep the icon aligned with the LABEL, not with the
        // block's centre, so a row with a hint does not look misaligned next to
        // a single-line one.
        alignItems: hint ? "flex-start" : "center",
        gap: space.md,
        minHeight: 48,
        paddingVertical: space.md,
        paddingHorizontal: space.md,
        borderRadius: radius.lg,
        borderCurve: "continuous",
      }}
    >
      {icon}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: labelColor ?? colors.fg, fontSize: 15, lineHeight: 20, fontWeight: "500" }}>
          {label}
        </Text>
        {hint ? (
          <Text style={{ color: colors.fgFaint, fontSize: 12, lineHeight: 16, fontWeight: "500" }}>{hint}</Text>
        ) : null}
      </View>
      {trailing}
    </Touchable>
  );
}

/** Hairline divider separating a destructive row from the rest of a menu. */
export function ActionDivider() {
  return (
    <View
      importantForAccessibility="no"
      style={{ height: 1, backgroundColor: colors.stroke, marginVertical: space.xs, marginHorizontal: space.md }}
    />
  );
}
