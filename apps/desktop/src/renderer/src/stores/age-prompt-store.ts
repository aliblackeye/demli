/**
 * "Verify your age" reminder dismissals, per account.
 *
 * The reminder is a ONE-TIME, dismissible nudge for accounts with no date of
 * birth on file (most of them predate the age gate). Founder rule: it must never
 * block anything and must never come back once waved off — someone who never
 * opens an age-restricted channel should see it exactly once, and someone who
 * does will meet the real gate anyway.
 *
 * Keyed by USER id, not stored as a single flag: this app switches accounts in
 * place (ADR 0013), and a global "dismissed" would silently hide the reminder for
 * every account the user signs into afterwards. Persisted to localStorage, so
 * "once" means once across restarts.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
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
      // Persist only the dismissals, never the setter.
      partialize: (s) => ({ dismissedByUser: s.dismissedByUser }),
    },
  ),
);
