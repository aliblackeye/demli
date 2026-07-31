/**
 * The startup-update flow's state, held for the lifetime of the renderer.
 *
 * A thin shell around the pure reducer in lib/boot-update.ts: the reducer owns
 * every rule (and every deadline), this owns nothing but the current value and
 * hands the resulting effects back to the caller. Keeping the effects OUT of the
 * store is deliberate — running IPC from inside a zustand setter would make the
 * one thing that must stay testable (the deadlines) untestable again.
 *
 * Module-level, not per-component: React StrictMode mounts the binder twice in
 * dev, and the flow must be armed exactly once per renderer either way.
 */

import { create } from "zustand";
import {
  initialBootUpdateState,
  type BootUpdateEffect,
  type BootUpdateEvent,
  type BootUpdateState,
  reduceBootUpdate,
} from "../lib/boot-update";

interface BootUpdateStore {
  state: BootUpdateState;
  /** Advance the machine and return the effects the caller must run. */
  dispatch: (event: BootUpdateEvent) => BootUpdateEffect[];
  /** Test seam only. */
  resetBootUpdate: () => void;
}

export const useBootUpdateStore = create<BootUpdateStore>()((set, get) => ({
  state: initialBootUpdateState(),

  dispatch: (event) => {
    const previous = get().state;
    const { state, effects } = reduceBootUpdate(previous, event);
    // The reducer returns the same object for a no-op, so an unchanged tick
    // (four per second) never notifies a subscriber.
    if (state !== previous) {
      set({ state });
    }
    return effects;
  },

  resetBootUpdate: () => set({ state: initialBootUpdateState() }),
}));
