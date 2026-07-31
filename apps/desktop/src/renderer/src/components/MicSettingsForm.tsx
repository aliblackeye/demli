import { useEffect, useRef, useState } from "react";
import { Gauge, Headphones, Keyboard, Mic, Music, Sparkles, Waves } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@demli/ui";
import {
  AUDIO_QUALITY_BITRATE_KBPS,
  INPUT_MODES,
  NOISE_SUPPRESSION_TIERS,
  type AudioQuality,
  type InputMode,
  type NoiseSuppressionTier,
} from "@demli/media";
import { useAppTranslation } from "../lib/i18n";
import { useMediaSettings } from "../stores/media-settings";
import { useVoiceStore } from "../stores/voice-store";
import { formatPttKey } from "../lib/ptt";
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

function Section({ children }: { children: React.ReactNode }): JSX.Element {
  return <section className="rounded-xl border border-stroke bg-surface p-1.5">{children}</section>;
}

function SectionHeading({ children }: { children: string }): JSX.Element {
  return <h2 className="px-3.5 pb-1 pt-2.5 text-sm font-semibold text-fg">{children}</h2>;
}

function ToggleRow({
  icon: Icon,
  title,
  description,
  checked,
  disabled,
  onChange,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}): JSX.Element {
  return (
    <div className={cn("flex items-start justify-between gap-4 px-4 py-3.5", disabled && "opacity-50")}>
      <div className="flex min-w-0 gap-3">
        <Icon className="mt-0.5 size-4 shrink-0 text-fg-faint" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-fg">{title}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-fg-faint">{description}</p>
        </div>
      </div>
      <Toggle checked={checked} disabled={disabled} onChange={onChange} label={title} />
    </div>
  );
}

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
    <div className="px-4 py-3.5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 gap-3">
          <Keyboard className="mt-0.5 size-4 shrink-0 text-fg-faint" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-fg">{t("desktop:micSettings.pttKeyLabel")}</p>
            <p className="mt-0.5 text-xs leading-relaxed text-fg-faint">
              {t("desktop:micSettings.pttKeyHint")}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setRecording((r) => !r)}
          className={cn(
            "min-w-24 shrink-0 cursor-pointer rounded-md border px-3 py-1.5 text-center text-sm transition-colors motion-instant",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
            recording
              ? "border-accent/60 bg-accent/10 text-fg"
              : "border-stroke bg-raised text-fg-muted hover:border-stroke-strong hover:text-fg",
          )}
        >
          {recording ? (
            t("desktop:micSettings.pttKeyRecording")
          ) : (
            <span className="font-mono text-fg">{formatPttKey(pttKey)}</span>
          )}
        </button>
      </div>
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
  const setProcessing = useMediaSettings((s) => s.setProcessing);
  const setNoiseSuppression = useMediaSettings((s) => s.setNoiseSuppression);
  const setMusicMode = useMediaSettings((s) => s.setMusicMode);
  const setAudioQuality = useMediaSettings((s) => s.setAudioQuality);

  const status = useVoiceStore((s) => s.status);
  const setMicActive = useVoiceStore((s) => s.setMicActive);
  const selfMonitoring = useVoiceStore((s) => s.selfMonitoring);
  const toggleSelfMonitoring = useVoiceStore((s) => s.toggleSelfMonitoring);
  const isActive = status === "connected" || status === "joining" || status === "reconnecting";

  const onSelectInputMode = (mode: InputMode): void => {
    setInputMode(mode);
    // Reflect the choice on the live mic immediately: PTT joins muted (hold to
    // talk), the other modes go live.
    if (isActive) setMicActive(mode !== "push_to_talk");
  };

  const music = audio.musicMode;

  return (
    <div className="space-y-6">
      <Section>
        <SectionHeading>{t("desktop:micSettings.inputModeHeading")}</SectionHeading>
        <div role="radiogroup" aria-label={t("desktop:micSettings.inputModeHeading")} className="space-y-1 p-1.5">
          {INPUT_MODES.map((mode) => {
            const selected = audio.inputMode === mode;
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onSelectInputMode(mode)}
                className={cn(
                  "flex w-full cursor-pointer flex-col rounded-md border px-3 py-2 text-left transition-colors motion-instant",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                  selected
                    ? "border-accent/60 bg-accent/10"
                    : "border-stroke bg-raised hover:border-stroke-strong",
                )}
              >
                <span className={cn("text-sm font-medium", selected ? "text-fg" : "text-fg-muted")}>
                  {t(INPUT_MODE_LABEL[mode])}
                </span>
                <span className="mt-0.5 text-xs text-fg-faint">{t(INPUT_MODE_DESC[mode])}</span>
              </button>
            );
          })}
        </div>

        {audio.inputMode === "push_to_talk" && (
          <div className="border-t border-stroke/60">
            <PttKeyCapture />
          </div>
        )}

        {audio.inputMode === "voice_activity" && (
          <div className="border-t border-stroke/60 px-4 py-3.5">
            <div className="flex items-center justify-between gap-4">
              <div className="flex min-w-0 gap-3">
                <Gauge className="mt-0.5 size-4 shrink-0 text-fg-faint" />
                <div className="min-w-0">
                  <label htmlFor="vad-sensitivity" className="text-sm font-medium text-fg">
                    {t("desktop:micSettings.sensitivityLabel")}
                  </label>
                  <p className="mt-0.5 text-xs leading-relaxed text-fg-faint">
                    {t("desktop:micSettings.sensitivityHint")}
                  </p>
                </div>
              </div>
              <span className="text-xs tabular-nums text-fg-muted">
                {Math.round(audio.vadThreshold * 100)}%
              </span>
            </div>
            <input
              id="vad-sensitivity"
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round(audio.vadThreshold * 100)}
              onChange={(e) => setVadThreshold(Number(e.target.value) / 100)}
              className="mt-2.5 h-1.5 w-full cursor-pointer appearance-auto accent-accent"
            />
          </div>
        )}
      </Section>

      <Section>
        <SectionHeading>{t("desktop:micSettings.processingHeading")}</SectionHeading>
        <div className="divide-y divide-stroke/60">
          <ToggleRow
            icon={Music}
            title={t("desktop:micSettings.musicModeLabel")}
            description={t("desktop:micSettings.musicModeDesc")}
            checked={music}
            onChange={setMusicMode}
          />
          <div className={cn("px-4 py-3.5", music && "opacity-50")}>
            <div className="flex min-w-0 gap-3">
              <Waves className="mt-0.5 size-4 shrink-0 text-fg-faint" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-fg">
                  {t("desktop:micSettings.noiseSuppression")}
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-fg-faint">
                  {t("desktop:micSettings.noiseSuppressionTierDesc")}
                </p>
              </div>
            </div>
            <div
              role="radiogroup"
              aria-label={t("desktop:micSettings.noiseSuppression")}
              className="mt-2.5 grid grid-cols-3 gap-1"
            >
              {NOISE_SUPPRESSION_TIERS.map((tier) => {
                // Music mode forces the effective tier to Off, so reflect that.
                const selected = music ? tier === "off" : audio.noiseSuppression === tier;
                return (
                  <button
                    key={tier}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={music}
                    onClick={() => setNoiseSuppression(tier)}
                    className={cn(
                      "cursor-pointer rounded-md border px-2 py-2 text-center transition-colors motion-instant",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                      music && "cursor-not-allowed",
                      selected
                        ? "border-accent/60 bg-accent/10"
                        : "border-stroke bg-raised hover:border-stroke-strong",
                    )}
                  >
                    <span
                      className={cn(
                        "block text-sm font-medium",
                        selected ? "text-fg" : "text-fg-muted",
                      )}
                    >
                      {t(NOISE_TIER_LABEL[tier])}
                    </span>
                    <span className="mt-0.5 block text-2xs leading-tight text-fg-faint">
                      {t(NOISE_TIER_DESC[tier])}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          <ToggleRow
            icon={Sparkles}
            title={t("desktop:micSettings.echoCancellation")}
            description={t("desktop:micSettings.echoCancellationDesc")}
            checked={music || audio.processing.echoCancellation}
            disabled={music}
            onChange={(next) => setProcessing({ echoCancellation: next })}
          />
          <ToggleRow
            icon={Gauge}
            title={t("desktop:micSettings.autoGainControl")}
            description={t("desktop:micSettings.autoGainControlDesc")}
            checked={!music && audio.processing.autoGainControl}
            disabled={music}
            onChange={(next) => setProcessing({ autoGainControl: next })}
          />
        </div>
        {music && (
          <p className="px-4 pb-2.5 pt-1 text-xs leading-relaxed text-accent/90">
            {t("desktop:micSettings.musicModeActive")}
          </p>
        )}
      </Section>

      {/* "Kendini dinle" — deliberately placed directly UNDER the noise-suppression
          tiers: it exists so the tier above can be judged by ear. The engine plays
          back the same capture + worklet chain the publish uses, so what you hear
          is what the far end gets. */}
      <Section>
        <SectionHeading>{t("desktop:micSettings.monitorHeading")}</SectionHeading>
        <ToggleRow
          icon={Headphones}
          title={t("desktop:micSettings.monitorLabel")}
          description={t("desktop:micSettings.monitorDesc")}
          checked={selfMonitoring}
          onChange={toggleSelfMonitoring}
        />
        {/* Say WHY the mic/audio drop out — an unexplained auto-mute reads as a bug. */}
        {isActive && (
          <p
            className={cn(
              "px-4 pb-2.5 pt-1 text-xs leading-relaxed",
              selfMonitoring ? "text-accent/90" : "text-fg-faint",
            )}
          >
            {t("desktop:micSettings.monitorInCallNotice")}
          </p>
        )}
        <p className="px-4 pb-3 pt-1 text-xs leading-relaxed text-fg-faint">
          {t("desktop:micSettings.monitorHeadphonesHint")}
        </p>
      </Section>

      <Section>
        <SectionHeading>{t("desktop:micSettings.qualityHeading")}</SectionHeading>
        <div
          role="radiogroup"
          aria-label={t("desktop:micSettings.qualityHeading")}
          className="grid grid-cols-3 gap-1 p-1.5"
        >
          {AUDIO_QUALITIES_ORDERED.map((quality) => {
            // Music mode forces the effective tier to Music, so reflect that.
            const selected = music ? quality === "music" : audio.quality === quality;
            return (
              <button
                key={quality}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={music}
                onClick={() => setAudioQuality(quality)}
                className={cn(
                  "cursor-pointer rounded-md border px-2 py-2 text-center transition-colors motion-instant",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                  music && "cursor-not-allowed opacity-60",
                  selected
                    ? "border-accent/60 bg-accent/10"
                    : "border-stroke bg-raised hover:border-stroke-strong",
                )}
              >
                <span className={cn("block text-sm font-medium", selected ? "text-fg" : "text-fg-muted")}>
                  {t(AUDIO_QUALITY_LABEL[quality])}
                </span>
                <span className="mt-0.5 block text-2xs text-fg-faint">
                  ~{AUDIO_QUALITY_BITRATE_KBPS[quality]} kbps
                </span>
              </button>
            );
          })}
        </div>
      </Section>

      <div className="flex items-center gap-2">
        <Mic className="size-3.5 text-fg-faint" />
        <p className="text-xs leading-relaxed text-fg-faint">{t("desktop:micSettings.note")}</p>
      </div>
    </div>
  );
}
