/**
 * Watch-party sessions, as this client knows them (M20, ADR 0016).
 *
 * ONE session per voice channel, keyed by `channelId` — the same key the server
 * uses, so there is no client-side identity to keep in step. Everything in here
 * is a projection of server frames; nothing is ever authored locally. The three
 * server→client lifecycle frames map to exactly three actions:
 *
 *   `watch.started` / `watch.state`  → {@link WatchPartyStore.upsert}
 *   `watch.host_changed`             → {@link WatchPartyStore.setHost}
 *   `watch.stopped`                  → {@link WatchPartyStore.stop}
 *
 * `watch.started` is an UPSERT, not a "just began" notification (ADR 0016
 * deviation 3): it is also the (re)connect snapshot, so a client that missed the
 * opening frame — or lost its socket mid-party — re-seats on server truth by
 * taking the exact same path a fresh start takes. There is deliberately no
 * "first frame" branch anywhere in this file.
 *
 * §27: the 5 s heartbeat writes here every tick for an active room, so the
 * selectors are per-channel and the components that subscribe are the PLAYER and
 * its control row only. `useWatchSession(null)` — every surface with no party
 * running — reads a stable `null` and never re-renders on a heartbeat.
 */

import { create } from "zustand";
import type {
  WatchQueueItem,
  WatchSessionStatePayload,
  WatchStoppedReason,
} from "@demli/protocol";
import type { ChannelId, UserId } from "@demli/types";
import { sessionFromPayload, type WatchSession } from "@demli/client-core";

/**
 * A refusal the gateway sent us. Only the codes that are EXCLUSIVELY watch-party
 * (`apps/realtime/src/watch-party.ts` is their only emitter) are routed here — a
 * `error.raised` frame carries no correlation id, so attributing a shared code
 * like `INVALID_PAYLOAD` to this feature would mean guessing, and a wrong
 * explanation is worse than a generic one (§26).
 *
 * `WATCH_QUEUE_FULL` joined the set with the queue panel (wave 3). It is the one
 * refusal a user can act on directly — remove something and try again — so it
 * would be the worst of the four to swallow into a console warning.
 */
export type WatchRefusal =
  | "NOT_IN_VOICE"
  | "NOT_HOST"
  | "WATCH_NOT_ACTIVE"
  | "WATCH_QUEUE_FULL";

interface WatchPartyState {
  /** Live sessions by voice-channel id. Absent key = no party in that channel. */
  sessions: Record<string, WatchSession>;
  /**
   * Queues by voice-channel id, newest server truth. A SEPARATE slice from
   * `sessions` on purpose (§27): the 5 s heartbeat rewrites `sessions` every
   * tick, and a queue panel that read the queue off the session object would
   * re-render twelve times a minute for a list that changed on none of them.
   * `watch.queue_updated` is the only writer here, and the server only sends it
   * when the queue actually changed.
   */
  queues: Record<string, WatchQueueItem[]>;
  /**
   * videoId → title, per channel, so the panel can name the video playing RIGHT
   * NOW.
   *
   * The session frame carries only an id — titles exist solely on queue items,
   * and an item is REMOVED from the queue the moment it starts playing. Without
   * this, the one video everybody is actually looking at would be the only one
   * the panel could not name.
   *
   * Bounded by construction: rebuilt from the queue on every update, keeping
   * only the entry for the currently-playing video on top of it. So it holds at
   * most `WATCH_QUEUE_MAX_ITEMS + 1` strings per channel and self-cleans as the
   * queue drains — no eviction policy to get wrong.
   */
  titles: Record<string, Record<string, string>>;
  /**
   * The last refusal, with the channel it concerned so a stale message cannot
   * surface on a different room's player. Cleared by the UI once shown.
   */
  refusal: { channelId: ChannelId; code: WatchRefusal } | null;
}

interface WatchPartyActions {
  /** Apply a `watch.started` / `watch.state` snapshot. */
  upsert: (payload: WatchSessionStatePayload, receivedAtMs?: number) => void;
  /** Apply `watch.host_changed` — explicit transfer or automatic handoff. */
  setHost: (channelId: ChannelId, hostId: UserId) => void;
  /** Apply `watch.queue_updated` — the server's complete queue for that room. */
  setQueue: (channelId: ChannelId, queue: WatchQueueItem[]) => void;
  /** Apply `watch.stopped` — the session is gone, the stage must clear. */
  stop: (channelId: ChannelId, reason: WatchStoppedReason) => void;
  /** Record a gateway refusal for this channel. */
  refuse: (channelId: ChannelId, code: WatchRefusal) => void;
  /** Dismiss the current refusal (the UI showed it). */
  clearRefusal: () => void;
  /** Drop everything — sign-out / account switch. */
  reset: () => void;
}

export type WatchPartyStore = WatchPartyState & WatchPartyActions;

const EMPTY: WatchPartyState = { sessions: {}, queues: {}, titles: {}, refusal: null };

/**
 * The queue a room with no queue has.
 *
 * A module-level constant, not `[]` inline: a zustand selector that built a
 * fresh array on every call would return a new reference every time the store
 * changed for ANY reason, and the panel would re-render on every heartbeat —
 * exactly what the separate `queues` slice exists to prevent.
 */
const NO_QUEUE: WatchQueueItem[] = [];

export const useWatchPartyStore = create<WatchPartyStore>()((set) => ({
  ...EMPTY,

  upsert: (payload, receivedAtMs = Date.now()) =>
    set((state) => ({
      sessions: {
        ...state.sessions,
        [payload.channelId]: sessionFromPayload(payload, receivedAtMs),
      },
      // A snapshot landing means the session is alive and reachable, so any
      // refusal we were still showing for that room is stale.
      refusal: state.refusal?.channelId === payload.channelId ? null : state.refusal,
    })),

  setHost: (channelId, hostId) =>
    set((state) => {
      const session = state.sessions[channelId];
      // A host change for a session we do not hold is not an error — we may not
      // have received (or may have already dropped) the snapshot. The next
      // heartbeat carries `hostId` anyway, so there is nothing to reconstruct.
      if (!session || session.hostId === hostId) return state;
      return { sessions: { ...state.sessions, [channelId]: { ...session, hostId } } };
    }),

  setQueue: (channelId, queue) =>
    set((state) => {
      const playingId = state.sessions[channelId]?.videoId ?? null;
      const previous = state.titles[channelId];
      const next: Record<string, string> = {};
      // Carry the playing video's title forward FIRST, then let the queue write
      // over it — an item still queued is the more current statement of its own
      // title, and the carried entry is only there to survive the removal that
      // happens when a video starts.
      if (playingId !== null && previous?.[playingId] !== undefined) {
        next[playingId] = previous[playingId];
      }
      for (const item of queue) {
        if (item.title !== null) next[item.videoId] = item.title;
      }
      return {
        queues: { ...state.queues, [channelId]: queue },
        titles: { ...state.titles, [channelId]: next },
      };
    }),

  stop: (channelId) =>
    set((state) => {
      if (!(channelId in state.sessions) && !(channelId in state.queues)) return state;
      const sessions = { ...state.sessions };
      delete sessions[channelId];
      // The queue dies WITH the session. It is server-side state that no longer
      // exists, so keeping it would mean a fresh party in the same room opening
      // with the previous one's leftovers on screen until the first
      // `watch.queue_updated` overwrote them.
      const queues = { ...state.queues };
      delete queues[channelId];
      const titles = { ...state.titles };
      delete titles[channelId];
      return {
        sessions,
        queues,
        titles,
        refusal: state.refusal?.channelId === channelId ? null : state.refusal,
      };
    }),

  refuse: (channelId, code) => set({ refusal: { channelId, code } }),
  clearRefusal: () => set({ refusal: null }),
  reset: () => set({ ...EMPTY }),
}));

/**
 * The session running in `channelId`, or null.
 *
 * Returns the stored object by reference, so a heartbeat that changes nothing
 * this component reads still re-renders it — that is intended for the PLAYER
 * (it needs every position restatement) and is why no other surface should call
 * this hook. Ask {@link useHasWatchParty} instead when all you need is a badge.
 */
export function useWatchSession(channelId: ChannelId | null): WatchSession | null {
  return useWatchPartyStore((s) => (channelId ? (s.sessions[channelId] ?? null) : null));
}

/**
 * Whether a party is running in `channelId` — a BOOLEAN, so the 5 s heartbeat
 * re-renders nothing (§27). This is what channel rows and toolbars subscribe to.
 */
export function useHasWatchParty(channelId: ChannelId | null): boolean {
  return useWatchPartyStore((s) => (channelId ? s.sessions[channelId] !== undefined : false));
}

/**
 * The queue for `channelId` — a STABLE reference when there is none, so a room
 * with no queue never re-renders its panel on an unrelated store write (§27).
 */
export function useWatchQueue(channelId: ChannelId | null): WatchQueueItem[] {
  return useWatchPartyStore((s) => (channelId ? (s.queues[channelId] ?? NO_QUEUE) : NO_QUEUE));
}

/**
 * The known title of `videoId` in `channelId`, or null.
 *
 * A string (or null) rather than an object, so this subscribes to a primitive
 * and the 5 s heartbeat re-renders nothing through it (§27).
 */
export function useWatchVideoTitle(
  channelId: ChannelId | null,
  videoId: string | null,
): string | null {
  return useWatchPartyStore((s) =>
    channelId && videoId ? (s.titles[channelId]?.[videoId] ?? null) : null,
  );
}

/** The pending refusal for `channelId`, or null. */
export function useWatchRefusal(channelId: ChannelId | null): WatchRefusal | null {
  return useWatchPartyStore((s) =>
    channelId && s.refusal?.channelId === channelId ? s.refusal.code : null,
  );
}
