import { useEffect, useId, useRef, useState } from "react";
import { m } from "framer-motion";
import {
  Gauge,
  Headphones,
  Keyboard,
  Mic,
  Music,
  Sparkles,
  TriangleAlert,
  Waves,
} from "lucide-react";
import { Button, RadioCard, RadioGroup, RadioItem, Slider, cn } from "@demli/ui";
import { springs } from "@demli/app-ui";
import {
  AUDIO_QUALITY_BITRATE_KBPS,
  INPUT_MODES,
  isEchoCancellationOn,
  NOISE_SUPPRESSION_TIERS,
  type AudioQuality,
  type InputMode,
  type NoiseSuppressionTier,
} from "@demli/media";
import { useAppTranslation } from "../lib/i18n";
import { useMediaSettings } from "../stores/media-settings";
import { useVoiceStore } from "../stores/voice-store";
import { formatPttKey } from "../lib/ptt";
import { SettingRow, SettingsBlock, SettingsGroup, SettingsNote } from "./settings-kit";
import { Toggle } from "./Toggle";

const INPUT_MODE_LABEL = {
  push_to_talk: "desktop:micSettings.inputPushToTalk",
  voice_activity: "desktop:micSettings.inputVoiceActivity",
  open_mic: "desktop:micSettings.inputOpenMic",
} as const satisfies Record<InputMode, string>;
const INPUT_MODE_DESC = {
  push_to_talk: "desktop:micSettings.inputPushToTalkDesc",
  voice_activity: "desktop:micSettings.inputVoiceActivityDesc",
  open_mic: "desktop:micSettings.inputOpenMicDesc",
} as const satisfies Record<InputMode, string>;

const AUDIO_QUALITIES_ORDERED: AudioQuality[] = ["standard", "high", "music"];
const AUDIO_QUALITY_LABEL = {
  standard: "desktop:micSettings.qualityStandard",
  high: "desktop:micSettings.qualityHigh",
  music: "desktop:micSettings.qualityMusic",
} as const satisfies Record<AudioQuality, string>;

const NOISE_TIER_LABEL = {
  high: "desktop:micSettings.noiseHigh",
  standard: "desktop:micSettings.noiseStandard",
  off: "desktop:micSettings.noiseOff",
} as const satisfies Record<NoiseSuppressionTier, string>;
const NOISE_TIER_DESC = {
  high: "desktop:micSettings.noiseHighDesc",
  standard: "desktop:micSettings.noiseStandardDesc",
  off: "desktop:micSettings.noiseOffDesc",
} as const satisfies Record<NoiseSuppressionTier, string>;

/** Capture the next KeyboardEvent.code to use as the push-to-talk hold key. */
function PttKeyCapture(): JSX.Element {
  const { t } = useAppTranslation();
  const pttKey = useMediaSettings((s) => s.pttKey);
  const setPttKey = useMediaSettings((s) => s.setPttKey);
  const [recording, setRecording] = useState(false);
  const recordingRef = useRef(recording);
  recordingRef.current = recording;

  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      // Escape cancels without changing the binding.
      if (e.code !== "Escape") setPttKey(e.code);
      setRecording(false);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [recording, setPttKey]);

  return (
    <SettingRow
      icon={Keyboard}
      title={t("desktop:micSettings.pttKeyLabel")}
      description={t("desktop:micSettings.pttKeyHint")}
    >
      <button
        type="button"
        onClick={() => setRecording((r) => !r)}
        aria-pressed={recording}
        className={cn(
          "min-w-24 shrink-0 cursor-pointer rounded-lg px-3 py-1.5 text-center text-sm transition-[background-color,box-shadow,color] motion-hover",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
          recording
            ? "bg-accent-surface text-accent-hover shadow-[inset_0_0_0_1px_rgb(255_132_100/0.45)]"
            : "bg-raised text-fg shadow-[inset_0_-1px_0_rgb(38_49_64/0.32)] hover:bg-raised-hover active:bg-raised-pressed",
        )}
      >
        {recording ? (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-accent" />
            {t("desktop:micSettings.pttKeyRecording")}
          </span>
        ) : (
          <span className="font-mono">{formatPttKey(pttKey)}</span>
        )}
      </button>
    </SettingRow>
  );
}

/**
 * Yankı Engelleme. Turning it OFF is a two-step action: the switch opens an inline
 * warning and only the explicit "I'm on headphones" button turns it off (and records
 * that confirmation). With speakers and AEC off, the room hears itself through this
 * mic. Music mode keeps AEC on, so the row is locked there.
 */
function EchoCancellationRow({ music }: { music: boolean }): JSX.Element {
  const { t } = useAppTranslation();
  const audio = useMediaSettings((s) => s.audio);
  const setEchoCancellation = useMediaSettings((s) => s.setEchoCancellation);
  const [confirming, setConfirming] = useState(false);
  const on = isEchoCancellationOn(audio);
  const descId = useId();

  const onToggle = (next: boolean): void => {
    if (next) {
      setConfirming(false);
      setEchoCancellation("on");
    } else {
      setConfirming(true);
    }
  };

  return (
    <div>
      <SettingRow
        icon={Sparkles}
        title={t("desktop:micSettings.echoCancellation")}
        description={<span id={descId}>{t("desktop:micSettings.echoCancellationDesc")}</span>}
        disabled={music}
      >
        <Toggle
          checked={on}
          disabled={music}
          onChange={onToggle}
          label={t("desktop:micSettings.echoCancellation")}
          describedBy={descId}
        />
      </SettingRow>
      {/* Enter-only motion: the warning must be gone the instant it is answered
          (an exit fade would leave "turn it off?" on screen after the choice). */}
      {confirming && on && !music && (
          <m.div
            role="status"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0, transition: springs.position }}
            className="mx-4 mb-3.5 rounded-lg bg-warning/10 px-3.5 py-3"
          >
            <div className="flex gap-2.5">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              <p className="text-label leading-relaxed text-fg">
                {t("desktop:micSettings.echoOffWarning")}
              </p>
            </div>
            <div className="mt-3 flex flex-wrap justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                {t("desktop:micSettings.echoOffCancel")}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setEchoCancellation("off_headphones");
                  setConfirming(false);
                }}
              >
                {t("desktop:micSettings.echoOffConfirm")}
              </Button>
            </div>
          </m.div>
      )}
      {!on && !music && (
        <p className="flex gap-2 px-4 pb-3.5 text-label sm:pl-[3.75rem] leading-relaxed text-warning">
          <Headphones className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t("desktop:micSettings.echoOffActive")}
        </p>
      )}
    </div>
  );
}

/**
 * "Mikrofon" settings (Ayarlar → Mikrofon): input mode (push-to-talk / voice
 * activity / always-on), the audio-processing toggles + music mode, and the audio
 * quality tier. All state lives in the persisted `useMediaSettings` store; the
 * voice store pushes it into the engine (the single source of truth for the
 * livekit capture constraints).
 */
export function MicSettingsForm(): JSX.Element {
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
  const selfMonitoring = useVoiceStore((s) => s.selfMonitoring);
  const toggleSelfMonitoring = useVoiceStore((s) => s.toggleSelfMonitoring);
  const isActive = status === "connected" || status === "joining" || status === "reconnecting";
  const sensitivityId = useId();
  const noiseId = useId();

  const onSelectInputMode = (mode: InputMode): void => {
    setInputMode(mode);
    // Reflect the choice on the live mic immediately: PTT joins muted (hold to
    // talk), the other modes go live.
    if (isActive) setMicActive(mode !== "push_to_talk");
  };

  const music = audio.musicMode;
  // Music mode forces the effective tiers (noise Off, quality Music); reflect that.
  const effectiveNoise: NoiseSuppressionTier = music ? "off" : audio.noiseSuppression;
  const effectiveQuality: AudioQuality = music ? "music" : audio.quality;

  return (
    <div className="space-y-8">
      <SettingsGroup title={t("desktop:micSettings.inputModeHeading")}>
        <SettingsBlock className="p-1.5">
          <RadioGroup
            value={audio.inputMode}
            onValueChange={(next) => onSelectInputMode(next as InputMode)}
            aria-label={t("desktop:micSettings.inputModeHeading")}
          >
            {INPUT_MODES.map((mode) => (
              <RadioItem
                key={mode}
                value={mode}
                label={t(INPUT_MODE_LABEL[mode])}
                description={t(INPUT_MODE_DESC[mode])}
              />
            ))}
          </RadioGroup>
        </SettingsBlock>

        {audio.inputMode === "push_to_talk" && <PttKeyCapture />}

        {audio.inputMode === "voice_activity" && (
          <div>
            <SettingRow
              icon={Gauge}
              title={<span id={sensitivityId}>{t("desktop:micSettings.sensitivityLabel")}</span>}
              description={t("desktop:micSettings.sensitivityHint")}
            />
            <SettingsBlock className="pt-0 sm:pl-[3.75rem]">
              <Slider
                aria-labelledby={sensitivityId}
                min={0}
                max={100}
                step={5}
                value={Math.round(audio.vadThreshold * 100)}
                onValueChange={(value) => setVadThreshold(value / 100)}
                formatValue={(value) => `${value}%`}
                showValue
              />
            </SettingsBlock>
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup title={t("desktop:micSettings.processingHeading")}>
        <SettingRow
          icon={Music}
          title={t("desktop:micSettings.musicModeLabel")}
          description={t("desktop:micSettings.musicModeDesc")}
        >
          <Toggle
            checked={music}
            onChange={setMusicMode}
            label={t("desktop:micSettings.musicModeLabel")}
          />
        </SettingRow>
        <div>
          <SettingRow
            icon={Waves}
            title={<span id={noiseId}>{t("desktop:micSettings.noiseSuppression")}</span>}
            description={t("desktop:micSettings.noiseSuppressionTierDesc")}
            disabled={music}
          />
          <SettingsBlock className="pt-0 sm:pl-[3.75rem]">
            <RadioGroup
              value={effectiveNoise}
              onValueChange={(next) => setNoiseSuppression(next as NoiseSuppressionTier)}
              disabled={music}
              aria-labelledby={noiseId}
              className="grid grid-cols-3 gap-1.5"
            >
              {NOISE_SUPPRESSION_TIERS.map((tier) => (
                <RadioCard
                  key={tier}
                  value={tier}
                  label={t(NOISE_TIER_LABEL[tier])}
                  detail={t(NOISE_TIER_DESC[tier])}
                />
              ))}
            </RadioGroup>
          </SettingsBlock>
        </div>
        <EchoCancellationRow music={music} />
        <SettingRow
          icon={Gauge}
          title={t("desktop:micSettings.autoGainControl")}
          description={t("desktop:micSettings.autoGainControlDesc")}
          disabled={music}
        >
          <Toggle
            checked={!music && audio.processing.autoGainControl}
            disabled={music}
            onChange={setAutoGainControl}
            label={t("desktop:micSettings.autoGainControl")}
          />
        </SettingRow>
        {music && (
          <SettingsBlock className="pt-3">
            <p className="text-label leading-relaxed text-accent-hover">
              {t("desktop:micSettings.musicModeActive")}
            </p>
          </SettingsBlock>
        )}
      </SettingsGroup>

      {/* "Kendini dinle" — deliberately placed directly UNDER the noise-suppression
          tiers: it exists so the tier above can be judged by ear. The engine plays
          back the same capture + worklet chain the publish uses, so what you hear
          is what the far end gets. */}
      <SettingsGroup title={t("desktop:micSettings.monitorHeading")}>
        <SettingRow
          icon={Headphones}
          title={t("desktop:micSettings.monitorLabel")}
          description={t("desktop:micSettings.monitorDesc")}
        >
          <Toggle
            checked={selfMonitoring}
            onChange={toggleSelfMonitoring}
            label={t("desktop:micSettings.monitorLabel")}
          />
        </SettingRow>
        <SettingsBlock className="space-y-1.5 sm:pl-[3.75rem]">
          {/* Say WHY the mic/audio drop out — an unexplained auto-mute reads as a bug. */}
          {isActive && (
            <p
              className={cn(
                "text-label leading-relaxed",
                selfMonitoring ? "text-accent-hover" : "text-fg-faint",
              )}
            >
              {t("desktop:micSettings.monitorInCallNotice")}
            </p>
          )}
          <p className="text-label leading-relaxed text-fg-faint">
            {t("desktop:micSettings.monitorHeadphonesHint")}
          </p>
        </SettingsBlock>
      </SettingsGroup>

      <SettingsGroup title={t("desktop:micSettings.qualityHeading")}>
        <SettingsBlock className="p-2">
          <RadioGroup
            value={effectiveQuality}
            onValueChange={(next) => setAudioQuality(next as AudioQuality)}
            disabled={music}
            aria-label={t("desktop:micSettings.qualityHeading")}
            className="grid grid-cols-3 gap-1.5"
          >
            {AUDIO_QUALITIES_ORDERED.map((quality) => (
              <RadioCard
                key={quality}
                value={quality}
                label={t(AUDIO_QUALITY_LABEL[quality])}
                detail={`~${AUDIO_QUALITY_BITRATE_KBPS[quality]} kbps`}
              />
            ))}
          </RadioGroup>
        </SettingsBlock>
      </SettingsGroup>

      <SettingsNote icon={Mic}>{t("desktop:micSettings.note")}</SettingsNote>
    </div>
  );
}
