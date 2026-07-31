import { useEffect } from "react";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useVoiceStore } from "@/stores/voice-store";

/** Distinct tag so our lock never collides with any other keep-awake caller. */
const KEEP_AWAKE_TAG = "demli-voice";

/**
 * Keeps the phone screen awake while the user is in a voice room — talking or
 * (the reported case) watching a shared screen / camera during movie night,
 * where not touching the screen would otherwise let it dim and lock.
 *
 * Mounted once at the app root (like VoiceEvictionWatcher) so it works no matter
 * which screen is showing — a call stays active off the voice screen via the
 * persistent mini-bar. `expo-keep-awake` is already bundled (autolinked into the
 * 1.5.0 APK), so this ships over-the-air with no new native build.
 */
export function VoiceKeepAwake(): null {
  const active = useVoiceStore(
    (s) =>
      s.status === "connected" ||
      s.status === "joining" ||
      s.status === "reconnecting",
  );

  useEffect(() => {
    if (!active) return;
    void activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {
      // Native module unavailable — fail safe (screen just behaves normally).
    });
    return () => {
      void Promise.resolve(deactivateKeepAwake(KEEP_AWAKE_TAG)).catch(() => {});
    };
  }, [active]);

  return null;
}
