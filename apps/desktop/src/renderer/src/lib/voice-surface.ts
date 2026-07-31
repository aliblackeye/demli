/**
 * Resolve WHICH KIND of voice surface a live room is, so the media engine knows
 * whether the server's alone-idle sweep applies to it (see
 * `packages/media/src/alone-watch.ts` and `apps/api/src/lib/dm-call-sweeper.ts`).
 *
 * The engine only ever holds a room STRING; the answer lives in the owning
 * group's `kind`. This module is the desktop half of that lookup, and it exists
 * as a plain function (not a hook) because the voice store — not React — is what
 * needs the answer, at the moment `roomId` changes.
 *
 * FAIL-SAFE: anything that does not resolve to a positively-identified call
 * surface comes back `"unknown"`, which the engine treats exactly like a server
 * voice channel — no countdown. Warning someone about a disconnect that is not
 * coming is worse than staying quiet.
 */

import type { VoiceSurfaceKind } from "@demli/media";
import type { GroupDetails } from "./api-client";
import { queryClient, queryKeys } from "./query-client";

/**
 * `dmcall:<callId>` — the room name a DM call mints (ADR 0012 §2), and the SAME
 * name a seamless upgrade keeps for its group voice channel, so both the two
 * originals and a ring-accepting third person are connected under it. Every one
 * of those is a CALL surface the server does sweep.
 */
const DM_CALL_ROOM_PREFIX = "dmcall:";

/**
 * Classify the room the engine is (or is about to be) connected to.
 *
 * Resolution order:
 *  1. No room → `null` (nothing to classify).
 *  2. A `dmcall:` room → `"call"`. True for a plain 1-1 call AND for everyone who
 *     joined through the call/upgrade path, because the LiveKit room name never
 *     changes across an upgrade (ADR 0012 §6).
 *  3. Otherwise the room is a channel id: find it in the cached group details and
 *     read that group's `kind`. `server` stays `"server"` (never swept);
 *     `group`/`dm` become `"groupDm"`.
 *  4. Not found → `"unknown"`, the fail-safe.
 *
 * Reads the query CACHE rather than fetching: joining a voice channel means the
 * user was just looking at its group, so its details are already cached, and a
 * miss simply means "no countdown" instead of an extra request on every join.
 */
export function resolveVoiceSurfaceKind(roomId: string | null): VoiceSurfaceKind | null {
  if (!roomId) return null;
  if (roomId.startsWith(DM_CALL_ROOM_PREFIX)) return "call";

  // `queryKeys.groups` (["groups"]) is a PREFIX of every
  // `queryKeys.groupDetails` (["groups","details",id]), so one prefix read walks
  // them all. It also matches the group LIST query, whose data is an array — hence
  // the structural narrowing below rather than a blind cast.
  for (const [, data] of queryClient.getQueriesData({ queryKey: queryKeys.groups })) {
    const details = asGroupDetails(data);
    if (!details) continue;
    if (!details.channels.some((channel) => channel.id === roomId)) continue;
    return details.group.kind === "server" ? "server" : "groupDm";
  }
  return "unknown";
}

/**
 * WHICH GROUP owns the live voice room, or `null` when that cannot be answered.
 *
 * The server-surface video stage needs this: a voice session is global (one
 * engine, one room) but the stage belongs to ONE server. Without this the centre
 * column asked only "is there video?", so walking to another server carried the
 * camera along and painted it over that server's chat — the founder's report:
 * "sunucular arası geçiş yapınca kameram ortada duruyor".
 *
 * `null` for a `dmcall:` room (a DM call owns its own embedded stage, never the
 * server surface) and for a room no cached group claims. Callers must treat
 * `null` as "do not stage here" — showing a stage we cannot attribute is exactly
 * the bug.
 */
export function resolveVoiceGroupId(roomId: string | null): string | null {
  if (!roomId) return null;
  if (roomId.startsWith(DM_CALL_ROOM_PREFIX)) return null;

  for (const [, data] of queryClient.getQueriesData({ queryKey: queryKeys.groups })) {
    const details = asGroupDetails(data);
    if (!details) continue;
    if (!details.channels.some((channel) => channel.id === roomId)) continue;
    return details.group.id;
  }
  return null;
}

/** Structural check that a cached entry is a `GroupDetails` and not the group list. */
function asGroupDetails(data: unknown): GroupDetails | null {
  if (typeof data !== "object" || data === null) return null;
  const candidate = data as Partial<GroupDetails>;
  if (!Array.isArray(candidate.channels)) return null;
  if (typeof candidate.group !== "object" || candidate.group === null) return null;
  return candidate as GroupDetails;
}
