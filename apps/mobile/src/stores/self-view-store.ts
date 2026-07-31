/**
 * The self-view overlay preference — on/off + which corner it rests in (K4 of the
 * call-ux plan, `docs/decisions/0022-call-video-experience.md`).
 *
 * The self-view is the small floating box showing YOUR OWN camera while another
 * tile owns the stage (focus or fullscreen). Desktop persists exactly this pair
 * in its `video-stage-store`; this is the mobile half of the same contract, so
 * hiding your self-view on the phone and hiding it on the desktop mean the same
 * thing and both survive a restart.
 *
 * DEFAULT ON, deliberately. K4 makes the self-view the default because the
 * founder's requirement is to be able to tell at a glance that your camera is
 * doing what you think it is — which is also why turning the camera OFF does not
 * remove the box (it becomes an explicit "camera off" rectangle, see
 * `SelfViewPip`). A missing overlay is indistinguishable from a broken one, so
 * the state is shown rather than implied by absence (§35).
 *
 * Persistence uses the app's established seam — zustand `persist` over
 * `expo-secure-store`, the same one `collapsed-categories-store` /
 * `media-settings` use. Reusing SecureStore adds NO native module, so this ships
 * to the installed APK over the air; an AsyncStorage/MMKV dependency would have
 * changed `runtimeVersion` and forced a native build for a remembered corner.
 *
 * Hydration is async, so a cold start shows the default (visible, bottom-right)
 * for a frame and then settles. Visible-first is the right direction: a self-view
 * that flashes in is cosmetic, whereas flashing OUT would read as the camera
 * having dropped.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { secureStorage } from "../lib/secure-storage";

/** Which corner the overlay rests in. Mirrors `DraggableCameraPip`'s corner keys. */
export type SelfViewCorner = "tl" | "tr" | "bl" | "br";

/**
 * Bottom-right by default: it is clear of the stage's top-right control cluster
 * (fullscreen / grid / self-view toggle) and of the top-left caption, which is
 * the same resting spot the desktop overlay and FaceTime both pick.
 */
export const DEFAULT_SELF_VIEW_CORNER: SelfViewCorner = "br";

interface SelfViewState {
  /** Whether the self-view overlay is shown at all (K4: default ON). */
  enabled: boolean;
  /** Remembered resting corner. */
  corner: SelfViewCorner;
  setEnabled: (enabled: boolean) => void;
  toggle: () => void;
  setCorner: (corner: SelfViewCorner) => void;
}

export const useSelfViewStore = create<SelfViewState>()(
  persist(
    (set) => ({
      enabled: true,
      corner: DEFAULT_SELF_VIEW_CORNER,
      setEnabled: (enabled) => set({ enabled }),
      toggle: () => set((s) => ({ enabled: !s.enabled })),
      setCorner: (corner) => set({ corner }),
    }),
    {
      name: "demli.selfView.v1",
      storage: createJSONStorage(() => secureStorage),
      partialize: (s) => ({ enabled: s.enabled, corner: s.corner }),
    },
  ),
);
