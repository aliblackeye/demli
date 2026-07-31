import { View } from "react-native";
import { Text } from "./ui/Text";
import { useAppTranslation } from "@/lib/i18n";
import { ChipSelect } from "@/components/ChipSelect";
import { ToggleRow } from "@/components/ToggleRow";
import { useMediaSettings } from "@/stores/media-settings";
import { useVoiceStore } from "@/stores/voice-store";
import {
  AUDIO_QUALITY_BITRATE_KBPS,
  type AudioQuality,
  type InputMode,
  type NoiseSuppressionTier,
} from "@demli/media";
import { colors, space, typography } from "@/theme/theme";

/**
 * "Mikrofon" settings — the mobile counterpart of the desktop MicSettingsForm.
 * Input mode, audio-processing toggles + music mode, and the audio quality tier,
 * over the persisted `useMediaSettings` store (the voice store pushes it into the
 * shared engine — the single source of truth for the livekit capture constraints).
 *
 * Sensitivity is a 3-step ChipSelect (Low/Medium/High) rather than a slider:
 * React Native ships no core slider and a community one is a NEW native module,
 * which would break OTA delivery — same reasoning as SoundSettings' volume.
 */

const SENSITIVITY_STEPS = { low: 0.25, medium: 0.5, high: 0.85 } as const;
type SensitivityKey = keyof typeof SENSITIVITY_STEPS;

function sensitivityKey(value: number): SensitivityKey {
  if (value <= 0.37) return "low";
  if (value <= 0.67) return "medium";
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

export function MicSettings() {
  const { t } = useAppTranslation();
  const audio = useMediaSettings((s) => s.audio);
  const setInputMode = useMediaSettings((s) => s.setInputMode);
  const setVadThreshold = useMediaSettings((s) => s.setVadThreshold);
  const setProcessing = useMediaSettings((s) => s.setProcessing);
  const setNoiseSuppression = useMediaSettings((s) => s.setNoiseSuppression);
  const setMusicMode = useMediaSettings((s) => s.setMusicMode);
  const setAudioQuality = useMediaSettings((s) => s.setAudioQuality);

  const status = useVoiceStore((s) => s.status);
  const setMicActive = useVoiceStore((s) => s.setMicActive);
  const isActive = status === "connected" || status === "joining" || status === "reconnecting";

  const music = audio.musicMode;

  const onSelectInputMode = (key: string) => {
    const mode = key as InputMode;
    setInputMode(mode);
    // Reflect on the live mic: PTT holds muted; the other modes go live.
    if (isActive) setMicActive(mode !== "push_to_talk");
  };

  const effectiveQuality: AudioQuality = music ? "music" : audio.quality;

  return (
    <View>
      <SectionLabel>{t("mobile:mic.section")}</SectionLabel>

      <View style={{ paddingHorizontal: space.lg, gap: space.sm }}>
        <Text style={{ color: colors.fg, fontSize: 14, fontWeight: "600" }}>
          {t("mobile:mic.inputMode")}
        </Text>
        <ChipSelect
          options={[
            { key: "push_to_talk", label: t("mobile:mic.inputPushToTalk") },
            { key: "voice_activity", label: t("mobile:mic.inputVoiceActivity") },
            { key: "open_mic", label: t("mobile:mic.inputOpenMic") },
          ]}
          selectedKey={audio.inputMode}
          onSelect={onSelectInputMode}
        />
        {audio.inputMode === "push_to_talk" ? (
          <Text style={{ color: colors.fgFaint, fontSize: 12 }}>
            {t("mobile:mic.pushToTalkHint")}
          </Text>
        ) : null}
      </View>

      {audio.inputMode === "voice_activity" ? (
        <View style={{ paddingHorizontal: space.lg, paddingTop: space.md, gap: space.sm }}>
          <Text style={{ color: colors.fg, fontSize: 14, fontWeight: "600" }}>
            {t("mobile:mic.sensitivity")}
          </Text>
          <ChipSelect
            options={[
              { key: "low", label: t("mobile:mic.sensitivityLow") },
              { key: "medium", label: t("mobile:mic.sensitivityMedium") },
              { key: "high", label: t("mobile:mic.sensitivityHigh") },
            ]}
            selectedKey={sensitivityKey(audio.vadThreshold)}
            onSelect={(key) => setVadThreshold(SENSITIVITY_STEPS[key as SensitivityKey])}
          />
        </View>
      ) : null}

      <View style={{ paddingHorizontal: space.md, paddingTop: space.sm, gap: space.xs }}>
        <ToggleRow
          label={t("mobile:mic.musicMode")}
          description={t("mobile:mic.musicModeDesc")}
          checked={music}
          onToggle={() => setMusicMode(!music)}
        />
        <View style={{ opacity: music ? 0.5 : 1 }} pointerEvents={music ? "none" : "auto"}>
          <View style={{ paddingHorizontal: space.sm, paddingTop: space.sm, gap: space.xs }}>
            <Text style={{ color: colors.fg, fontSize: 14, fontWeight: "600" }}>
              {t("mobile:mic.noiseSuppression")}
            </Text>
            <ChipSelect
              // Mobile offers only Standart / Kapalı — the "Yüksek" (RNNoise) tier is a
              // desktop-only worklet for now (no dead button, §35).
              options={[
                { key: "standard", label: t("mobile:mic.noiseStandard") },
                { key: "off", label: t("mobile:mic.noiseOff") },
              ]}
              selectedKey={music ? "off" : audio.noiseSuppression}
              onSelect={(key) => setNoiseSuppression(key as NoiseSuppressionTier)}
            />
          </View>
          <ToggleRow
            label={t("mobile:mic.echoCancellation")}
            checked={music || audio.processing.echoCancellation}
            onToggle={() => setProcessing({ echoCancellation: !audio.processing.echoCancellation })}
          />
          <ToggleRow
            label={t("mobile:mic.autoGainControl")}
            checked={!music && audio.processing.autoGainControl}
            onToggle={() => setProcessing({ autoGainControl: !audio.processing.autoGainControl })}
          />
        </View>
      </View>

      <View style={{ paddingHorizontal: space.lg, paddingTop: space.md, gap: space.sm }}>
        <Text style={{ color: colors.fg, fontSize: 14, fontWeight: "600" }}>
          {t("mobile:mic.quality")}
        </Text>
        <View style={{ opacity: music ? 0.5 : 1 }} pointerEvents={music ? "none" : "auto"}>
          <ChipSelect
            options={[
              {
                key: "standard",
                label: `${t("mobile:mic.qualityStandard")} · ${AUDIO_QUALITY_BITRATE_KBPS.standard}k`,
              },
              {
                key: "high",
                label: `${t("mobile:mic.qualityHigh")} · ${AUDIO_QUALITY_BITRATE_KBPS.high}k`,
              },
              {
                key: "music",
                label: `${t("mobile:mic.qualityMusic")} · ${AUDIO_QUALITY_BITRATE_KBPS.music}k`,
              },
            ]}
            selectedKey={effectiveQuality}
            onSelect={(key) => setAudioQuality(key as AudioQuality)}
          />
        </View>
      </View>

      <Text
        style={{
          color: colors.fgFaint,
          fontSize: 12,
          paddingHorizontal: space.lg,
          paddingTop: space.sm,
        }}
      >
        {t("mobile:mic.note")}
      </Text>
    </View>
  );
}
