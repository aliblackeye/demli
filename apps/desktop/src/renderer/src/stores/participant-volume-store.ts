/**
 * Persisted per-user playback volumes (kişi-başı ses seviyesi) — keyed by userId.
 *
 * This store is PURE PERSISTENCE. The voice engine (@demli/media) is the runtime
 * source of truth for volumes (CLAUDE.md §11): at startup the voice store seeds the
 * engine from this store's `volumes`, and every change is written back here
 * (write-through) so a level survives a relaunch and re-applies the moment that user
 * is next in voice.
 *
 * The DATA SHAPE ({@link ParticipantVolumeMap}), the clamp range, the normalizer,
 * and the storage KEY all come from @demli/media, so the (later) MOBILE store
 * mirrors this exact contract — only the persistence I/O differs per platform
 * (localStorage here, AsyncStorage/MMKV on mobile). Same home as media-settings.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  clampParticipantVolume,
  isDefaultParticipantVolume,
  normalizeParticipantVolumes,
  PARTICIPANT_VOLUME_STORAGE_KEY,
  type ParticipantVolumeMap,
} from "@demli/media";

interface ParticipantVolumeState {
  /** userId → 0..2; only NON-default (≠ 100%) levels are kept. */
  volumes: ParticipantVolumeMap;
  /** Write-through a new level (clamped; a 100% level prunes the entry). */
  setVolume: (userId: string, volume: number) => void;
}

export const useParticipantVolumes = create<ParticipantVolumeState>()(
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
      name: PARTICIPANT_VOLUME_STORAGE_KEY,
      partialize: (s) => ({ volumes: s.volumes }),
      // Never trust storage blindly — normalize an untrusted/legacy blob through
      // the media package's guard (clamps, drops junk + redundant 100% entries).
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<ParticipantVolumeState>;
        return { ...current, volumes: normalizeParticipantVolumes(p.volumes) };
      },
    },
  ),
);

/**
 * Snapshot of the persisted volumes for SEEDING the engine at construction. Read
 * synchronously at module load (zustand `persist` rehydrates localStorage
 * synchronously), so the engine has every saved level before the first join.
 */
export function loadPersistedParticipantVolumes(): ParticipantVolumeMap {
  return useParticipantVolumes.getState().volumes;
}
