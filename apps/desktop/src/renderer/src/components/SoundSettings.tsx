import { useId } from "react";
import { BellRing, Info, SlidersHorizontal, Volume2 } from "lucide-react";
import { Slider } from "@demli/ui";
import { useAppTranslation } from "../lib/i18n";
import { playSound } from "../sounds/sound-manager";
import { useSoundSettings } from "../sounds/sound-settings";
import { SettingRow, SettingsBlock, SettingsGroup, SettingsNote } from "./settings-kit";
import { Toggle } from "./Toggle";

/**
 * "Sesler" settings section — UI sound effect preferences (master switch,
 * volume, message-notification switch). State lives in the persisted
 * `useSoundSettings` store; this component is a thin view over it.
 * Enabling a switch (and releasing the volume slider) plays a sample cue so
 * the user hears the result immediately.
 */
export function SoundSettings(): JSX.Element {
  const { t } = useAppTranslation();
  const enabled = useSoundSettings((s) => s.enabled);
  const volume = useSoundSettings((s) => s.volume);
  const messageEnabled = useSoundSettings((s) => s.messageEnabled);
  const setEnabled = useSoundSettings((s) => s.setEnabled);
  const setVolume = useSoundSettings((s) => s.setVolume);
  const setMessageEnabled = useSoundSettings((s) => s.setMessageEnabled);
  const volumeLabelId = useId();

  return (
    <div className="space-y-8">
      <SettingsGroup title={t("desktop:sound.heading")}>
        <SettingRow
          icon={Volume2}
          title={t("desktop:sound.effects")}
          description={t("desktop:sound.effectsDesc")}
        >
          <Toggle
            checked={enabled}
            onChange={(next) => {
              setEnabled(next);
              if (next) playSound("voice-join");
            }}
            label={t("desktop:sound.effects")}
          />
        </SettingRow>

        <div>
          <SettingRow
            icon={SlidersHorizontal}
            title={<span id={volumeLabelId}>{t("desktop:sound.volume")}</span>}
            disabled={!enabled}
          />
          <SettingsBlock className="pt-0 sm:pl-[3.75rem]">
            <Slider
              aria-labelledby={volumeLabelId}
              min={0}
              max={100}
              step={5}
              disabled={!enabled}
              value={Math.round(volume * 100)}
              onValueChange={(value) => setVolume(value / 100)}
              // Sample on release (not on every drag tick) so adjusting
              // doesn't machine-gun the cue.
              onValueCommit={() => playSound("voice-join")}
              formatValue={(value) => `${value}%`}
              showValue
            />
          </SettingsBlock>
        </div>

        <SettingRow
          icon={BellRing}
          title={t("desktop:sound.messageNotif")}
          description={t("desktop:sound.messageNotifDesc")}
          disabled={!enabled}
        >
          <Toggle
            checked={messageEnabled}
            disabled={!enabled}
            onChange={(next) => {
              setMessageEnabled(next);
              if (next) playSound("message");
            }}
            label={t("desktop:sound.messageNotif")}
          />
        </SettingRow>
      </SettingsGroup>
      <SettingsNote icon={Info}>{t("desktop:sound.note")}</SettingsNote>
    </div>
  );
}
