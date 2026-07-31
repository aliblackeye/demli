/**
 * The user's own CHOSEN presence status (the status picker).
 *
 * Persisted per-account in localStorage so the pick survives reloads and account
 * switches, and re-applied to the gateway on every (re)connect (see
 * `realtime/connection.ts` — a server-side presence wipe on restart otherwise
 * resets everyone to "online"). Kept SEPARATE from any auto-away: a manual choice
 * is authoritative and always wins (§ founder "manuel seçim otomatiği ezer").
 *
 * This is the single source of truth for "did the user pick Do Not Disturb /
 * Invisible", read imperatively (`isDoNotDisturb()`) by the notification + call
 * gating and reactively by the status picker / CallLayer.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { SelectablePresenceStatus, UserId } from "@demli/types";
import { useAuthStore } from "./auth-store";

interface SelfPresenceState {
  /** userId → the status this account last chose. Applied on connect. */
  statusByUser: Record<UserId, SelectablePresenceStatus>;
  /**
   * Auto-away is currently active for THIS session (the inactivity detector, see
   * `idle-auto.ts`). NEVER persisted — it is a live, per-session signal derived
   * from user inactivity, not a choice. It only AUGMENTS an "online" pick; a
   * manual dnd/invisible/idle always wins (see {@link getEffectiveSelfPresenceStatus}).
   */
  autoAway: boolean;
  setStatus: (userId: UserId, status: SelectablePresenceStatus) => void;
  setAutoAway: (away: boolean) => void;
}

export const useSelfPresenceStore = create<SelfPresenceState>()(
  persist(
    (set) => ({
      statusByUser: {},
      autoAway: false,
      setStatus: (userId, status) =>
        set((s) => ({ statusByUser: { ...s.statusByUser, [userId]: status } })),
      setAutoAway: (away) => set({ autoAway: away }),
    }),
    {
      name: "demli.self-presence",
      // Persist only the chosen statuses, never the setters or the live autoAway.
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

/**
 * The status this session should actually BROADCAST: the chosen status, unless
 * auto-away has kicked in over an "online" pick — then "idle". A manual
 * dnd/invisible/idle choice is authoritative and suppresses auto-away entirely
 * (§ founder "manuel seçim otomatiği ezer"), so this only ever upgrades "online".
 * The re-connect re-assert (auth.succeeded) and the auto-idle detector both read
 * through here so the effective dot survives a reconnect while away.
 */
export function getEffectiveSelfPresenceStatus(): SelectablePresenceStatus {
  const chosen = getSelfPresenceStatus();
  if (chosen === "online" && useSelfPresenceStore.getState().autoAway) return "idle";
  return chosen;
}

/**
 * True while the active user has chosen Do Not Disturb. The single gate the
 * notification manager (sounds + toasts) and CallLayer (ring + forced overlay)
 * consult, so DND behavior stays consistent across every surface.
 */
export function isDoNotDisturb(): boolean {
  return getSelfPresenceStatus() === "dnd";
}
