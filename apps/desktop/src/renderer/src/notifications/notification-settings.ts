/**
 * Persisted user preference for desktop notifications.
 *
 * Zustand + persist (localStorage) — a renderer-only cosmetic preference, so
 * localStorage is the right home (same pattern as `sound-settings.ts`). Read
 * reactively in `NotificationSettings.tsx`; read imperatively via `getState()`
 * in the notification manager on every incoming event.
 *
 * MVP scope: a single master switch. Per-source toggles (DMs vs friend requests)
 * are intentionally NOT split (task #16).
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface NotificationSettingsState {
  /** Master switch for every desktop notification (default on). */
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}

export const useNotificationSettings = create<NotificationSettingsState>()(
  persist(
    (set) => ({
      enabled: true,
      setEnabled: (enabled) => set({ enabled }),
    }),
    {
      name: "demli.notification-settings",
      // Persist only the data, never the setter.
      partialize: (s) => ({ enabled: s.enabled }),
    },
  ),
);
