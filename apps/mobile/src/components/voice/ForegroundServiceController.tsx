import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { useAppTranslation } from "@/lib/i18n";
import { useVoiceStore } from "@/stores/voice-store";
import {
  resolveVoiceForegroundServiceType,
  startVoiceForegroundService,
  stopVoiceForegroundService,
} from "@/media/foreground-service";

/**
 * Headless controller that runs the Android foreground service which keeps the
 * microphone — and the camera, while it is on — capturing after the app leaves
 * the foreground during a voice session or DM call.
 *
 * Android cuts both at the SOURCE once the app stops being visible unless a
 * foreground service covers that exact capability, and service types do not
 * cross-grant: the screen share's `mediaProjection` service keeps the share
 * alive and nothing else. So this runs for the WHOLE session, screen share
 * included — see media/foreground-service for the founder repro that proved it.
 *
 * WHY IT WAITS FOR THE FOREGROUND. Android refuses to start (or widen) a
 * while-in-use foreground service from the background, so every start attempt is
 * gated on AppState being "active". At join time the app is active anyway, so
 * nothing is delayed; the gate matters for a call answered from a push
 * notification while backgrounded, where the start would be rejected — this
 * re-attempts the moment the user next opens the app, instead of leaving the
 * session with no lifeline. Stopping is always allowed.
 *
 * Drives the FGS purely off the voice FSM, READ-ONLY — it never mutates the
 * store, keeping the `@demli/media` engine the single source of truth
 * (CLAUDE.md §11). Mounted once at the app root next to VoiceKeepAwake so it
 * works from any screen, since a call persists off the voice screen via the
 * global mini-bar. No UI, and a no-op on iOS / Expo Go (see foreground-service).
 */
export function ForegroundServiceController(): null {
  const { t } = useAppTranslation();
  const status = useVoiceStore((s) => s.status);
  const cameraEnabled = useVoiceStore((s) => s.cameraEnabled);
  const serviceType = resolveVoiceForegroundServiceType({
    status,
    cameraEnabled,
  });

  const [appActive, setAppActive] = useState(
    () => AppState.currentState === "active",
  );
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      setAppActive(next === "active");
    });
    return () => sub.remove();
  }, []);

  const title = t("mobile:voice.backgroundMic.title");
  const message = t(
    serviceType === "microphone|camera"
      ? "mobile:voice.backgroundMic.messageWithCamera"
      : "mobile:voice.backgroundMic.message",
  );

  useEffect(() => {
    if (serviceType === null) {
      void stopVoiceForegroundService();
      return;
    }
    // Only ever start/widen from the foreground — Android rejects it otherwise.
    // While backgrounded we keep whatever is already running rather than risk
    // tearing down a working microphone lifeline.
    if (!appActive) return;
    void startVoiceForegroundService(serviceType, title, message);
  }, [serviceType, appActive, title, message]);

  // Safety net: never leak the service if the app root unmounts.
  useEffect(() => {
    return () => {
      void stopVoiceForegroundService();
    };
  }, []);

  return null;
}
