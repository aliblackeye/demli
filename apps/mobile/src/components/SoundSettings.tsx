import { View } from "react-native";
import { Text } from "./ui/Text";
import { useAppTranslation } from "@/lib/i18n";
import { ChipSelect } from "@/components/ChipSelect";
import { ToggleRow } from "@/components/ToggleRow";
import { playSound } from "@/sounds/sound-manager";
import { useSoundSettings } from "@/sounds/sound-settings";
import { colors, space, typography } from "@/theme/theme";

/**
 * "Sounds" settings section — the mobile counterpart of the desktop renderer's
 * components/SoundSettings.tsx. Same three controls (master switch, volume,
 * message-notification switch) over the same persisted `useSoundSettings` store,
 * so the two clients read the same way.
 *
 * Volume is a 3-step ChipSelect (Low/Medium/High) rather than desktop's
 * continuous slider: React Native core ships no slider and a community slider is
 * a NEW native module, which would break OTA delivery (runtimeVersion is
 * pinned). Enabling a switch — or nudging the volume — plays a sample cue so the
 * user hears the result immediately, exactly like desktop.
 */

const VOLUME_STEPS = { low: 0.33, medium: 0.66, high: 1 } as const;
type VolumeKey = keyof typeof VOLUME_STEPS;

function volumeKey(volume: number): VolumeKey {
  if (volume <= 0.45) return "low";
  if (volume <= 0.8) return "medium";
  return "high";
}

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

export function SoundSettings() {
  const { t } = useAppTranslation();
  const enabled = useSoundSettings((s) => s.enabled);
  const volume = useSoundSettings((s) => s.volume);
  const messageEnabled = useSoundSettings((s) => s.messageEnabled);
  const setEnabled = useSoundSettings((s) => s.setEnabled);
  const setVolume = useSoundSettings((s) => s.setVolume);
  const setMessageEnabled = useSoundSettings((s) => s.setMessageEnabled);

  return (
    <View>
      <SectionLabel>{t("mobile:sound.section")}</SectionLabel>
      <View style={{ paddingHorizontal: space.md, gap: space.xs }}>
        <ToggleRow
          label={t("mobile:sound.effects")}
          description={t("mobile:sound.effectsDesc")}
          checked={enabled}
          onToggle={() => {
            const next = !enabled;
            setEnabled(next);
            if (next) playSound("voice-join");
          }}
        />

        <View
          style={{
            paddingHorizontal: space.md,
            paddingTop: space.sm,
            gap: space.sm,
            opacity: enabled ? 1 : 0.5,
          }}
          pointerEvents={enabled ? "auto" : "none"}
        >
          <Text style={{ color: colors.fg, fontSize: 14, fontWeight: "600" }}>
            {t("mobile:sound.volume")}
          </Text>
          <ChipSelect
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
        </View>

        <ToggleRow
          label={t("mobile:sound.messageNotif")}
          description={t("mobile:sound.messageNotifDesc")}
          checked={messageEnabled}
          disabled={!enabled}
          onToggle={() => {
            const next = !messageEnabled;
            setMessageEnabled(next);
            if (next) playSound("message");
          }}
        />
      </View>

      <Text
        style={{
          color: colors.fgFaint,
          fontSize: 12,
          paddingHorizontal: space.lg,
          paddingTop: space.sm,
        }}
      >
        {t("mobile:sound.note")}
      </Text>
    </View>
  );
}
