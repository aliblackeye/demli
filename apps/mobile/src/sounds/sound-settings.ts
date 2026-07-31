/**
 * Persisted user preferences for UI sound effects — the mobile mirror of the
 * desktop renderer's sounds/sound-settings.ts. Same shape (master switch,
 * volume, separate message-notification switch) and the same defaults, so the
 * two clients behave identically (the founder's "no differences" bar).
 *
 * Persistence: zustand `persist` backed by `expo-secure-store`, the SAME store
 * the app already uses for the locale and session token (see lib/locale-storage
 * and lib/token-storage). Reusing it adds NO native module, so it keeps OTA
 * delivery to the installed APK intact (runtimeVersion is pinned — CLAUDE.md
 * §33 human-approval item, not touched here). The desktop uses localStorage;
 * SecureStore is the RN-side equivalent. The payload is tiny (three fields),
 * well under SecureStore's ~2KB cap.
 *
 * Read reactively in `SoundSettingsSection`; read imperatively via `getState()`
 * in the sound manager on every play() call, so a toggle applies immediately.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { secureStorage } from "../lib/secure-storage";

export interface SoundSettingsState {
  /** Master switch for every UI sound effect. */
  enabled: boolean;
  /** Playback volume for UI sounds, 0..1. */
  volume: number;
  /** Separate switch for the new-message notification sound. */
  messageEnabled: boolean;

  setEnabled: (enabled: boolean) => void;
  setVolume: (volume: number) => void;
  setMessageEnabled: (enabled: boolean) => void;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

export const useSoundSettings = create<SoundSettingsState>()(
  persist(
    (set) => ({
      enabled: true,
      volume: 0.5,
      messageEnabled: true,

      setEnabled: (enabled) => set({ enabled }),
      setVolume: (volume) => set({ volume: clamp01(volume) }),
      setMessageEnabled: (messageEnabled) => set({ messageEnabled }),
    }),
    {
      name: "demli.sound-settings",
      storage: createJSONStorage(() => secureStorage),
      // Persist only the data, never the setters.
      partialize: (s) => ({
        enabled: s.enabled,
        volume: s.volume,
        messageEnabled: s.messageEnabled,
      }),
    },
  ),
);
