import { useAppTranslation } from "@/lib/i18n";
import { SettingsSection, SettingsSwitch } from "@/components/settings/SettingsSection";
import { haptics } from "@/lib/haptics";
import { useHapticsSettings } from "@/stores/haptics-settings";

/**
 * "Haptics" settings section — a single master switch over the persisted
 * `useHapticsSettings` store, following the same shape as `SoundSettings`.
 * Enabling fires a sample tap so the user feels the result immediately (the
 * haptic counterpart of SoundSettings' sample cue).
 *
 * Laid out as a Koyu Masa settings card with one switch row.
 */
export function HapticsSettings() {
  const { t } = useAppTranslation();
  const enabled = useHapticsSettings((s) => s.enabled);
  const setEnabled = useHapticsSettings((s) => s.setEnabled);

  return (
    <SettingsSection title={t("mobile:haptics.section")}>
      <SettingsSwitch
        title={t("mobile:haptics.enable")}
        description={t("mobile:haptics.enableDesc")}
        value={enabled}
        onValueChange={() => {
          const next = !enabled;
          setEnabled(next);
          // Sample tap on enable so the effect is felt at once (the store is
          // updated first, so haptics.light() sees enabled=true).
          if (next) haptics.light();
        }}
      />
    </SettingsSection>
  );
}
