/**
 * Per-participant playback volume (kişi-başı ses seviyesi).
 *
 * A LISTENER-side, client-only control: each user independently turns any OTHER
 * participant's voice up or down (0–200%). It never touches the sender or the
 * SFU — the web adapter scales that remote's own audio elements (livekit
 * `RemoteParticipant.setVolume`), so NO media ever crosses the WebSocket gateway
 * (CLAUDE.md §10/§35). It is a personal offset that is orthogonal to deafen:
 * deafen is a master mute (all remotes → 0); per-user volume is what undeafen
 * restores each remote to.
 *
 * This module is PLATFORM-AGNOSTIC and livekit-free so desktop AND (later) mobile
 * share ONE contract: the clamp range, the 100% default, the persistence key, and
 * the normalizer for an untrusted persisted blob. The engine holds the RUNTIME map
 * (seeded via `createVoiceEngine({ initialParticipantVolumes })`, re-applied on
 * (re)join) and is the single source of truth (§11); each platform owns only the
 * persistence I/O (localStorage / AsyncStorage) keyed by user id.
 */

/** Fully muted for this listener (personal) — distinct from deafen (master mute). */
export const MIN_PARTICIPANT_VOLUME = 0;
/** 200% boost ceiling — the top of the per-user slider. */
export const MAX_PARTICIPANT_VOLUME = 2;
/** 100% — unchanged playback; assumed for anyone without a stored level. */
export const DEFAULT_PARTICIPANT_VOLUME = 1;

/**
 * Storage key both platforms persist the map under (localStorage on desktop,
 * AsyncStorage/MMKV on mobile). Shared so the clients agree on where levels live.
 */
export const PARTICIPANT_VOLUME_STORAGE_KEY = "demli.participant-volumes";

/**
 * Storage key for the SEPARATE per-share (screen-share / film) audio levels —
 * A participant's VOICE and what they are BROADCASTING are scaled separately, so a
 * viewer can turn the FILM up/down without touching the sharer's mic (and vice-versa).
 * Same map shape, clamp range, default and 0-trap normalizer as the voice levels
 * above (reuse {@link normalizeParticipantVolumes}); only the storage key and the
 * livekit track source (`screen_share_audio`) differ. Keyed by the sharer's userId.
 */
export const SCREEN_SHARE_VOLUME_STORAGE_KEY = "demli.screenshare-volumes";

/** userId → playback volume in [0,2]. An ABSENT key means DEFAULT (100%). */
export type ParticipantVolumeMap = Record<string, number>;

/** Clamp any number into [0,2]; non-finite input falls back to the 100% default. */
export function clampParticipantVolume(volume: number): number {
  if (!Number.isFinite(volume)) return DEFAULT_PARTICIPANT_VOLUME;
  if (volume < MIN_PARTICIPANT_VOLUME) return MIN_PARTICIPANT_VOLUME;
  if (volume > MAX_PARTICIPANT_VOLUME) return MAX_PARTICIPANT_VOLUME;
  return volume;
}

/** True when a level is (near) the 100% default — used to prune redundant entries. */
export function isDefaultParticipantVolume(volume: number): boolean {
  return Math.abs(volume - DEFAULT_PARTICIPANT_VOLUME) < 1e-6;
}

/**
 * Validate/repair an untrusted persisted blob into a clean map: keep only
 * string→finite-number entries, clamp each to [0,2], and DROP default (100%)
 * entries so storage never accumulates redundant "1"s. Never throws — a corrupt
 * or legacy blob yields an empty map (everyone at 100%).
 *
 * A (near-)ZERO entry is also dropped: 0% is a MUTE, and silently re-applying it
 * on the next app launch is a trap — the founder's live "sevgilim konuşuyor ama
 * sesi gelmiyor" incident was exactly a test-drag to 0 persisting across
 * sessions. Muting via the slider therefore lasts for the session; a restart
 * brings everyone back audible. (In-session 0 still works — this only filters
 * what gets RE-LOADED.)
 */
export function normalizeParticipantVolumes(raw: unknown): ParticipantVolumeMap {
  const out: ParticipantVolumeMap = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || typeof value !== "number" || !Number.isFinite(value)) continue;
    const clamped = clampParticipantVolume(value);
    if (isDefaultParticipantVolume(clamped)) continue;
    if (clamped <= MIN_PARTICIPANT_VOLUME + 1e-6) continue; // persisted mute = trap
    out[key] = clamped;
  }
  return out;
}
