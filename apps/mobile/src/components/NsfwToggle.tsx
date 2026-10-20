import { EyeOff } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { SettingsSection, SettingsSwitch } from "@/components/settings/SettingsSection";

/**
 * Text-channel age-restriction toggle (M15) — shared by the
 * create-channel and channel-settings screens. Flipping it marks the channel 18+:
 * it re-gates the channel for viewers and image attachments posted there skip the
 * NSFW upload filter. Only ever rendered for text channels (the API rejects the
 * flag on voice).
 *
 * Koyu Masa: one settings card holding the kit switch row (the whole row
 * toggles, announced as a switch with its state); the consequence is its
 * description.
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
    <SettingsSection>
      <SettingsSwitch
        icon={EyeOff}
        title={t("mobile:channelNsfw.toggleLabel")}
        description={t("mobile:channelNsfw.toggleHint")}
        value={value}
        onValueChange={onChange}
      />
    </SettingsSection>
  );
}
