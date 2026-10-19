/**
 * Persisted per-SHARE (screen-share / film) audio volumes — keyed by the sharer's
 * userId. The separate-from-voice half of the voice/share volume split: a
 * viewer can turn a broadcast's sound up/down WITHOUT changing how loud that
 * person's mic is.
 *
 * Pure persistence, mirroring participant-volume-store exactly: the voice engine
 * (@demli/media) is the runtime source of truth (CLAUDE.md §11); at startup the
 * voice store seeds the engine from this store's `volumes`, and every change is
 * written back (write-through) so a saved film level survives a relaunch. The data
 * shape, clamp range, normalizer (which DROPS a persisted 0 — the mute-trap guard)
 * and the storage KEY all come from @demli/media; only the localStorage I/O is
 * platform-specific.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  clampParticipantVolume,
  ELEMENT_PLAYBACK_MAX_VOLUME,
  isDefaultParticipantVolume,
  normalizeParticipantVolumes,
  SCREEN_SHARE_VOLUME_STORAGE_KEY,
  type ParticipantVolumeMap,
} from "@demli/media";

interface ScreenShareVolumeState {
  /** sharerUserId → 0..1 (element playback ceiling); only non-default levels are kept. */
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
          const clamped = clampParticipantVolume(volume, ELEMENT_PLAYBACK_MAX_VOLUME);
          const next = { ...s.volumes };
          if (isDefaultParticipantVolume(clamped)) delete next[userId];
          else next[userId] = clamped;
          return { volumes: next };
        }),
    }),
    {
      name: SCREEN_SHARE_VOLUME_STORAGE_KEY,
      partialize: (s) => ({ volumes: s.volumes }),
      // Normalize an untrusted/legacy blob through the media guard: clamps, drops
      // junk + redundant 100%s AND drops a persisted 0 (a muted film must not
      // silently survive a relaunch — the founder's volume-0 lesson).
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<ScreenShareVolumeState>;
        return {
          ...current,
          volumes: normalizeParticipantVolumes(p.volumes, ELEMENT_PLAYBACK_MAX_VOLUME),
        };
      },
    },
  ),
);

/** Snapshot of the persisted film levels for SEEDING the engine at construction. */
export function loadPersistedScreenShareVolumes(): ParticipantVolumeMap {
  return useScreenShareVolumes.getState().volumes;
}
