/**
 * Resolve WHICH KIND of voice surface a live room is, so the media engine knows
 * whether the server's alone-idle sweep applies to it (see
 * `packages/media/src/alone-watch.ts` and `apps/api/src/lib/dm-call-sweeper.ts`).
 *
 * Mobile twin of `apps/desktop/src/renderer/src/lib/voice-surface.ts`, with the
 * one platform difference: mobile already carries the owning `groupId` in the
 * voice store's `channelMeta`, so a channel room is resolved directly instead of
 * being searched for in the cached group details.
 *
 * FAIL-SAFE: anything that does not resolve to a positively-identified call
 * surface comes back `"unknown"`, which the engine treats exactly like a server
 * voice channel — no countdown. Warning someone about a disconnect that is not
 * coming is worse than staying quiet.
 */

import type { VoiceSurfaceKind } from "@demli/media";
import type { GroupDetails } from "@demli/client-core";
import type { GroupId } from "@demli/types";
import { isDmCallRoom } from "./call-room";
import { queryClient, queryKeys } from "./query-client";

/**
 * Classify the room the engine is (or is about to be) connected to.
 *
 *  1. No room → `null`.
 *  2. A `dmcall:` room → `"call"`. True for a plain 1-1 call AND for everyone who
 *     joined through the call/upgrade path, because the LiveKit room name never
 *     changes across a seamless upgrade (ADR 0012 §6).
 *  3. A channel room whose group we know → that group's `kind`: `server` stays
 *     `"server"` (never swept), `group`/`dm` become `"groupDm"`.
 *  4. Anything else → `"unknown"`, the fail-safe.
 *
 * Reads the query CACHE, never fetches: a miss means "no countdown", which is a
 * fine outcome, and is far better than an HTTP round-trip on every join.
 */
export function resolveVoiceSurfaceKind(
  roomId: string | null,
  groupId: string | null | undefined,
): VoiceSurfaceKind | null {
  if (!roomId) return null;
  if (isDmCallRoom(roomId)) return "call";
  if (!groupId) return "unknown";

  const details = queryClient.getQueryData<GroupDetails>(
    queryKeys.groupDetails(groupId as GroupId),
  );
  if (!details) return "unknown";
  return details.group.kind === "server" ? "server" : "groupDm";
}
