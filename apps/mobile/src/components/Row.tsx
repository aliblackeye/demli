import type { ReactNode } from "react";
import { View } from "react-native";
import { ChevronRight } from "lucide-react-native";
import { colors, radius, space } from "../theme/theme";
import { Text } from "./ui/Text";
import { Touchable } from "./ui/Touchable";

/**
 * Tappable list row (group, channel, settings item) on the surface tone — the
 * Koyu Masa list cell. Pressing is a TONE change only (surface → raised, in on
 * the 120ms step and out on the 200ms one); a row never lifts, scales or
 * bounces (founder rule). `leading` is typically an icon box or an avatar; a
 * chevron is shown for navigational rows.
 */
export function Row({
  title,
  subtitle,
  leading,
  trailing,
  onPress,
  onLongPress,
  disabled = false,
  showChevron = true,
  accent = false,
  dimmed = false,
  selected = false,
  accessibilityLabel,
  accessibilityHint,
}: {
  title: string;
  subtitle?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  onPress?: () => void;
  /** Long-press affordance (e.g. the notification-mute sheet). */
  onLongPress?: () => void;
  disabled?: boolean;
  showChevron?: boolean;
  /** Coral title — a "create / add" row at the end of a list. */
  accent?: boolean;
  /** Muted-target styling: fade the row without disabling it. */
  dimmed?: boolean;
  /** The current item in a list (the open channel): coral wash + coral title. */
  selected?: boolean;
  /**
   * Leave unset to let TalkBack read the row's own text (title, subtitle AND any
   * trailing badge) — an explicit label replaces all of it.
   */
  accessibilityLabel?: string;
  accessibilityHint?: string;
}) {
  const interactive = !!(onPress || onLongPress);
  const tone = selected ? colors.accentSurface : colors.surface;
  return (
    <Touchable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      // A display-only row (no handler) must not react to a touch, and must not
      // be announced as "disabled" either — it simply is not a control.
      tone={tone}
      pressedTone={interactive ? (selected ? colors.accentSurfaceStrong : colors.surfaceRaised) : tone}
      accessibilityRole={interactive ? "button" : undefined}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ selected }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        minHeight: 52,
        paddingHorizontal: space.lg,
        paddingVertical: space.md,
        borderRadius: radius.lg,
        borderCurve: "continuous",
        opacity: dimmed && !disabled ? 0.55 : undefined,
      }}
    >
      {leading}
      <View style={{ flex: 1, gap: 2 }}>
        <Text
          numberOfLines={2}
          style={{
            color: selected || accent ? colors.accent : colors.fg,
            fontSize: 15,
            lineHeight: 20,
            fontWeight: "600",
          }}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text style={{ color: colors.fgMuted, fontSize: 13, lineHeight: 18 }} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing}
      {showChevron && onPress ? <ChevronRight size={18} color={colors.fgSubtle} /> : null}
    </Touchable>
  );
}
