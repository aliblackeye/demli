/**
 * Persisted user preference for haptic feedback (task: mobile native batch 1.6).
 * A single master switch, following the SAME pattern as `sounds/sound-settings.ts`
 * — zustand `persist` backed by `expo-secure-store` (the store the app already
 * uses for locale, session token, sound + media settings, so NO new native
 * module is added by the store itself; the native dependency is `expo-haptics`).
 *
 * Read imperatively via `getState()` inside `lib/haptics.ts` on every trigger, so
 * toggling applies immediately with no extra wiring; read reactively in
 * `components/HapticsSettings`.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { secureStorage } from "../lib/secure-storage";

export interface HapticsSettingsState {
  /** Master switch for every haptic tap. Defaults on (subtle, expected on mobile). */
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}

export const useHapticsSettings = create<HapticsSettingsState>()(
  persist(
    (set) => ({
      enabled: true,
      setEnabled: (enabled) => set({ enabled }),
    }),
    {
      name: "demli.haptics-settings",
      storage: createJSONStorage(() => secureStorage),
      // Persist only the data, never the setter.
      partialize: (s) => ({ enabled: s.enabled }),
    },
  ),
);
