/**
 * The app's bottom-sheet action menu — mobile's answer to a desktop right-click
 * context menu / row hover affordance.
 *
 * Built on a plain RN `Modal` rather than a native sheet library on purpose:
 * everything here has to stay OTA-updatable (CLAUDE.md §32), so no new native
 * module may be introduced for chrome.
 *
 * This is the extraction of an idiom the app had already converged on by hand in
 * `ServerActionsSheet` and `NotificationMuteSheet` — same scrim, same radii, same
 * safe-area padding, and a byte-identical private `ActionRow` in both. One copy
 * now, so a menu row looks the same wherever it opens.
 *
 * Two things the card handles for every caller, because getting them wrong is
 * invisible until a particular device shows it:
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
import { Modal, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppTranslation } from "@/lib/i18n";
import { useKeyboardHeight } from "@/lib/use-keyboard-height";
import { colors, radius, space } from "@/theme/theme";
import { Text } from "./Text";

export function ActionSheet({
  visible,
  title,
  onClose,
  children,
}: {
  visible: boolean;
  /** Which object the menu acts on — a server name, a person, a channel. */
  title?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();
  const keyboardHeight = useKeyboardHeight();
  const { height: windowHeight } = useWindowDimensions();

  // Leave the top of the screen visible so the sheet still reads as a sheet —
  // and so the scrim it is dismissed by stays reachable.
  const maxCardHeight = Math.max(240, windowHeight - keyboardHeight - insets.top - space.xxl);
  // With the keyboard up, the card sits on the IME rather than on the nav bar,
  // so adding the bottom inset too would leave a nav-bar-sized gap under it.
  const bottomPad = keyboardHeight > 0 ? space.md : space.md + insets.bottom;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      {/* Tapping the scrim dismisses; the inner Pressable swallows taps so a
          press inside the card does not fall through to it. */}
      <Pressable
        onPress={onClose}
        accessibilityLabel={t("common:buttons.close")}
        style={{
          flex: 1,
          backgroundColor: "rgba(0,0,0,0.55)",
          justifyContent: "flex-end",
          paddingBottom: keyboardHeight,
        }}
      >
        <Pressable
          onPress={() => {}}
          style={{
            maxHeight: maxCardHeight,
            backgroundColor: colors.surface,
            borderTopLeftRadius: radius.lg,
            borderTopRightRadius: radius.lg,
            borderCurve: "continuous",
            borderTopWidth: 1,
            borderColor: colors.stroke,
            paddingTop: space.md,
            paddingHorizontal: space.md,
          }}
        >
          {title ? (
            <Text
              numberOfLines={1}
              style={{
                color: colors.fgMuted,
                fontSize: 13,
                fontWeight: "600",
                paddingHorizontal: space.sm,
                paddingBottom: space.xs,
              }}
            >
              {title}
            </Text>
          ) : null}
          <ScrollView
            // A short menu must not stretch to the cap, so the scroll view sizes
            // to its content and only starts scrolling once it exceeds it.
            bounces={false}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ gap: space.xs, paddingBottom: bottomPad }}
          >
            {children}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
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
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={hint ? `${label}. ${hint}` : label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => ({
        flexDirection: "row",
        // Two-line rows keep the icon aligned with the LABEL, not with the
        // block's centre, so a row with a hint does not look misaligned next to
        // a single-line one.
        alignItems: hint ? "flex-start" : "center",
        gap: space.md,
        paddingVertical: space.md,
        paddingHorizontal: space.sm,
        borderRadius: radius.md,
        borderCurve: "continuous",
        backgroundColor: pressed ? colors.surfaceRaised : "transparent",
        opacity: disabled ? 0.5 : 1,
      })}
    >
      {icon}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: labelColor ?? colors.fg, fontSize: 15, fontWeight: "600" }}>
          {label}
        </Text>
        {hint ? (
          <Text style={{ color: colors.fgFaint, fontSize: 12, fontWeight: "500" }}>{hint}</Text>
        ) : null}
      </View>
      {trailing}
    </Pressable>
  );
}

/** Hairline divider separating a destructive row from the rest of a menu. */
export function ActionDivider() {
  return <View style={{ height: 1, backgroundColor: colors.stroke, marginVertical: space.xs }} />;
}
