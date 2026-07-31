/**
 * Mobile voice-surface classification — the gate that decides whether the
 * "you're alone, the call will close" countdown may appear at all.
 *
 * Mirrors the desktop test. The server voice channel case is the one that must
 * never regress: the server's alone-idle sweep exempts server channels, so a
 * countdown there would warn about a disconnect that is not coming.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { GroupDetails } from "@demli/client-core";
import { queryClient, queryKeys } from "./query-client";
import { resolveVoiceSurfaceKind } from "./voice-surface";

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
    expect(resolveVoiceSurfaceKind("voice-1", SERVER_GROUP)).toBe("server");
  });

  it("classifies a group-chat / DM voice channel as `groupDm`", () => {
    seedGroup(CHAT_GROUP, "group", "voice-2");
    expect(resolveVoiceSurfaceKind("voice-2", CHAT_GROUP)).toBe("groupDm");

    queryClient.clear();
    seedGroup(CHAT_GROUP, "dm", "voice-3");
    expect(resolveVoiceSurfaceKind("voice-3", CHAT_GROUP)).toBe("groupDm");
  });

  it("classifies a `dmcall:` room as `call` even with no group context", () => {
    expect(resolveVoiceSurfaceKind("dmcall:abc-123", null)).toBe("call");
    expect(resolveVoiceSurfaceKind("dmcall:abc-123", undefined)).toBe("call");
  });

  it("returns `unknown` without a group id (fail-safe, no warning)", () => {
    expect(resolveVoiceSurfaceKind("voice-1", null)).toBe("unknown");
  });

  it("returns `unknown` when the group is not cached (fail-safe)", () => {
    expect(resolveVoiceSurfaceKind("voice-1", SERVER_GROUP)).toBe("unknown");
  });

  it("returns null when there is no room", () => {
    expect(resolveVoiceSurfaceKind(null, SERVER_GROUP)).toBeNull();
  });
});
