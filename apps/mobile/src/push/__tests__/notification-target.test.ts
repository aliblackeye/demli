import { describe, expect, it } from "vitest";
import { parseNotificationTarget, streamIdOfPush } from "../notification-target";

describe("parseNotificationTarget", () => {
  it("routes a friend-request push to the friends surface", () => {
    expect(parseNotificationTarget({ type: "friend_request" })).toEqual({ kind: "friends" });
    // tolerate a shorter "friend" discriminator too
    expect(parseNotificationTarget({ type: "friend" })).toEqual({ kind: "friends" });
  });

  it("routes a DM push, using channelId as the stream key", () => {
    const target = parseNotificationTarget({
      type: "message",
      channelId: "stream-1",
      dmId: "dm-1",
      userId: "u-2",
      name: "Burak",
    });
    expect(target).toEqual({
      kind: "dm",
      dmId: "dm-1",
      streamId: "stream-1",
      name: "Burak",
      userId: "u-2",
    });
  });

  it("routes a flat group-chat push", () => {
    expect(
      parseNotificationTarget({
        type: "message",
        channelId: "stream-2",
        groupChatId: "gc-9",
        name: "Squad",
      }),
    ).toEqual({ kind: "groupChat", groupChatId: "gc-9", name: "Squad" });
  });

  it("routes a server-channel push with its owning group", () => {
    expect(
      parseNotificationTarget({
        type: "message",
        channelId: "chan-3",
        groupId: "grp-1",
        name: "general",
      }),
    ).toEqual({ kind: "channel", channelId: "chan-3", groupId: "grp-1", name: "general" });
  });

  it("routes a 1-1 DM call-invite push to the call context (dmId)", () => {
    expect(
      parseNotificationTarget({ type: "call_invite", callId: "c-1", dmId: "dm-1", name: "Ali" }),
    ).toEqual({ kind: "call", dmId: "dm-1", name: "Ali" });
  });

  it("routes a group-upgrade call-invite push to the voice channel", () => {
    expect(
      parseNotificationTarget({
        type: "call_invite",
        callId: "c-2",
        groupId: "grp-9",
        voiceChannelId: "vc-9",
      }),
    ).toEqual({ kind: "call", groupId: "grp-9", voiceChannelId: "vc-9" });
  });

  it("falls back to the friends surface for a call-invite with no routable ids", () => {
    expect(parseNotificationTarget({ type: "call_invite", callId: "c-3" })).toEqual({
      kind: "friends",
    });
  });

  it("never treats a call-invite as a suppressible stream", () => {
    expect(streamIdOfPush({ type: "call_invite", callId: "c-1", dmId: "dm-1" })).toBeUndefined();
  });

  it("prefers a DM over a bare channelId when both are present", () => {
    const target = parseNotificationTarget({ channelId: "s", dmId: "dm-1" });
    expect(target).toMatchObject({ kind: "dm", dmId: "dm-1", streamId: "s" });
  });

  it("returns null for data with nothing routable", () => {
    expect(parseNotificationTarget(undefined)).toBeNull();
    expect(parseNotificationTarget({})).toBeNull();
    expect(parseNotificationTarget({ type: "message" })).toBeNull();
    // blank strings are treated as absent
    expect(parseNotificationTarget({ channelId: "   " })).toBeNull();
  });

  it("ignores non-string field values", () => {
    expect(parseNotificationTarget({ channelId: 123 as unknown as string })).toBeNull();
  });
});

describe("streamIdOfPush", () => {
  it("returns the channelId for a message push (drives foreground suppression)", () => {
    expect(streamIdOfPush({ type: "message", channelId: "stream-1" })).toBe("stream-1");
    expect(streamIdOfPush({ channelId: "stream-2" })).toBe("stream-2");
  });

  it("returns undefined for a friend-request push (never suppressed)", () => {
    expect(streamIdOfPush({ type: "friend_request", channelId: "x" })).toBeUndefined();
  });

  it("returns undefined when no channel key is present", () => {
    expect(streamIdOfPush(undefined)).toBeUndefined();
    expect(streamIdOfPush({})).toBeUndefined();
  });
});
