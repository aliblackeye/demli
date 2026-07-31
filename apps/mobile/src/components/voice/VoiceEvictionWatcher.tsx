import { useEffect } from "react";
import { Alert } from "react-native";
import { useAppTranslation } from "@/lib/i18n";
import { useVoiceStore } from "@/stores/voice-store";
import { localizeVoiceEnded } from "./voice-ended";

/**
 * Headless notice for a voice session that ended for a NON-ERROR reason
 * (CLAUDE.md §11/§26): the single-active-session handoff (you joined voice on
 * another device) or the alone-idle close (everyone else had left, so the server
 * closed the call).
 *
 * In both cases the voice FSM has already left cleanly (idle) — this only EXPLAINS
 * why, via a native Alert (no new native dep, so it stays OTA-safe). The COPY
 * follows the reason: showing "you joined on another device" for an alone close
 * would tell the user a story about their own disconnect that never happened.
 *
 * Acknowledges the notice so it never re-fires. Mounted once at the app root,
 * under the i18n provider.
 */
export function VoiceEvictionWatcher(): null {
  const { t } = useAppTranslation();
  const endedReason = useVoiceStore((s) => s.endedReason);
  const acknowledge = useVoiceStore((s) => s.acknowledgeSessionReplaced);

  useEffect(() => {
    const message = localizeVoiceEnded(endedReason, t);
    if (!message) return;
    Alert.alert(t("mobile:voice.title"), message);
    acknowledge();
  }, [endedReason, acknowledge, t]);

  return null;
}
