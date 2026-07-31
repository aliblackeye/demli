/**
 * A deep-link action that arrived before the user was authenticated. The
 * kat/arkadas handler screens stash the intent here and bounce to sign-in; the
 * <PendingDeepLinkController> replays it once the session becomes authenticated
 * (mirrors the push-tap defer-until-authenticated pattern in PushController).
 *
 * This is a tiny zustand store rather than a module ref so the controller can
 * subscribe to it reactively and the handler screens can set it from anywhere.
 */
import { create } from "zustand";

export type DeepLinkIntent =
  | { kind: "invite"; code: string }
  | { kind: "friend"; code: string };

interface PendingDeepLinkStore {
  /** The deferred action, or null when nothing is pending. */
  pending: DeepLinkIntent | null;
  setPending: (intent: DeepLinkIntent) => void;
  clearPending: () => void;
}

export const usePendingDeepLinkStore = create<PendingDeepLinkStore>()((set) => ({
  pending: null,
  setPending: (pending) => set({ pending }),
  clearPending: () => set({ pending: null }),
}));
