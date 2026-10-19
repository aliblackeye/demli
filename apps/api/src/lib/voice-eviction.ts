/**
 * Force a user out of every LiveKit room that belongs to one group.
 *
 * A kick, ban, timeout or owner-removal used to be bookkeeping only: the API
 * published `member.left`, the gateway edited its occupancy map, and the
 * target's SFU session kept running — a removed member could keep hearing and
 * talking for as long as their client stayed put (a backgrounded phone, an old
 * build, a modified client). The SFU is the only place that can end a media
 * session, so the removal goes there.
 *
 * Every voice channel of the group is covered, in the room it actually runs in
 * (`livekitRoom ?? id`, ADR 0012 §6) — an upgraded group's voice channel lives in
 * the `dmcall:<id>` room of the call it came from.
 *
 * BEST-EFFORT by contract, like the moderator voice-disconnect: the membership
 * change is already committed and is the source of truth. LiveKit answers
 * NotFound for a room the user is not in (the common case), and an unreachable
 * SFU must never fail the moderation request. Each room the user WAS removed
 * from also gets a user-scoped `voice.disconnected` so the target's devices
 * leave with the moderator notice instead of the generic "joined elsewhere" one.
 */

import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { RoomServiceClient } from "livekit-server-sdk";
import type { RealtimeMutationPublisher } from "@demli/db";
import { serverEvent } from "@demli/protocol";
import type { GroupId, UserId } from "@demli/types";

/** The SFU capability eviction needs — the exact `RoomServiceClient` method. */
export type VoiceEjector = Pick<RoomServiceClient, "removeParticipant">;

export interface EvictFromGroupVoiceInput {
  groupId: GroupId;
  userId: UserId;
}

export async function evictFromGroupVoice(
  server: FastifyInstance,
  deps: {
    ejector: VoiceEjector | null;
    mutationBus?: RealtimeMutationPublisher;
    log: FastifyBaseLogger;
  },
  input: EvictFromGroupVoiceInput,
): Promise<void> {
  const { ejector } = deps;
  if (!ejector) return;

  let rooms: Array<{ channelId: string; room: string }>;
  try {
    rooms = await server.repos.channels.listVoiceRoomsForGroup(input.groupId);
  } catch (err) {
    deps.log.warn({ err, groupId: input.groupId }, "voice eviction: room lookup failed");
    return;
  }

  await Promise.all(
    rooms.map(async ({ channelId, room }) => {
      try {
        await ejector.removeParticipant(room, input.userId);
      } catch (err) {
        // NotFound is the normal answer for a room the user is not in. Anything
        // else (SFU unreachable) is worth a log line, but still not a failure.
        if (!isNotFound(err)) {
          deps.log.warn({ err, room }, "voice eviction: removeParticipant failed");
        }
        return;
      }
      await deps.mutationBus?.publish({
        userId: input.userId,
        event: serverEvent.voiceDisconnected({ roomId: room, channelId, reason: "moderator" }),
      });
    }),
  );
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { status, code } = err as { status?: unknown; code?: unknown };
  return status === 404 || code === "not_found";
}
