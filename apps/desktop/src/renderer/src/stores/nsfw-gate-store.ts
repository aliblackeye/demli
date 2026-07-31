/**
 * Per-channel NSFW age-gate acknowledgements (M18).
 *
 * When an ADULT visits an NSFW channel for the first time they must confirm "this
 * may contain NSFW content, continue?" (founder). The acknowledgement is
 * remembered per channel so the gate does not nag on every visit — persisted to
 * localStorage, keyed by channel id (device-local). Minors are
 * blocked by the adult check UPSTREAM (see `NsfwChannelGate`), so a confirmation
 * here is only ever recorded for an 18+ user and never bypasses the age check.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ChannelId } from "@demli/types";

interface NsfwGateState {
  /** channelId → true once the (adult) user acknowledged the NSFW warning. */
  confirmedByChannel: Record<ChannelId, boolean>;
  confirm: (channelId: ChannelId) => void;
}

export const useNsfwGateStore = create<NsfwGateState>()(
  persist(
    (set) => ({
      confirmedByChannel: {},
      confirm: (channelId) =>
        set((s) => ({
          confirmedByChannel: { ...s.confirmedByChannel, [channelId]: true },
        })),
    }),
    {
      name: "demli.nsfw-gate",
      // Persist only the acknowledgements, never the setter.
      partialize: (s) => ({ confirmedByChannel: s.confirmedByChannel }),
    },
  ),
);
