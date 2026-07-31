/**
 * "Verify your age" reminder dismissals, per account — the mobile mirror of the
 * desktop renderer's stores/age-prompt-store.ts.
 *
 * The reminder is a ONE-TIME, dismissible nudge for accounts with no date of
 * birth on file (most of them predate the age gate). Founder rule: it must never
 * block anything and must never come back once waved off — someone who never
 * opens an age-restricted channel should see it exactly once, and someone who
 * does will meet the real gate anyway.
 *
 * Keyed by USER id, not a single flag: the app switches accounts in place
 * (ADR 0013), and a global "dismissed" would silently hide the reminder for every
 * account signed into afterwards.
 *
 * Persistence reuses the SAME `expo-secure-store`-backed zustand `persist` seam
 * as the NSFW acknowledgement / self-presence stores — no new native module, so
 * this ships over OTA. The stored map is a handful of ids at most.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { secureStorage } from "../lib/secure-storage";
import type { UserId } from "@demli/types";

interface AgePromptState {
  /** userId → true once THIS account dismissed the reminder. */
  dismissedByUser: Record<UserId, boolean>;
  dismiss: (userId: UserId) => void;
}

export const useAgePromptStore = create<AgePromptState>()(
  persist(
    (set) => ({
      dismissedByUser: {},
      dismiss: (userId) =>
        set((s) => ({ dismissedByUser: { ...s.dismissedByUser, [userId]: true } })),
    }),
    {
      name: "demli.age-prompt",
      storage: createJSONStorage(() => secureStorage),
      partialize: (s) => ({ dismissedByUser: s.dismissedByUser }),
    },
  ),
);
