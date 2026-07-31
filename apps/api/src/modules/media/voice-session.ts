/**
 * Single-active-voice-session tracking + cross-room eviction: a user is in AT
 * MOST one voice room across all their devices.
 *
 * When the API issues a media token (a join), it records the user's active voice
 * room in Redis. If they already had a session in a DIFFERENT room, that previous
 * session is evicted: the SFU participant is force-removed (RoomServiceClient) and
 * a typed `voice.session_replaced` event is published to the user's OTHER
 * connections so the evicted device leaves cleanly (FSM → idle) and shows a
 * localized notice — no "voice server unavailable" error.
 *
 * The DECISION is pure and unit-tested ({@link shouldEvictVoiceSession}); the I/O
 * (Redis + LiveKit admin + realtime bus) is wrapped so a failure NEVER fails the
 * join — the token is the source of truth, and the LiveKit disconnect the evicted
 * client receives already drives its clean leave even if the event is missed.
 */

import type { RoomServiceClient } from "livekit-server-sdk";
import type { RealtimeMutationPublisher, RedisClient } from "@demli/db";
import { serverEvent } from "@demli/protocol";

/** Redis key holding the voice room a user's active session is in. */
export function voiceSessionKey(userId: string): string {
  return `voice:session:${userId}`;
}

/**
 * The eviction decision (PURE, unit-tested). Evict the user's previous voice
 * session ONLY when they are joining a DIFFERENT room from another device:
 *  - no previous session      → nothing to evict (false)
 *  - previous === new room    → NOT a cross-room move: a reconnect, a retry, or a
 *    second device joining the SAME room (LiveKit's own duplicate-identity
 *    handling covers that case). No server-side eviction (false).
 *  - previous !== new room    → the user moved rooms/devices → evict (true).
 *
 * This is exactly the reconnect-vs-new-join safeguard: a LiveKit reconnect reuses
 * the same token/room and never re-hits this endpoint, and a genuine rejoin of the
 * SAME room compares equal — so neither self-evicts.
 */
export function shouldEvictVoiceSession(
  previousRoom: string | null,
  newRoom: string,
): boolean {
  return previousRoom !== null && previousRoom !== newRoom;
}

/**
 * Convert a LiveKit `ws(s)://` client URL to the `http(s)://` host the server SDK
 * (`RoomServiceClient`) expects. Anything already http(s) or otherwise shaped is
 * returned unchanged.
 */
export function livekitHttpUrl(url: string): string {
  if (url.startsWith("wss:")) return `https:${url.slice("wss:".length)}`;
  if (url.startsWith("ws:")) return `http:${url.slice("ws:".length)}`;
  return url;
}

export interface VoiceSessionRegistryDeps {
  redis: RedisClient;
  /** LiveKit admin client used to force-remove the previous participant. */
  roomService: Pick<RoomServiceClient, "removeParticipant">;
  /** Publishes the eviction event to the realtime gateway; omit to skip notifying. */
  mutationBus?: RealtimeMutationPublisher;
  /** How long a recorded session lives before Redis expires it (seconds). */
  ttlSeconds: number;
  log?: (message: string) => void;
}

export interface VoiceSessionRegistry {
  /**
   * Record `newRoom` as the user's active voice session and, if they were in a
   * DIFFERENT room, evict that previous session (SFU removeParticipant + realtime
   * eviction event). Never throws — every I/O failure is caught and logged so the
   * join it rides on always succeeds.
   */
  recordAndEvict(userId: string, newRoom: string): Promise<void>;
}

export function createVoiceSessionRegistry(
  deps: VoiceSessionRegistryDeps,
): VoiceSessionRegistry {
  const log = deps.log ?? (() => undefined);

  return {
    async recordAndEvict(userId: string, newRoom: string): Promise<void> {
      const key = voiceSessionKey(userId);

      let previousRoom: string | null = null;
      try {
        previousRoom = await deps.redis.get(key);
        // Refresh the record to the room being joined (bounded by the token TTL).
        await deps.redis.set(key, newRoom, "EX", deps.ttlSeconds);
      } catch (err) {
        // A tracking failure must never block the join; without a record we simply
        // cannot evict this time, which is safe (LiveKit still handles same-room
        // duplicates on its own).
        log(`voice session record failed: ${errText(err)}`);
        return;
      }

      if (!shouldEvictVoiceSession(previousRoom, newRoom)) return;
      const evictedRoom = previousRoom as string;

      // 1) End the previous MEDIA session on the SFU. Best-effort: the participant
      //    may already be gone (they left, or their token expired) — LiveKit throws
      //    then, which is fine.
      try {
        await deps.roomService.removeParticipant(evictedRoom, userId);
      } catch (err) {
        log(`voice removeParticipant(${evictedRoom}) failed: ${errText(err)}`);
      }

      // 2) Tell the evicted device(s) to leave voice cleanly and show the notice.
      //    User-scoped: the gateway forwards it to all of this user's connections;
      //    the one that just joined ignores it (roomId guard). Best-effort — the
      //    LiveKit disconnect above already drives the clean leave if this is lost.
      try {
        await deps.mutationBus?.publish({
          userId,
          event: serverEvent.voiceSessionReplaced({
            roomId: evictedRoom,
            reason: "joined_elsewhere",
          }),
        });
      } catch (err) {
        log(`voice session eviction publish failed: ${errText(err)}`);
      }
    },
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
