/**
 * Desktop voice-surface classification — the gate that decides whether the
 * "you're alone, the call will close" countdown may appear at all.
 *
 * The server voice channel case is the one that must never regress: the server's
 * alone-idle sweep deliberately exempts server channels, so a countdown there
 * would be warning about a disconnect that is not coming.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { GroupDetails } from "./api-client";
import { queryClient, queryKeys } from "./query-client";
import { resolveVoiceGroupId, resolveVoiceSurfaceKind } from "./voice-surface";

const SERVER_GROUP = "11111111-1111-4111-8111-111111111111";
const CHAT_GROUP = "22222222-2222-4222-8222-222222222222";

function seedGroup(groupId: string, kind: "server" | "group" | "dm", channelId: string): void {
  const details = {
    group: {
      id: groupId,
      name: `group-${kind}`,
      iconUrl: null,
      ownerId: "owner",
      kind,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    channels: [{ id: channelId, groupId, kind: "voice", name: "lobby", position: 0 }],
    members: [],
  } as unknown as GroupDetails;
  queryClient.setQueryData(queryKeys.groupDetails(groupId as never), details);
}

afterEach(() => {
  queryClient.clear();
});

describe("resolveVoiceSurfaceKind", () => {
  it("classifies a SERVER voice channel as `server` — never alone-ejectable", () => {
    seedGroup(SERVER_GROUP, "server", "voice-1");
    expect(resolveVoiceSurfaceKind("voice-1")).toBe("server");
  });

  it("classifies a group-chat / DM voice channel as `groupDm`", () => {
    seedGroup(CHAT_GROUP, "group", "voice-2");
    expect(resolveVoiceSurfaceKind("voice-2")).toBe("groupDm");

    queryClient.clear();
    seedGroup(CHAT_GROUP, "dm", "voice-3");
    expect(resolveVoiceSurfaceKind("voice-3")).toBe("groupDm");
  });

  it("classifies a `dmcall:` room as `call` without touching the cache", () => {
    // A 1-1 call, and every seat of a seamlessly upgraded one, live under this
    // room name — no group details exist for it, and none are needed.
    expect(resolveVoiceSurfaceKind("dmcall:abc-123")).toBe("call");
  });

  it("returns `unknown` for a channel we cannot place (fail-safe, no warning)", () => {
    seedGroup(SERVER_GROUP, "server", "voice-1");
    expect(resolveVoiceSurfaceKind("some-other-channel")).toBe("unknown");
  });

  it("returns null when there is no room", () => {
    expect(resolveVoiceSurfaceKind(null)).toBeNull();
  });

  it("is not confused by the cached group LIST sharing the `groups` key prefix", () => {
    // queryKeys.groups is a prefix of queryKeys.groupDetails, so the prefix read
    // also sees the list query — whose data is an ARRAY, not a GroupDetails.
    queryClient.setQueryData(queryKeys.groups, [
      { id: SERVER_GROUP, kind: "server", name: "srv" },
    ]);
    seedGroup(SERVER_GROUP, "server", "voice-1");
    expect(resolveVoiceSurfaceKind("voice-1")).toBe("server");
    expect(resolveVoiceSurfaceKind("nope")).toBe("unknown");
  });
});

describe("resolveVoiceGroupId", () => {
  // The server video stage is scoped with this: a voice session is global (one
  // engine, one room) but the stage belongs to ONE server. Without the scope the
  // centre column asked only "is there video?", so switching servers carried the
  // camera along and painted it over an unrelated server's chat — founder report,
  // 2026-07-28: "sunucular arası geçiş yapınca kameram ortada duruyor".
  it("returns the group that owns the voice channel", () => {
    seedGroup(SERVER_GROUP, "server", "voice-1");
    expect(resolveVoiceGroupId("voice-1")).toBe(SERVER_GROUP);
  });

  it("does not attribute a channel to a DIFFERENT server", () => {
    seedGroup(SERVER_GROUP, "server", "voice-1");
    seedGroup(CHAT_GROUP, "group", "voice-2");
    // The whole bug in one assertion: the room belongs to one group, so the other
    // must not be able to claim it and stage the camera.
    expect(resolveVoiceGroupId("voice-1")).not.toBe(CHAT_GROUP);
    expect(resolveVoiceGroupId("voice-2")).toBe(CHAT_GROUP);
  });

  it("returns null for a DM call room — it owns its own embedded stage", () => {
    expect(resolveVoiceGroupId("dmcall:abc")).toBeNull();
  });

  it("returns null when nothing is connected or the room is unknown", () => {
    // Callers treat null as "do not stage here": a stage we cannot attribute is
    // exactly what the bug looked like.
    expect(resolveVoiceGroupId(null)).toBeNull();
    expect(resolveVoiceGroupId("voice-nope")).toBeNull();
  });
});
