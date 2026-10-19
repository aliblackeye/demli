/**
 * Voice module — the authoritative voice-occupancy snapshot (STATE RESYNC).
 *
 * GET /voice/occupancy
 *   → 200 { channels: [{ channelId, occupants: [{ userId, muted, screenSharing?, camera? }] }] }
 *   → 503 VOICE_OCCUPANCY_UNAVAILABLE when the media plane cannot be reached
 *
 * The client pulls this on app focus to re-seat on ground truth; the same shape
 * is PUSHED over the socket as `voice.resync` on every (re)connect (apps/realtime).
 * Both read from LiveKit (see {@link createLiveKitVoiceOccupancyReader}) so they
 * cannot drift.
 *
 * Visibility (§28, ADR 0007): the snapshot is built ONLY from the caller's own
 * visible voice channels — membership filtered, then role/access filtered — so a
 * voice channel the user may not see never appears, even if it is occupied in the
 * SFU. The server never trusts a client-supplied channel list.
 */

import type { FastifyInstance } from "fastify";
import { RoomServiceClient } from "livekit-server-sdk";
import type { Channel, ChannelId, GroupId, UserId } from "@demli/types";
import type { VoiceChannelOccupants, VoiceOccupancySnapshot } from "@demli/protocol";
import { ApiError } from "../../errors.js";
import { requireUser } from "../../plugins/auth.js";
import { livekitHttpUrl } from "../media/voice-session.js";
import {
  createLiveKitVoiceOccupancyReader,
  VoiceOccupancyUnavailableError,
  type VoiceOccupancyReader,
} from "./occupancy.js";
import { userRateLimit } from "../../lib/rate-limit.js";

export type { VoiceOccupancyReader } from "./occupancy.js";

/**
 * Build the LiveKit-backed occupancy reader from env — mirrors
 * {@link createVoiceSessions}: the admin client reuses the token-minting creds and
 * the http(s) form of the ws(s) client URL. Always constructible (env carries dev
 * defaults); a wrong/unreachable host simply yields a 503 at request time, never a
 * boot failure.
 */
export function createVoiceOccupancyReader(server: FastifyInstance): VoiceOccupancyReader {
  return createLiveKitVoiceOccupancyReader({
    roomService: new RoomServiceClient(
      livekitHttpUrl(server.apiEnv.livekitUrl),
      server.apiEnv.livekitApiKey,
      server.apiEnv.livekitApiSecret,
    ),
    log: (message) => server.log.info(message),
  });
}

export interface VoiceModuleOptions {
  /**
   * The authoritative occupancy reader. Built from env in `buildApp` via
   * {@link createVoiceOccupancyReader}; tests inject a fake so no live SFU is
   * needed. Omitted ⇒ the endpoint answers 503 (feature effectively off).
   */
  reader?: VoiceOccupancyReader | null;
}

export async function registerVoiceModule(
  server: FastifyInstance,
  options: VoiceModuleOptions = {},
): Promise<void> {
  const reader = options.reader ?? null;

  server.get(
    "/voice/occupancy",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 60, timeWindow: "1 minute" }),
      },
    },
    async (request): Promise<VoiceOccupancySnapshot> => {
      const user = requireUser(request);
      if (!reader) {
        throw new ApiError(
          503,
          "VOICE_OCCUPANCY_UNAVAILABLE",
          "Voice occupancy is temporarily unavailable.",
        );
      }

      const visibleVoiceIds = await visibleVoiceChannelIds(server, user.id);
      if (visibleVoiceIds.length === 0) return { channels: [] };

      // An upgraded call's voice channel runs in the call's room, not its id.
      // Without the overrides an upgraded room would read as empty, so a failed
      // lookup is the same honest 503 as an unreachable media plane — never a
      // snapshot that wipes the client's view, never a 500 on every app focus.
      let roomOverrides;
      try {
        roomOverrides = await server.repos.channels.livekitRoomOverrides(visibleVoiceIds);
      } catch (err) {
        request.log.warn({ err }, "voice occupancy: room override lookup failed");
        throw new ApiError(
          503,
          "VOICE_OCCUPANCY_UNAVAILABLE",
          "Voice occupancy is temporarily unavailable.",
        );
      }

      let occupancy;
      try {
        occupancy = await reader.read(visibleVoiceIds, roomOverrides);
      } catch (err) {
        if (err instanceof VoiceOccupancyUnavailableError) {
          // Honest failure: do NOT fabricate an empty snapshot (that would wipe the
          // client's occupancy). The client keeps its current view and retries.
          throw new ApiError(
            503,
            "VOICE_OCCUPANCY_UNAVAILABLE",
            "Voice occupancy is temporarily unavailable.",
          );
        }
        throw err;
      }

      // Only OCCUPIED channels appear; iterate the visible set so the response
      // order is stable and never includes a channel outside the caller's view.
      const channels: VoiceChannelOccupants[] = [];
      for (const channelId of visibleVoiceIds) {
        const occupants = occupancy.get(channelId);
        if (occupants && occupants.length > 0) channels.push({ channelId, occupants });
      }
      return { channels };
    },
  );
}

/**
 * The voice channels the caller may currently SEE, across every group they
 * belong to. Membership-filtered (via `listForUser`) then role/access-filtered
 * (via `visibleChannelIdsForUser`) — the SAME visibility boundary the WS
 * subscription set and the media-token endpoint obey (§28, ADR 0007). A
 * restricted voice channel the caller lacks a granting role for is never
 * returned, so it can never leak into the occupancy snapshot.
 */
async function visibleVoiceChannelIds(
  server: FastifyInstance,
  userId: UserId,
): Promise<ChannelId[]> {
  const all = await server.repos.channels.listForUser(userId);
  const byGroup = new Map<GroupId, Channel[]>();
  for (const channel of all) {
    if (channel.kind !== "voice") continue;
    const list = byGroup.get(channel.groupId);
    if (list) list.push(channel);
    else byGroup.set(channel.groupId, [channel]);
  }

  const visible: ChannelId[] = [];
  for (const [groupId, groupChannels] of byGroup) {
    const visibleIds = new Set(
      await server.repos.channelAccess.visibleChannelIdsForUser(groupId, userId),
    );
    for (const channel of groupChannels) {
      if (visibleIds.has(channel.id)) visible.push(channel.id);
    }
  }
  return visible;
}
