/**
 * Voice-channel OCCUPANCY store — the mobile mirror of the desktop renderer's
 * stores/voice-occupancy-store.ts. WHO is currently connected to each voice
 * channel across the servers this user can see — the member list rendered under
 * a voice channel in the sidebar.
 *
 * A DIRECTORY concern, deliberately separate from `voice-store.ts` (a strict
 * mirror of the LiveKit engine's OWN-room state — participants, speaking, mic —
 * which must not hold ad-hoc voice state, CLAUDE.md §11). Closer to the chat
 * store's presence/typing maps: volatile, realtime-fed, keyed so a tick in one
 * channel never rerenders another.
 *
 * Fed entirely by the gateway/server (server-authoritative), via
 * realtime/connection.ts:
 * - `seed`         ← the `auth.succeeded` `voiceOccupancy` snapshot (connect /
 *                    reconnect), so occupancy renders immediately and self-heals.
 * - `resync`       ← the AUTHORITATIVE media-plane snapshot (the `voice.resync`
 *                    gateway event on every (re)connect + the `GET /voice/occupancy`
 *                    pull when the app returns to the foreground). REPLACES
 *                    per-channel occupancy so a missed join/leave/screen-share delta
 *                    can never leave a permanent desync.
 * - `addOccupant`  ← `voice.participant_joined` delta.
 * - `removeOccupant` ← `voice.participant_left` delta (incl. single-session
 *                    eviction, which the gateway broadcasts as a leave).
 *
 * Visibility is enforced server-side: the gateway/API only sends deltas/snapshots
 * for voice channels this connection may see.
 */
import { create } from "zustand";
import type {
  VoiceChannelOccupants,
  VoiceOccupancySnapshot,
  VoiceOccupant,
} from "@demli/protocol";
import type { ChannelId, UserId } from "@demli/types";

/** Stable empty reference so `byChannel[id] ?? EMPTY` selectors never churn. */
export const NO_OCCUPANTS: readonly VoiceOccupant[] = Object.freeze([]);

/**
 * Build a fresh `byChannel` map from an occupancy snapshot. Only OCCUPIED channels
 * are kept — an absent channel is authoritatively empty. Occupants are copied so
 * the store never aliases the decoded payload; the spread preserves the optional
 * `screenSharing`/`camera` media-plane fields when the authoritative snapshot
 * (resync / focus pull) carries them, while the in-memory `seed` simply omits them.
 */
function snapshotToByChannel(
  channels: VoiceChannelOccupants[],
): Record<ChannelId, VoiceOccupant[]> {
  const byChannel: Record<ChannelId, VoiceOccupant[]> = {};
  for (const { channelId, occupants } of channels) {
    if (occupants.length > 0) byChannel[channelId] = occupants.map((o) => ({ ...o }));
  }
  return byChannel;
}

interface VoiceOccupancyStore {
  /** voiceChannelId → occupants currently connected to it (deduped by userId). */
  byChannel: Record<ChannelId, VoiceOccupant[]>;
  /** Replace the whole map from an `auth.succeeded` snapshot (connect/reconnect). */
  seed: (channels: VoiceChannelOccupants[]) => void;
  /**
   * REPLACE the whole map from an AUTHORITATIVE media-plane snapshot (`voice.resync`
   * event / `GET /voice/occupancy`). Identical replace-all semantics to `seed`
   * (channels not in the snapshot are cleared), in a SINGLE setState (§27) so a
   * re-seat never fans out per-channel renders — the authoritative truth that heals
   * any occupancy/screen-share desync a missed delta left behind.
   */
  resync: (channels: VoiceChannelOccupants[]) => void;
  /** A member joined a voice channel — append (or update `muted`), deduped. */
  addOccupant: (channelId: ChannelId, userId: UserId, muted: boolean) => void;
  /** A member left a voice channel — drop them; prune the key when it empties. */
  removeOccupant: (channelId: ChannelId, userId: UserId) => void;
  /** Clear everything (logout / realtime teardown). */
  reset: () => void;
}

export const useVoiceOccupancyStore = create<VoiceOccupancyStore>()((set) => ({
  byChannel: {},

  seed: (channels) => set(() => ({ byChannel: snapshotToByChannel(channels) })),

  resync: (channels) => set(() => ({ byChannel: snapshotToByChannel(channels) })),

  addOccupant: (channelId, userId, muted) =>
    set((state) => {
      const current = state.byChannel[channelId] ?? [];
      const existing = current.find((o) => o.userId === userId);
      // Idempotent: a re-announce (WS reconnect) or a duplicate join with the same
      // muted state changes nothing — keep the reference so selectors don't churn.
      if (existing && existing.muted === muted) return state;
      const next = existing
        ? current.map((o) => (o.userId === userId ? { userId, muted } : o))
        : [...current, { userId, muted }];
      return { byChannel: { ...state.byChannel, [channelId]: next } };
    }),

  removeOccupant: (channelId, userId) =>
    set((state) => {
      const current = state.byChannel[channelId];
      if (!current || !current.some((o) => o.userId === userId)) return state;
      const next = current.filter((o) => o.userId !== userId);
      const byChannel = { ...state.byChannel };
      if (next.length > 0) byChannel[channelId] = next;
      else delete byChannel[channelId];
      return { byChannel };
    }),

  reset: () => set({ byChannel: {} }),
}));

// ---------------------------------------------------------------------------
// App-focus occupancy pull (state-resync HTTP path)
//
// On top of the `voice.resync` gateway event (pushed on every reconnect), the
// client PULLS the same authoritative snapshot over HTTP when the app regains
// focus (mobile AppState "active" / desktop window focus), catching any desync
// accrued while the app was in the background. Shared, dependency-injected policy
// so desktop + mobile stay identical and this stays unit-testable without the
// platform connection singleton.
// ---------------------------------------------------------------------------

/** Minimum gap between focus-triggered occupancy pulls (throttle, ms). */
export const OCCUPANCY_PULL_THROTTLE_MS = 15_000;

/** Injected collaborators for {@link createThrottledOccupancyPull}. */
export interface OccupancyPullDeps {
  /** Fetch the authoritative snapshot — `GET /voice/occupancy`. */
  fetchSnapshot: () => Promise<VoiceOccupancySnapshot>;
  /** Apply an authoritative snapshot — the store's `resync` (REPLACE). */
  resync: (channels: VoiceChannelOccupants[]) => void;
  /**
   * Called on ANY fetch failure (incl. 503 `VOICE_OCCUPANCY_UNAVAILABLE`) so the
   * caller can log. The current view is ALWAYS kept — `resync` is never called on
   * error, so occupancy is never cleared when a snapshot can't be produced (§26).
   */
  onError?: (error: unknown) => void;
  /** Clock injection for tests (default `Date.now`). */
  now?: () => number;
}

/** A throttled occupancy puller: `pull()` on focus, `reset()` on a new session. */
export interface ThrottledOccupancyPull {
  /**
   * Pull the authoritative snapshot and REPLACE the store — throttled to at most
   * one request per {@link OCCUPANCY_PULL_THROTTLE_MS}, so a focus/blur flurry
   * makes a single call. Keeps the current view on any error (never clears).
   */
  pull: () => Promise<void>;
  /** Drop the throttle clock so the next `pull()` fires immediately (new session). */
  reset: () => void;
}

/**
 * Build a throttled "pull authoritative occupancy over HTTP and REPLACE the store"
 * function, shared by desktop (window focus) and mobile (AppState active). Pure
 * aside from its injected collaborators, so it unit-tests the throttle + the
 * keep-current-view-on-error contract without importing the connection singleton.
 */
export function createThrottledOccupancyPull(
  deps: OccupancyPullDeps,
): ThrottledOccupancyPull {
  const now = deps.now ?? (() => Date.now());
  // -Infinity so the first pull of a session always fires, independent of the
  // clock's base value (also what `reset` restores to).
  let lastPullAt = Number.NEGATIVE_INFINITY;

  return {
    async pull() {
      const at = now();
      if (at - lastPullAt < OCCUPANCY_PULL_THROTTLE_MS) return;
      lastPullAt = at;
      try {
        const snapshot = await deps.fetchSnapshot();
        deps.resync(snapshot.channels);
      } catch (error) {
        // KEEP the current view — never resync/clear when a snapshot can't be
        // produced (503 or transport). A later resync/focus heals it (§26).
        deps.onError?.(error);
      }
    },
    reset() {
      lastPullAt = Number.NEGATIVE_INFINITY;
    },
  };
}
