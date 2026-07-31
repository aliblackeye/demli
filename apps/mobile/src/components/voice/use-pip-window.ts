import { useEffect, useState } from "react";
import { AppState } from "react-native";
import ExpoPip from "expo-pip";
import { isInPipWindow } from "./pip-overlay";

/**
 * "Are we actually shrunk into the Android PiP window right now?"
 *
 * `expo-pip`'s `useIsInPip()` alone cannot answer that: it can be left stale-true
 * after the user expands the window back to full screen (a missed
 * `onPictureInPictureModeChanged(false)`). So this pairs it with RN `AppState`,
 * which on Android pauses the activity when PiP starts and resumes it when the
 * window is expanded — a foregrounded app is NEVER in a PiP window. The decision
 * itself lives in the pure, unit-tested {@link isInPipWindow}.
 *
 * Two consumers, one answer: `PipController` (what to render in the window) and
 * `VideoFullscreenModal` (dismiss itself, since an RN `<Modal>` is a SEPARATE
 * native window that the PiP capture of the activity does not include).
 */
export function useIsInPipWindow(): boolean {
  const { isInPipMode } = ExpoPip.useIsInPip();
  const [appActive, setAppActive] = useState(() => AppState.currentState === "active");

  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      setAppActive(next === "active");
    });
    return () => sub.remove();
  }, []);

  return isInPipWindow({ isInPipMode, appActive });
}
