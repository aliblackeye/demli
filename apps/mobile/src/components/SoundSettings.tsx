import { useAppTranslation } from "@/lib/i18n";
import { ChipSelect } from "@/components/ChipSelect";
import { SettingsBlock, SettingsSection, SettingsSwitch } from "@/components/settings/SettingsSection";
import { playSound } from "@/sounds/sound-manager";
import { useSoundSettings } from "@/sounds/sound-settings";

/**
 * "Sounds" settings section — the mobile counterpart of the desktop renderer's
 * components/SoundSettings.tsx. Same three controls (master switch, volume,
 * message-notification switch) over the same persisted `useSoundSettings` store,
 * so the two clients read the same way.
 *
 * Volume stays the 3-step chip set (Low/Medium/High) it has always been, now
 * in a Koyu Masa settings card. Enabling a switch — or nudging the volume —
 * plays a sample cue so the user hears the result immediately, like desktop.
 */

const VOLUME_STEPS = { low: 0.33, medium: 0.66, high: 1 } as const;
type VolumeKey = keyof typeof VOLUME_STEPS;

function volumeKey(volume: number): VolumeKey {
  if (volume <= 0.45) return "low";
  if (volume <= 0.8) return "medium";
  return "high";
}

export function SoundSettings() {
  const { t } = useAppTranslation();
  const enabled = useSoundSettings((s) => s.enabled);
  const volume = useSoundSettings((s) => s.volume);
  const messageEnabled = useSoundSettings((s) => s.messageEnabled);
  const setEnabled = useSoundSettings((s) => s.setEnabled);
  const setVolume = useSoundSettings((s) => s.setVolume);
  const setMessageEnabled = useSoundSettings((s) => s.setMessageEnabled);

  return (
    <SettingsSection title={t("mobile:sound.section")} footer={t("mobile:sound.note")}>
      <SettingsSwitch
        title={t("mobile:sound.effects")}
        description={t("mobile:sound.effectsDesc")}
        value={enabled}
        onValueChange={() => {
          const next = !enabled;
          setEnabled(next);
          if (next) playSound("voice-join");
        }}
      />

      <SettingsBlock label={t("mobile:sound.volume")} disabled={!enabled}>
        <ChipSelect
          accessibilityLabel={t("mobile:sound.volume")}
          options={[
            { key: "low", label: t("mobile:sound.volumeLow") },
            { key: "medium", label: t("mobile:sound.volumeMedium") },
            { key: "high", label: t("mobile:sound.volumeHigh") },
          ]}
          selectedKey={volumeKey(volume)}
          onSelect={(key) => {
            setVolume(VOLUME_STEPS[key as VolumeKey]);
            playSound("voice-join");
          }}
        />
      </SettingsBlock>

      <SettingsSwitch
        title={t("mobile:sound.messageNotif")}
        description={t("mobile:sound.messageNotifDesc")}
        value={messageEnabled}
        disabled={!enabled}
        onValueChange={() => {
          const next = !messageEnabled;
          setMessageEnabled(next);
          if (next) playSound("message");
        }}
      />
    </SettingsSection>
  );
}
