import { useState } from "react";
import { Platform, View } from "react-native";
import { Text } from "./ui/Text";
import { HeadphonesConfirm } from "@/components/HeadphonesConfirm";
import { useAppTranslation } from "@/lib/i18n";
import { ChipSelect } from "@/components/ChipSelect";
import { SettingsBlock, SettingsSection, SettingsSwitch } from "@/components/settings/SettingsSection";
import { useMediaSettings } from "@/stores/media-settings";
import { useVoiceStore } from "@/stores/voice-store";
import {
  AUDIO_QUALITY_BITRATE_KBPS,
  isEchoCancellationOn,
  type AudioQuality,
  type InputMode,
  type NoiseSuppressionTier,
} from "@demli/media";
import { colors, space } from "@/theme/theme";

/**
 * "Mikrofon" settings — the mobile counterpart of the desktop MicSettingsForm.
 * Input mode, audio-processing toggles + music mode, and the audio quality tier,
 * over the persisted `useMediaSettings` store (the voice store pushes it into the
 * shared engine — the single source of truth for the livekit capture constraints).
 *
 * Sensitivity stays a 3-step chip set (Low/Medium/High) mapped onto the stored
 * threshold — the same three values the engine has been tuned and tested with.
 * Laid out as one Koyu Masa settings card (components/settings).
 */

const SENSITIVITY_STEPS = { low: 0.25, medium: 0.5, high: 0.85 } as const;
type SensitivityKey = keyof typeof SENSITIVITY_STEPS;

function sensitivityKey(value: number): SensitivityKey {
  if (value <= 0.37) return "low";
  if (value <= 0.67) return "medium";
  return "high";
}

/**
 * Yankı Engelleme. Turning it OFF is two steps: the row opens an inline warning and
 * only "Kulaklık takılı, kapat" turns it off (recording that confirmation). On the
 * loudspeaker with AEC off, the room hears itself through this phone. Music mode
 * keeps AEC on; the parent section is locked then.
 *
 * On Android the Medya audio profile can switch the phone's hardware echo canceller
 * off while this toggle still requests AEC, so the row says so instead of showing a
 * plain "on".
 */
function EchoCancellationRow({ music }: { music: boolean }) {
  const { t } = useAppTranslation();
  const audio = useMediaSettings((s) => s.audio);
  const audioProfile = useMediaSettings((s) => s.audioProfile);
  const setEchoCancellation = useMediaSettings((s) => s.setEchoCancellation);
  const [confirming, setConfirming] = useState(false);
  const on = isEchoCancellationOn(audio);
  const mediaProfile = Platform.OS === "android" && audioProfile === "media";

  const onToggle = () => {
    if (on) {
      setConfirming(true);
    } else {
      setConfirming(false);
      setEchoCancellation("on");
    }
  };

  const warningStyle = {
    color: colors.warning,
    fontSize: 12,
    lineHeight: 17,
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
  } as const;

  return (
    <View>
      <SettingsSwitch
        title={t("mobile:mic.echoCancellation")}
        value={on}
        onValueChange={onToggle}
        disabled={music}
      />
      {confirming && on && !music ? (
        <HeadphonesConfirm
          message={t("mobile:mic.echoOffWarning")}
          confirmLabel={t("mobile:mic.echoOffConfirm")}
          cancelLabel={t("mobile:mic.echoOffCancel")}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setEchoCancellation("off_headphones");
            setConfirming(false);
          }}
        />
      ) : null}
      {!on && !music ? <Text style={warningStyle}>{t("mobile:mic.echoOffActive")}</Text> : null}
      {on && mediaProfile ? (
        <Text style={warningStyle}>{t("mobile:mic.echoMediaProfile")}</Text>
      ) : null}
    </View>
  );
}

export function MicSettings() {
  const { t } = useAppTranslation();
  const audio = useMediaSettings((s) => s.audio);
  const setInputMode = useMediaSettings((s) => s.setInputMode);
  const setVadThreshold = useMediaSettings((s) => s.setVadThreshold);
  const setAutoGainControl = useMediaSettings((s) => s.setAutoGainControl);
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
    <SettingsSection title={t("mobile:mic.section")} footer={t("mobile:mic.note")}>
      <SettingsBlock
        label={t("mobile:mic.inputMode")}
        hint={audio.inputMode === "push_to_talk" ? t("mobile:mic.pushToTalkHint") : undefined}
      >
        <ChipSelect
          accessibilityLabel={t("mobile:mic.inputMode")}
          options={[
            { key: "push_to_talk", label: t("mobile:mic.inputPushToTalk") },
            { key: "voice_activity", label: t("mobile:mic.inputVoiceActivity") },
            { key: "open_mic", label: t("mobile:mic.inputOpenMic") },
          ]}
          selectedKey={audio.inputMode}
          onSelect={onSelectInputMode}
        />
      </SettingsBlock>

      {audio.inputMode === "voice_activity" ? (
        <SettingsBlock label={t("mobile:mic.sensitivity")}>
          <ChipSelect
            accessibilityLabel={t("mobile:mic.sensitivity")}
            options={[
              { key: "low", label: t("mobile:mic.sensitivityLow") },
              { key: "medium", label: t("mobile:mic.sensitivityMedium") },
              { key: "high", label: t("mobile:mic.sensitivityHigh") },
            ]}
            selectedKey={sensitivityKey(audio.vadThreshold)}
            onSelect={(key) => setVadThreshold(SENSITIVITY_STEPS[key as SensitivityKey])}
          />
        </SettingsBlock>
      ) : null}

      <SettingsSwitch
        title={t("mobile:mic.musicMode")}
        description={t("mobile:mic.musicModeDesc")}
        value={music}
        onValueChange={() => setMusicMode(!music)}
      />

      {/* Music mode owns these three while it is on (noise off, AGC off, AEC
          kept): shown dimmed and inert rather than hidden, so the reason for
          their state is visible right above them. */}
      <SettingsBlock label={t("mobile:mic.noiseSuppression")} disabled={music}>
        <ChipSelect
          accessibilityLabel={t("mobile:mic.noiseSuppression")}
          // Mobile offers only Standart / Kapalı — the "Yüksek" (RNNoise) tier is a
          // desktop-only worklet for now (no dead button, §35).
          options={[
            { key: "standard", label: t("mobile:mic.noiseStandard") },
            { key: "off", label: t("mobile:mic.noiseOff") },
          ]}
          selectedKey={music ? "off" : audio.noiseSuppression}
          onSelect={(key) => setNoiseSuppression(key as NoiseSuppressionTier)}
        />
      </SettingsBlock>

      <EchoCancellationRow music={music} />

      <SettingsSwitch
        title={t("mobile:mic.autoGainControl")}
        value={!music && audio.processing.autoGainControl}
        onValueChange={() => setAutoGainControl(!audio.processing.autoGainControl)}
        disabled={music}
      />

      <SettingsBlock label={t("mobile:mic.quality")} disabled={music}>
        <ChipSelect
          accessibilityLabel={t("mobile:mic.quality")}
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
      </SettingsBlock>
    </SettingsSection>
  );
}
