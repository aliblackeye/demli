/**
 * Video-stage view state (desktop + web renderer) — the SINGLE source of truth
 * for the call/voice-room "video stage": what is promoted to the large stage,
 * whether the camera panel is collapsed, whether the stage is fullscreen, and the
 * ONE draggable overlay that floats over the stage.
 *
 * This is pure UI chrome (Zustand for UI state, CLAUDE.md §3) — it holds NO media
 * lifecycle. The actual tracks live in the media engine and are consumed via the
 * voice-store's imperative snapshots (useRemoteCameras / useRemoteScreenShares).
 * We deliberately keep this OUT of the voice-store, which is documented as a thin
 * mirror of the engine's VoiceState and must own no ad-hoc view booleans (§11).
 *
 * "What's on the stage" is DERIVED, not stored: given the live sources plus
 * `focusedKey`, `resolveStage` (@demli/media) resolves stage/filmstrip/grid
 * each render. Storing only `focusedKey` (an opaque, stable tile key) keeps a
 * single knob instead of scattered booleans — a stale key simply falls back to
 * the default.
 *
 * ── The overlay is ONE box, with a SUBJECT ────────────────────────────────────
 * There used to be a single role for the floating overlay ("pin some camera over
 * a screen share"), and the founder's self-view request would naively have added
 * a second draggable box — two overlays, two positions, two drag layers, both
 * fighting for the same corner. So the overlay was generalised instead of
 * duplicated (founder: "iki ayrı sürüklenebilir kutu yapma"):
 *
 *   pipSourceKey === null  → SELF-VIEW (the default): your own camera, or the
 *                            "camera off" placeholder when it is not on — the
 *                            founder must be able to SEE that it is off.
 *   pipSourceKey !== null  → that specific camera, pinned by the user from the
 *                            camera panel while watching a broadcast.
 *
 * `pipEnabled` and the position are PERSISTED (K4: "varsayılan açık", corner
 * preference remembered); `pipSourceKey` is not — a pin is a per-session choice
 * and reviving one for a camera that may not exist next call would be a bug.
 *
 * Position is stored as a fraction of free travel (0 = flush to the top/left
 * margin, 1 = flush to the bottom/right margin) so it is resolution-independent
 * and survives window/stage resizes; the drag layer snaps it to the nearest
 * corner on release.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Default overlay anchor: BOTTOM-RIGHT — the founder's literal request ("sağ
 * altta benim kameram gözükmeli"), and the corner that covers the least of a
 * 16:9 stage.
 */
const DEFAULT_PIP_X = 1;
const DEFAULT_PIP_Y = 1;

/** localStorage key for the remembered self-view preference (on/off + corner). */
const STAGE_OVERLAY_STORAGE_KEY = "demli.stage-overlay";

/**
 * Default camera-panel width as a fraction of the stage area (the right rail
 * shown while watching a screen-share). Clamped to [MIN_PX, MAX_FRAC] at render so
 * the panel never collapses below a legible camera tile or eats the stream.
 */
const DEFAULT_CAMERA_PANEL_WIDTH = 0.24;
/** Camera-panel min width in px (a legible 16:9 camera tile). */
export const CAMERA_PANEL_MIN_PX = 180;
/** Camera-panel max width as a fraction of the stage area. */
export const CAMERA_PANEL_MAX_FRAC = 0.4;

interface VideoStageState {
  /**
   * Opaque key of the explicitly-focused (pinned) stage tile. `null` = default:
   * the first remote screen-share is the stage, or — with no screen-share — the
   * grid. A key that no longer resolves to a live tile is treated as `null` at
   * render time.
   */
  focusedKey: string | null;
  /** Hide the camera panel/filmstrip while watching a screen-share. */
  filmstripCollapsed: boolean;
  /**
   * Camera-panel width as a fraction of the stage area (the right rail).
   * Stored resolution-independent (a fraction, like the overlay position) so it
   * survives window/stage resizes; clamped to [CAMERA_PANEL_MIN_PX,
   * CAMERA_PANEL_MAX_FRAC] against the measured width at render + drag time.
   */
  cameraPanelWidth: number;
  /** Expand the stage to fill the whole window. */
  fullscreen: boolean;
  /**
   * Show the single floating stage overlay. Default ON (K4) and PERSISTED: the
   * self-view is a standing expectation, not something to re-enable every call.
   */
  pipEnabled: boolean;
  /**
   * The overlay's subject: `null` = the SELF-VIEW (default), otherwise the key of
   * a specific camera the user pinned from the camera panel. Session-scoped.
   */
  pipSourceKey: string | null;
  /** Overlay horizontal position, fraction of free travel 0..1 (left..right). */
  pipX: number;
  /** Overlay vertical position, fraction of free travel 0..1 (top..bottom). */
  pipY: number;
}

interface VideoStageStore extends VideoStageState {
  /** Promote a tile to the stage (clicking a tile). */
  focus: (key: string) => void;
  /** Return to the default stage (grid / screen-share auto-stage). */
  clearFocus: () => void;
  /** Focus a tile, or clear focus if it is already focused (click-to-toggle). */
  toggleFocus: (key: string) => void;
  setFilmstripCollapsed: (collapsed: boolean) => void;
  toggleFilmstrip: () => void;
  /** Persist a camera-panel width (fraction of stage area, clamped 0..1). */
  setCameraPanelWidth: (fraction: number) => void;
  setFullscreen: (fullscreen: boolean) => void;
  toggleFullscreen: () => void;
  /** Show/hide the floating overlay entirely. */
  togglePip: () => void;
  /**
   * Pin a specific camera into the overlay (also switches the overlay on).
   * Re-pinning the camera that is already showing returns the overlay to the
   * SELF-VIEW rather than switching it off — "unpin" means "give me my own
   * camera back", and the on/off switch lives in the toolbar.
   */
  setPipSource: (key: string) => void;
  /** Return the overlay to the self-view subject. */
  clearPipSource: () => void;
  /** Persist an overlay position (fractions of free travel, clamped 0..1). */
  setPipPosition: (x: number, y: number) => void;
  /**
   * Reset the per-session view knobs — called when the stage tears down (voice
   * ends). The PERSISTED self-view preference (on/off + corner) deliberately
   * survives: it is a user setting, not session state.
   */
  reset: () => void;
}

/** Knobs that belong to one call and are cleared when it ends. */
const sessionState: Pick<
  VideoStageState,
  "focusedKey" | "filmstripCollapsed" | "cameraPanelWidth" | "fullscreen" | "pipSourceKey"
> = {
  focusedKey: null,
  filmstripCollapsed: false,
  cameraPanelWidth: DEFAULT_CAMERA_PANEL_WIDTH,
  fullscreen: false,
  pipSourceKey: null,
};

const initialState: VideoStageState = {
  ...sessionState,
  pipEnabled: true,
  pipX: DEFAULT_PIP_X,
  pipY: DEFAULT_PIP_Y,
};

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

export const useVideoStageStore = create<VideoStageStore>()(
  persist(
    (set, get) => ({
      ...initialState,

      focus: (key) => set({ focusedKey: key }),
      clearFocus: () => set({ focusedKey: null }),
      toggleFocus: (key) => set((s) => ({ focusedKey: s.focusedKey === key ? null : key })),

      setFilmstripCollapsed: (collapsed) => set({ filmstripCollapsed: collapsed }),
      toggleFilmstrip: () => set((s) => ({ filmstripCollapsed: !s.filmstripCollapsed })),
      setCameraPanelWidth: (fraction) => set({ cameraPanelWidth: clamp01(fraction) }),

      setFullscreen: (fullscreen) => set({ fullscreen }),
      toggleFullscreen: () => set((s) => ({ fullscreen: !s.fullscreen })),

      togglePip: () => set((s) => ({ pipEnabled: !s.pipEnabled })),
      setPipSource: (key) => {
        const { pipSourceKey, pipEnabled } = get();
        // Re-pinning the camera already showing hands the overlay back to the
        // self-view; the overlay itself stays on (the toolbar owns on/off).
        if (pipEnabled && pipSourceKey === key) {
          set({ pipSourceKey: null });
          return;
        }
        set({ pipEnabled: true, pipSourceKey: key });
      },
      clearPipSource: () => set({ pipSourceKey: null }),
      setPipPosition: (x, y) => set({ pipX: clamp01(x), pipY: clamp01(y) }),

      reset: () => set({ ...sessionState }),
    }),
    {
      name: STAGE_OVERLAY_STORAGE_KEY,
      // ONLY the self-view preference is remembered. Focus, fullscreen and a
      // pinned camera are per-call state; restoring them into the next call would
      // put the user in a layout they never asked for.
      partialize: (s) => ({ pipEnabled: s.pipEnabled, pipX: s.pipX, pipY: s.pipY }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<VideoStageState>;
        return {
          ...current,
          pipEnabled: typeof p.pipEnabled === "boolean" ? p.pipEnabled : current.pipEnabled,
          pipX: typeof p.pipX === "number" ? clamp01(p.pipX) : current.pipX,
          pipY: typeof p.pipY === "number" ? clamp01(p.pipY) : current.pipY,
        };
      },
    },
  ),
);
