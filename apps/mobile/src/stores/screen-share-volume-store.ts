/**
 * Persisted per-SHARE (screen-share / film) audio volumes — keyed by the sharer's
 * userId. Mobile mirror of the desktop screen-share-volume-store and of this
 * folder's participant-volume-store: the separate-from-voice half of the
 * voice/share volume split (task #82), so a viewer can turn the movie up/down
 * without changing how loud that person's mic is.
 *
 * Pure persistence; the voice engine (@demli/media) is the runtime source of
 * truth (CLAUDE.md §11). Reuses `expo-secure-store` (no new native module → OTA
 * stays intact) and the media package's clamp/normalizer/storage-key — including
 * the 0-drop-on-reload guard so a muted film never silently survives a restart.
 * Rehydration is ASYNC, so the voice store re-seeds the engine on
 * `persist.onFinishHydration`.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { secureStorage } from "../lib/secure-storage";
import {
  clampParticipantVolume,
  isDefaultParticipantVolume,
  normalizeParticipantVolumes,
  SCREEN_SHARE_VOLUME_STORAGE_KEY,
  type ParticipantVolumeMap,
} from "@demli/media";

interface ScreenShareVolumeState {
  /** sharerUserId → 0..2; only NON-default (≠ 100%) levels are kept. */
  volumes: ParticipantVolumeMap;
  /** Write-through a new film level (clamped; a 100% level prunes the entry). */
  setVolume: (userId: string, volume: number) => void;
}

export const useScreenShareVolumes = create<ScreenShareVolumeState>()(
  persist(
    (set) => ({
      volumes: {},
      setVolume: (userId, volume) =>
        set((s) => {
          const clamped = clampParticipantVolume(volume);
          const next = { ...s.volumes };
          if (isDefaultParticipantVolume(clamped)) delete next[userId];
          else next[userId] = clamped;
          return { volumes: next };
        }),
    }),
    {
      name: SCREEN_SHARE_VOLUME_STORAGE_KEY,
      storage: createJSONStorage(() => secureStorage),
      partialize: (s) => ({ volumes: s.volumes }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<ScreenShareVolumeState>;
        return { ...current, volumes: normalizeParticipantVolumes(p.volumes) };
      },
    },
  ),
);

/** Snapshot of the persisted film levels for SEEDING the engine (see the voice store). */
export function loadPersistedScreenShareVolumes(): ParticipantVolumeMap {
  return useScreenShareVolumes.getState().volumes;
}
