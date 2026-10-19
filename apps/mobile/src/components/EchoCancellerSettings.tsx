import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Text } from "./ui/Text";
import { useAppTranslation } from "@/lib/i18n";
import { ChipSelect } from "@/components/ChipSelect";
import {
  getAudioProcessingInfo,
  setHardwareAudioProcessingPreferred,
  type AudioProcessingInfo,
} from "@/media/audio-route";
import { effectiveAudioProcessing } from "@demli/media";
import { echoCancellerView, hardwareForMode, type EchoCancellerMode } from "@/media/echo-canceller";
import { useMediaSettings } from "@/stores/media-settings";
import { colors, space, typography } from "@/theme/theme";

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

  return (
    <View>
      <SectionLabel>{t("mobile:echoCanceller.section")}</SectionLabel>

      <View style={{ paddingHorizontal: space.lg, gap: space.sm }}>
        {view.kind === "softwareOnly" ? (
          view.aecOff ? null : (
            <Text style={{ color: colors.fgMuted, fontSize: 12, lineHeight: 17 }}>
              {view.reason === "oldAndroid"
                ? t("mobile:echoCanceller.oldAndroid")
                : t("mobile:echoCanceller.noHardware")}
            </Text>
          )
        ) : (
          <>
            <ChipSelect
              options={[
                { key: "device", label: t("mobile:echoCanceller.optionDevice") },
                { key: "demli", label: t("mobile:echoCanceller.optionSoftware") },
              ]}
              selectedKey={view.selected}
              onSelect={onSelect}
            />

            <Text style={{ color: colors.fgMuted, fontSize: 12, lineHeight: 17 }}>
              {view.selected === "device"
                ? t("mobile:echoCanceller.deviceDesc")
                : t("mobile:echoCanceller.softwareDesc")}
            </Text>

            {view.aecOff ? null : (
              <Text style={{ color: view.restartPending ? colors.warning : colors.fgFaint, fontSize: 12 }}>
                {view.restartPending
                  ? t("mobile:echoCanceller.restartPending")
                  : t("mobile:echoCanceller.applied")}
              </Text>
            )}
          </>
        )}

        {view.aecOff ? (
          <Text style={{ color: colors.warning, fontSize: 12, lineHeight: 17 }}>
            {t("mobile:echoCanceller.aecOff")}
          </Text>
        ) : null}

        {saveFailed ? (
          <Text accessibilityRole="alert" style={{ color: colors.danger, fontSize: 12 }}>
            {t("mobile:echoCanceller.saveFailed")}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
