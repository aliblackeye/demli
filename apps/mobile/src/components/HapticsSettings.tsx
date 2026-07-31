import { View } from "react-native";
import { Text } from "./ui/Text";
import { useAppTranslation } from "@/lib/i18n";
import { ToggleRow } from "@/components/ToggleRow";
import { haptics } from "@/lib/haptics";
import { useHapticsSettings } from "@/stores/haptics-settings";
import { colors, space, typography } from "@/theme/theme";

/**
 * "Haptics" settings section — a single master switch over the persisted
 * `useHapticsSettings` store, following the same shape as `SoundSettings`.
 * Enabling fires a sample tap so the user feels the result immediately (the
 * haptic counterpart of SoundSettings' sample cue).
 */
function SectionLabel({ children }: { children: string }) {
  return (
    <Text
      style={{
        color: colors.fgFaint,
        fontSize: typography.size["2xs"],
        fontWeight: "700",
        letterSpacing: 0.6,
        textTransform: "uppercase",
        paddingHorizontal: space.lg,
        paddingTop: space.lg,
        paddingBottom: space.xs,
      }}
    >
      {children}
    </Text>
  );
}

export function HapticsSettings() {
  const { t } = useAppTranslation();
  const enabled = useHapticsSettings((s) => s.enabled);
  const setEnabled = useHapticsSettings((s) => s.setEnabled);

  return (
    <View>
      <SectionLabel>{t("mobile:haptics.section")}</SectionLabel>
      <View style={{ paddingHorizontal: space.md }}>
        <ToggleRow
          label={t("mobile:haptics.enable")}
          description={t("mobile:haptics.enableDesc")}
          checked={enabled}
          onToggle={() => {
            const next = !enabled;
            setEnabled(next);
            // Sample tap on enable so the effect is felt at once (the store is
            // updated first, so haptics.light() sees enabled=true).
            if (next) haptics.light();
          }}
        />
      </View>
    </View>
  );
}
