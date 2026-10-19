import { View } from "react-native";
import { Text } from "./ui/Text";
import { Button } from "@/components/Button";
import { colors, radius, space } from "@/theme/theme";

/**
 * The inline "only with headphones" step in front of every setting that can let
 * the speaker's sound back into the mic (Yankı Engelleme off, the Android Medya
 * audio profile). The setting changes only from `onConfirm`.
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
    <View
      accessibilityRole="alert"
      style={{
        marginHorizontal: space.md,
        marginBottom: space.sm,
        padding: space.md,
        gap: space.sm,
        borderRadius: radius.md,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.warning,
        backgroundColor: colors.surfaceRaised,
      }}
    >
      <Text style={{ color: colors.fg, fontSize: 13, lineHeight: 18 }}>{message}</Text>
      <View style={{ flexDirection: "row", gap: space.sm, justifyContent: "flex-end" }}>
        <Button variant="ghost" label={cancelLabel} onPress={onCancel} />
        <Button variant="danger" label={confirmLabel} onPress={onConfirm} />
      </View>
    </View>
  );
}
