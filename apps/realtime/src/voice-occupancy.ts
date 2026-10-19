/**
 * Authoritative voice-occupancy reader for the gateway (STATE RESYNC).
 *
 * The gateway pushes a `voice.resync` snapshot to a connection right after
 * `auth.succeeded` (and thus on every reconnect, since each reconnect is a fresh
 * handshake), so the client re-seats on ground truth without waiting for the next
 * `voice.participant_joined/left` delta — healing the "I see a screen share, my
 * peer doesn't" desync at its root.
 *
 * SOURCE: LiveKit `RoomServiceClient` — the media plane itself, the same source
 * the HTTP `GET /voice/occupancy` endpoint uses (apps/api), so the pushed and
 * pulled snapshots cannot drift. The gateway's own in-memory occupancy map (fed
 * by client-declared `voice.join/leave`) carries no screen-share state and is
 * exactly what desyncs, so it cannot be the authoritative source.
 *
 * This mirrors `apps/api/src/modules/voice/occupancy.ts`; the two apps are
 * separate processes with no shared runtime package that may depend on the
 * LiveKit SDK, so the small reader is intentionally implemented per app while the
 * SHARED contract (the snapshot shape) lives once in @demli/protocol.
 */

import {
  ParticipantInfo_State,
  RoomServiceClient,
  TrackSource,
  type ParticipantInfo,
} from "livekit-server-sdk";
import type { ChannelId } from "@demli/types";
import type { VoiceOccupant } from "@demli/protocol";

/** Thrown when the media plane could not be queried (LiveKit unavailable). */
export class VoiceOccupancyUnavailableError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "VoiceOccupancyUnavailableError";
  }
}

export interface VoiceOccupancyReader {
  /**
   * Authoritative occupants of each given voice channel that currently has any,
   * keyed by channel id. OCCUPIED channels only. THROWS
   * {@link VoiceOccupancyUnavailableError} when the media plane itself is
   * unreachable, so the caller can SKIP the resync rather than push a false
   * "everyone left"; a single room's participant lookup failing is best-effort.
   *
   * `roomOverrides` maps a channel to the LiveKit room it actually runs in when
   * that is not its own id â€” an upgraded group's voice channel lives in the
   * `dmcall:<id>` room of its call (ADR 0012 §6). Without it that channel would
   * always read as empty, and a resync REPLACES the client's map.
   */
  read(
    voiceChannelIds: ChannelId[],
    roomOverrides?: ReadonlyMap<ChannelId, string>,
  ): Promise<Map<ChannelId, VoiceOccupant[]>>;
}

/**
 * Map LiveKit participants (media-plane truth) → occupancy occupants. PURE and
 * unit-tested. Identity IS the user id (the media token's `identity`). A
 * participant counts as present unless the SFU marks them DISCONNECTED. Flags
 * come from PUBLISHED tracks by `source`: an unmuted SCREEN_SHARE ⇒ screenSharing,
 * an unmuted CAMERA ⇒ camera, no/every-muted MICROPHONE ⇒ muted.
 */
export function participantsToOccupants(participants: ParticipantInfo[]): VoiceOccupant[] {
  const occupants: VoiceOccupant[] = [];
  for (const p of participants) {
    if (p.state === ParticipantInfo_State.DISCONNECTED) continue;
    const tracks = p.tracks ?? [];
    const screenSharing = tracks.some((t) => t.source === TrackSource.SCREEN_SHARE && !t.muted);
    const camera = tracks.some((t) => t.source === TrackSource.CAMERA && !t.muted);
    const micTracks = tracks.filter((t) => t.source === TrackSource.MICROPHONE);
    const muted = micTracks.length === 0 || micTracks.every((t) => t.muted);
    occupants.push({ userId: p.identity, muted, screenSharing, camera });
  }
  return occupants;
}

/**
 * Convert a LiveKit `ws(s)://` client URL to the `http(s)://` host the server SDK
 * (`RoomServiceClient`) expects. Mirrors the api helper; kept local so the two
 * apps stay independent.
 */
export function livekitHttpUrl(url: string): string {
  if (url.startsWith("wss:")) return `https:${url.slice("wss:".length)}`;
  if (url.startsWith("ws:")) return `http:${url.slice("ws:".length)}`;
  return url;
}

export interface LiveKitVoiceOccupancyDeps {
  roomService: Pick<RoomServiceClient, "listRooms" | "listParticipants">;
  log?: (message: string) => void;
}

/** A {@link VoiceOccupancyReader} backed by the LiveKit server API. */
export function createLiveKitVoiceOccupancyReader(
  deps: LiveKitVoiceOccupancyDeps,
): VoiceOccupancyReader {
  const log = deps.log ?? (() => undefined);
  return {
    async read(
      voiceChannelIds: ChannelId[],
      roomOverrides?: ReadonlyMap<ChannelId, string>,
    ): Promise<Map<ChannelId, VoiceOccupant[]>> {
      const result = new Map<ChannelId, VoiceOccupant[]>();
      if (voiceChannelIds.length === 0) return result;
      const channelsByRoom = roomToChannels(voiceChannelIds, roomOverrides);

      let rooms;
      try {
        rooms = await deps.roomService.listRooms([...channelsByRoom.keys()]);
      } catch (err) {
        log(`voice occupancy listRooms failed: ${errText(err)}`);
        throw new VoiceOccupancyUnavailableError(err);
      }

      await Promise.all(
        rooms.map(async (room) => {
          if (room.numParticipants === 0) return;
          let participants: ParticipantInfo[];
          try {
            participants = await deps.roomService.listParticipants(room.name);
          } catch (err) {
            log(`voice occupancy listParticipants(${room.name}) failed: ${errText(err)}`);
            return;
          }
          const occupants = participantsToOccupants(participants);
          if (occupants.length === 0) return;
          for (const channelId of channelsByRoom.get(room.name) ?? []) {
            result.set(channelId, occupants);
          }
        }),
      );
      return result;
    },
  };
}

/** Group the requested channels by the LiveKit room each one runs in. */
export function roomToChannels(
  voiceChannelIds: readonly ChannelId[],
  roomOverrides?: ReadonlyMap<ChannelId, string>,
): Map<string, ChannelId[]> {
  const byRoom = new Map<string, ChannelId[]>();
  for (const channelId of voiceChannelIds) {
    const room = roomOverrides?.get(channelId) ?? channelId;
    const list = byRoom.get(room);
    if (list) list.push(channelId);
    else byRoom.set(room, [channelId]);
  }
  return byRoom;
}

/**
 * Build the LiveKit-backed reader from the gateway's env, or `null` when LiveKit
 * is not configured (so the gateway simply skips `voice.resync` and clients fall
 * back to the `auth.succeeded` snapshot + the HTTP endpoint). Always returns a
 * reader when a URL is present; an unreachable host degrades to a skipped resync
 * at connect time, never a boot failure.
 */
export function createGatewayVoiceOccupancyReader(
  env: { livekitUrl?: string; livekitApiKey?: string; livekitApiSecret?: string },
  log?: (message: string) => void,
): VoiceOccupancyReader | null {
  if (!env.livekitUrl || !env.livekitApiKey || !env.livekitApiSecret) return null;
  return createLiveKitVoiceOccupancyReader({
    roomService: new RoomServiceClient(
      livekitHttpUrl(env.livekitUrl),
      env.livekitApiKey,
      env.livekitApiSecret,
    ),
    log,
  });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
