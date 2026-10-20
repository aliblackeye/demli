import { View } from "react-native";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import { Headphones } from "lucide-react-native";
import { Text } from "./ui/Text";
import { Button } from "./ui/Button";
import { withAlpha } from "./ui/kit-math";
import { colors, motion, radius, space } from "@/theme/theme";

/**
 * The inline "only with headphones" step in front of every setting that can let
 * the speaker's sound back into the mic (Yankı Engelleme off, the Android Medya
 * audio profile). The setting changes only from `onConfirm`.
 *
 * Koyu Masa: a borderless warning-washed panel (the gold 12% wash, the glyph
 * in gold), the consequence in plain text, "keep it" as the quiet ghost action
 * and the risky one in the pink danger wash — never a solid fill. It fades in
 * where the switch is, so the decision stays next to the thing it changes.
 */
export function HeadphonesConfirm({
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: {
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Animated.View
      entering={FadeIn.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(motion.duration.instant).reduceMotion(ReduceMotion.System)}
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
      style={{
        marginHorizontal: space.md,
        marginBottom: space.md,
        padding: space.md,
        gap: space.md,
        borderRadius: radius.lg,
        borderCurve: "continuous",
        backgroundColor: withAlpha(colors.warning, 0.12),
      }}
    >
      <View style={{ flexDirection: "row", gap: space.sm }}>
        <Headphones size={18} color={colors.warning} strokeWidth={2} style={{ marginTop: 1 }} />
        <Text style={{ flex: 1, color: colors.fg, fontSize: 13, lineHeight: 19 }}>{message}</Text>
      </View>
      <View style={{ flexDirection: "row", gap: space.sm, justifyContent: "flex-end", flexWrap: "wrap" }}>
        <Button variant="ghost" size="sm" label={cancelLabel} onPress={onCancel} />
        <Button variant="danger" size="sm" label={confirmLabel} onPress={onConfirm} haptic="medium" />
      </View>
    </Animated.View>
  );
}
