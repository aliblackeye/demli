/**
 * The user's own CHOSEN presence status (the status picker) — the mobile
 * mirror of the desktop renderer's stores/self-presence-store.ts.
 *
 * Persisted per-account so the pick survives reloads and account switches, and
 * re-applied to the gateway on every (re)connect (see `realtime/connection.ts` —
 * a server-side presence wipe on restart otherwise resets everyone to "online").
 * A manual choice is authoritative; there is no auto-away on mobile.
 *
 * The single source of truth for "did the user pick Do Not Disturb / Invisible",
 * read imperatively (`getSelfPresenceStatus`) by the reconnect re-assert and
 * reactively by the status picker.
 *
 * Persistence: zustand `persist` backed by `expo-secure-store` — the SAME store
 * the app uses for the locale, session token, media, and sound settings. Reusing
 * it adds NO native module, keeping OTA delivery intact (the status is a plain
 * JS-level enum).
 */

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { secureStorage } from "../lib/secure-storage";
import type { SelectablePresenceStatus, UserId } from "@demli/types";
import { useAuthStore } from "./auth-store";

interface SelfPresenceState {
  /** userId → the status this account last chose. Applied on connect. */
  statusByUser: Record<UserId, SelectablePresenceStatus>;
  setStatus: (userId: UserId, status: SelectablePresenceStatus) => void;
}

export const useSelfPresenceStore = create<SelfPresenceState>()(
  persist(
    (set) => ({
      statusByUser: {},
      setStatus: (userId, status) =>
        set((s) => ({ statusByUser: { ...s.statusByUser, [userId]: status } })),
    }),
    {
      name: "demli.self-presence",
      storage: createJSONStorage(() => secureStorage),
      // Persist only the data, never the setter.
      partialize: (s) => ({ statusByUser: s.statusByUser }),
    },
  ),
);

/** The active user's chosen status — defaults to "online". */
export function getSelfPresenceStatus(): SelectablePresenceStatus {
  const id = useAuthStore.getState().user?.id;
  if (!id) return "online";
  return useSelfPresenceStore.getState().statusByUser[id] ?? "online";
}
