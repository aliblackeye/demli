/**
 * Persisted user preferences for UI sound effects.
 *
 * Zustand + persist (localStorage) — these are renderer-only cosmetic
 * preferences, so localStorage is the right home (unlike the auth token,
 * which lives in the main-process secure store). Read reactively in
 * `SoundSettings.tsx`; read imperatively via `getState()` in the
 * sound manager on every `play()` call.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

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
      // Persist only the data, never the setters.
      partialize: (s) => ({
        enabled: s.enabled,
        volume: s.volume,
        messageEnabled: s.messageEnabled,
      }),
    },
  ),
);
