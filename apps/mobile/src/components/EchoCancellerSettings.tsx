import { useCallback, useEffect, useState } from "react";
import { Text } from "./ui/Text";
import { useAppTranslation } from "@/lib/i18n";
import { ChipSelect } from "@/components/ChipSelect";
import { SettingsBlock, SettingsSection } from "@/components/settings/SettingsSection";
import {
  getAudioProcessingInfo,
  setHardwareAudioProcessingPreferred,
  type AudioProcessingInfo,
} from "@/media/audio-route";
import { effectiveAudioProcessing } from "@demli/media";
import { echoCancellerView, hardwareForMode, type EchoCancellerMode } from "@/media/echo-canceller";
import { useMediaSettings } from "@/stores/media-settings";
import { colors } from "@/theme/theme";

/**
 * "Yankı engelleyici" (M16 · 1D) — which echo canceller the Android audio device
 * module is built with: the phone's own (hardware) or WebRTC's software one. See
 * media/echo-canceller.ts for the tradeoff and why the phone's stays the default.
 *
 * The choice is persisted NATIVELY (the module reads it while building the ADM at
 * app start, before any JS runs), so this component reads and writes it through
 * the patched LiveKit module rather than a JS store, and shows a restart note
 * until the running module matches the saved choice. Rendered only where a real
 * choice or a real fact exists — never a dead control (§35). With the mic's echo
 * cancellation switched off, neither canceller runs; the status line says so
 * instead of claiming the choice is active.
 */

export function EchoCancellerSettings() {
  const { t } = useAppTranslation();
  const [info, setInfo] = useState<AudioProcessingInfo | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const aecEnabled = useMediaSettings((s) => effectiveAudioProcessing(s.audio).echoCancellation);

  const reload = useCallback(() => {
    void getAudioProcessingInfo().then(setInfo);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const view = echoCancellerView(info, aecEnabled);
  if (view.kind === "hidden") return null;

  const onSelect = (key: string) => {
    const mode = key as EchoCancellerMode;
    void setHardwareAudioProcessingPreferred(hardwareForMode(mode)).then((ok) => {
      setSaveFailed(!ok);
      reload();
    });
  };

  const note = { fontSize: 12, lineHeight: 17 } as const;

  return (
    <SettingsSection title={t("mobile:echoCanceller.section")}>
      <SettingsBlock>
        {view.kind === "softwareOnly" ? (
          view.aecOff ? null : (
            <Text style={{ ...note, color: colors.fgMuted }}>
              {view.reason === "oldAndroid"
                ? t("mobile:echoCanceller.oldAndroid")
                : t("mobile:echoCanceller.noHardware")}
            </Text>
          )
        ) : (
          <>
            <ChipSelect
              accessibilityLabel={t("mobile:echoCanceller.section")}
              options={[
                { key: "device", label: t("mobile:echoCanceller.optionDevice") },
                { key: "demli", label: t("mobile:echoCanceller.optionSoftware") },
              ]}
              selectedKey={view.selected}
              onSelect={onSelect}
            />

            <Text style={{ ...note, color: colors.fgMuted }}>
              {view.selected === "device"
                ? t("mobile:echoCanceller.deviceDesc")
                : t("mobile:echoCanceller.softwareDesc")}
            </Text>

            {view.aecOff ? null : (
              <Text style={{ ...note, color: view.restartPending ? colors.warning : colors.fgFaint }}>
                {view.restartPending
                  ? t("mobile:echoCanceller.restartPending")
                  : t("mobile:echoCanceller.applied")}
              </Text>
            )}
          </>
        )}

        {view.aecOff ? (
          <Text style={{ ...note, color: colors.warning }}>{t("mobile:echoCanceller.aecOff")}</Text>
        ) : null}

        {saveFailed ? (
          <Text accessibilityRole="alert" style={{ ...note, color: colors.danger }}>
            {t("mobile:echoCanceller.saveFailed")}
          </Text>
        ) : null}
      </SettingsBlock>
    </SettingsSection>
  );
}
