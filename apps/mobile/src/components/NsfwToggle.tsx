import { Switch, View } from "react-native";
import { Text } from "./ui/Text";
import { EyeOff } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { colors, radius, space } from "@/theme/theme";

/**
 * Text-channel age-restriction toggle (M15) — shared by the
 * create-channel and channel-settings screens. Flipping it marks the channel 18+:
 * it re-gates the channel for viewers and image attachments posted there skip the
 * NSFW upload filter. Only ever rendered for text channels (the API rejects the
 * flag on voice).
 */
export function NsfwToggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  const { t } = useAppTranslation();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        padding: space.md,
        borderRadius: radius.md,
        borderCurve: "continuous",
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: colors.stroke,
      }}
    >
      <EyeOff size={18} color={colors.fgMuted} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: colors.fg, fontSize: 14, fontWeight: "600" }}>
          {t("mobile:channelNsfw.toggleLabel")}
        </Text>
        <Text style={{ color: colors.fgFaint, fontSize: 12, lineHeight: 16 }}>
          {t("mobile:channelNsfw.toggleHint")}
        </Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: colors.strokeStrong, true: colors.accent }}
        thumbColor={colors.fg}
        accessibilityLabel={t("mobile:channelNsfw.toggleLabel")}
      />
    </View>
  );
}
