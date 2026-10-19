/**
 * Authoritative voice-occupancy reader (STATE RESYNC, media-plane sourced).
 *
 * The founder's bug: "what I see, others don't; leaving/re-entering the channel
 * fixes it." Voice occupancy and screen-share state used to flow ONLY as
 * realtime deltas (`voice.participant_joined/left`), so a single missed frame
 * left a permanent desync until a full reconnect. The cure is an AUTHORITATIVE
 * snapshot that both the HTTP endpoint and the gateway resync read from a source
 * that cannot desync.
 *
 * SOURCE DECISION — LiveKit `RoomServiceClient`, not the Redis session registry
 * nor the gateway's in-memory map:
 *  - The HTTP API and the realtime gateway are SEPARATE processes. The gateway's
 *    in-memory occupancy map is unreachable from here, so it cannot back an HTTP
 *    endpoint at all.
 *  - The Redis `VoiceSessionRegistry` stores only ONE room per user (single-session
 *    eviction) on a 6h TTL, with no per-channel index and no screen-share
 *    info — unfit as an occupancy source.
 *  - LiveKit is the media plane itself: `listParticipants` returns exactly who is
 *    connected to a room and the tracks they publish, so screen-share/camera are
 *    read from live PUBLISHED tracks — the ground truth. It is reachable from both
 *    processes and cannot drift from reality, which is what heals the desync at
 *    its root.
 *
 * Rooms: an ordinary voice channel's room is its id. A DM-call-upgraded group's
 * voice channel runs in the `dmcall:<id>` room of its call (ADR 0012 §6), so the
 * caller passes those overrides (`channels.livekitRoomOverrides`) and the reader
 * asks LiveKit for the right room — otherwise every resync reported an upgraded
 * call's channel as empty while three people were talking in it.
 */

import {
  ParticipantInfo_State,
  TrackSource,
  type ParticipantInfo,
  type RoomServiceClient,
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
   * keyed by channel id. OCCUPIED channels only — an empty channel is simply
   * absent from the map (the caller omits it from the snapshot).
   *
   * THROWS {@link VoiceOccupancyUnavailableError} when the media plane itself
   * could not be reached (so a resync can be SKIPPED rather than falsely
   * reporting "everyone left"). A single room's participant lookup failing is
   * best-effort — that room is skipped, the rest still return.
   *
   * `roomOverrides` maps a channel to the room it runs in when that is not its
   * own id (the upgraded-call case above).
   */
  read(
    voiceChannelIds: ChannelId[],
    roomOverrides?: ReadonlyMap<ChannelId, string>,
  ): Promise<Map<ChannelId, VoiceOccupant[]>>;
}

/**
 * Map LiveKit participants (media-plane truth) → occupancy occupants. PURE and
 * unit-tested. Identity IS the user id (the media token's `identity`, media
 * module). A participant counts as present unless the SFU marks them
 * DISCONNECTED. Flags are derived from PUBLISHED tracks by `source`:
 *  - screenSharing: an unmuted SCREEN_SHARE track is published
 *  - camera:        an unmuted CAMERA track is published
 *  - muted (mic):   no MICROPHONE track, or every MICROPHONE track is muted
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

export interface LiveKitVoiceOccupancyDeps {
  /** LiveKit admin client (host = http(s) form of the ws(s) client URL). */
  roomService: Pick<RoomServiceClient, "listRooms" | "listParticipants">;
  log?: (message: string) => void;
}

/**
 * A {@link VoiceOccupancyReader} backed by the LiveKit server API. One
 * `listRooms(names)` call scopes the query to exactly the channels the caller
 * may see; `listParticipants` then fetches occupants only for occupied rooms.
 */
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

      // Ask LiveKit for exactly the rooms these channels run in. A hard failure
      // here means we have NO authoritative answer — surface it so the caller
      // skips (never fabricate "empty").
      let rooms;
      try {
        rooms = await deps.roomService.listRooms([...channelsByRoom.keys()]);
      } catch (err) {
        log(`voice occupancy listRooms failed: ${errText(err)}`);
        throw new VoiceOccupancyUnavailableError(err);
      }

      await Promise.all(
        rooms.map(async (room) => {
          if (room.numParticipants === 0) return; // room lingering post-drain
          let participants: ParticipantInfo[];
          try {
            participants = await deps.roomService.listParticipants(room.name);
          } catch (err) {
            // Best-effort per room: one room's failure must not blank the rest.
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

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
