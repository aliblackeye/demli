/**
 * Per-channel age-gate acknowledgment (M15) — the mobile mirror of
 * the desktop renderer's stores/nsfw-gate-store.ts.
 *
 * Records that an ADULT viewer has confirmed the "this channel is 18+" prompt for
 * a given channel, so we don't re-prompt on every visit. Device-local and keyed
 * by channel id (channel ids are global, so no per-account scoping is needed).
 * Acknowledgment is only ever recorded for an adult (minors are hard-blocked
 * upstream by the gate), so it can never bypass the age check.
 *
 * Persistence reuses the SAME `expo-secure-store`-backed zustand `persist` seam as
 * the self-presence / media / sound stores — no new native module (OTA-safe). The
 * stored set is small (NSFW channels are rare), well within SecureStore's limits.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { secureStorage } from "../lib/secure-storage";
import type { ChannelId } from "@demli/types";

interface NsfwGateState {
  /** channelId → the viewer confirmed the 18+ prompt for it. */
  confirmedByChannel: Record<ChannelId, boolean>;
  confirm: (channelId: ChannelId) => void;
}

export const useNsfwGateStore = create<NsfwGateState>()(
  persist(
    (set) => ({
      confirmedByChannel: {},
      confirm: (channelId) =>
        set((s) => ({ confirmedByChannel: { ...s.confirmedByChannel, [channelId]: true } })),
    }),
    {
      name: "demli.nsfw-gate",
      storage: createJSONStorage(() => secureStorage),
      partialize: (s) => ({ confirmedByChannel: s.confirmedByChannel }),
    },
  ),
);
