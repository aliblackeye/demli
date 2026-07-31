import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { Text } from "./ui/Text";
import { ChevronRight } from "lucide-react-native";
import { colors, radius, space } from "../theme/theme";

/**
 * Tappable list row (group, channel, settings item) on the raised surface.
 * `leading` is typically an icon or avatar; a chevron is shown unless disabled.
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
  accent?: boolean;
  /** Muted-target styling: fade the row without disabling it. */
  dimmed?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled || (!onPress && !onLongPress)}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        paddingHorizontal: space.lg,
        paddingVertical: space.md,
        borderRadius: radius.md,
        borderCurve: "continuous",
        backgroundColor: pressed ? colors.surfaceRaised : colors.surface,
        opacity: disabled ? 0.5 : dimmed ? 0.55 : 1,
      })}
    >
      {leading}
      <View style={{ flex: 1, gap: 2 }}>
        <Text
          style={{
            color: accent ? colors.accent : colors.fg,
            fontSize: 15,
            fontWeight: "600",
          }}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text style={{ color: colors.fgMuted, fontSize: 13 }} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing}
      {showChevron && onPress ? <ChevronRight size={18} color={colors.fgFaint} /> : null}
    </Pressable>
  );
}
