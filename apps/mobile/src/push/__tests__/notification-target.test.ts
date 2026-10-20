import { describe, expect, it } from "vitest";
import {
  callRingDecision,
  notificationHref,
  parseNotificationTarget,
  streamIdOfPush,
} from "../notification-target";

describe("parseNotificationTarget", () => {
  it("routes friend pushes to the friends surface", () => {
    expect(parseNotificationTarget({ type: "friend_request", userId: "u" })).toEqual({ kind: "friends" });
    expect(parseNotificationTarget({ type: "friend", userId: "u" })).toEqual({ kind: "friends" });
  });

  it("routes a DM push with stream, peer and message", () => {
    expect(
      parseNotificationTarget({
        type: "dm_message",
        dmId: "dm-1",
        channelId: "stream-1",
        messageId: "m-1",
        userId: "u-2",
        name: "Burak",
      }),
    ).toEqual({
      kind: "dm",
      dmId: "dm-1",
      streamId: "stream-1",
      name: "Burak",
      userId: "u-2",
      messageId: "m-1",
    });
  });

  it("routes a flat group-chat push to the group chat, not to a channel", () => {
    expect(
      parseNotificationTarget({
        type: "message",
        channelId: "stream-2",
        groupId: "gc-9",
        groupChatId: "gc-9",
        name: "Squad",
        messageId: "m",
      }),
    ).toEqual({ kind: "groupChat", groupChatId: "gc-9", name: "Squad", messageId: "m" });
  });

  it("routes server-channel and mention pushes to the channel with its group", () => {
    for (const type of ["message", "mention"]) {
      expect(
        parseNotificationTarget({ type, channelId: "chan-3", groupId: "grp-1", name: "general", messageId: "m" }),
      ).toEqual({ kind: "channel", channelId: "chan-3", groupId: "grp-1", name: "general", messageId: "m" });
    }
  });

  it("parses both ring shapes as a call ring", () => {
    expect(
      parseNotificationTarget({ type: "call_invite", callId: "c-1", dmId: "dm-1", name: "Ali", userId: "u-ali" }),
    ).toEqual({ kind: "callRing", callId: "c-1", dmId: "dm-1", name: "Ali", userId: "u-ali" });
    expect(
      parseNotificationTarget({ type: "call_invite", callId: "c-2", groupId: "g", voiceChannelId: "v" }),
    ).toEqual({ kind: "callRing", callId: "c-2", groupId: "g", voiceChannelId: "v" });
  });

  it("parses a missed call with or without its DM route", () => {
    expect(
      parseNotificationTarget({
        type: "call_ended",
        callId: "c",
        reason: "timeout",
        dmId: "dm-1",
        channelId: "s-1",
        userId: "u-ali",
        name: "Ali",
      }),
    ).toEqual({ kind: "callMissed", callId: "c", dmId: "dm-1", streamId: "s-1", userId: "u-ali", name: "Ali" });
    expect(parseNotificationTarget({ type: "call_ended", callId: "c", reason: "timeout" })).toEqual({
      kind: "callMissed",
      callId: "c",
    });
  });

  it("returns null for the local update notice and for data with nothing routable", () => {
    expect(parseNotificationTarget({ type: "update" })).toBeNull();
    expect(parseNotificationTarget(undefined)).toBeNull();
    expect(parseNotificationTarget({})).toBeNull();
    expect(parseNotificationTarget({ type: "message" })).toBeNull();
    expect(parseNotificationTarget({ channelId: "   " })).toBeNull();
    expect(parseNotificationTarget({ channelId: 123 as unknown as string })).toBeNull();
  });
});

describe("notificationHref", () => {
  it("dm → the DM screen with every known param, no undefined ones", () => {
    expect(
      notificationHref({ kind: "dm", dmId: "d", streamId: "s", name: "Ali", userId: "u", messageId: "m" }),
    ).toEqual({ pathname: "/dm/[dmId]", params: { dmId: "d", streamId: "s", name: "Ali", userId: "u" } });
    expect(notificationHref({ kind: "dm", dmId: "d" })).toEqual({
      pathname: "/dm/[dmId]",
      params: { dmId: "d" },
    });
  });

  it("channel / group chat / friends", () => {
    expect(notificationHref({ kind: "channel", channelId: "c", groupId: "g", name: "general" })).toEqual({
      pathname: "/channel/[channelId]",
      params: { channelId: "c", groupId: "g", name: "general" },
    });
    expect(notificationHref({ kind: "groupChat", groupChatId: "gc", name: "Squad" })).toEqual({
      pathname: "/group-chat/[groupChatId]",
      params: { groupChatId: "gc", name: "Squad" },
    });
    expect(notificationHref({ kind: "friends" })).toBe("/friends");
  });

  it("missed call → the DM with the caller, else the call log", () => {
    expect(
      notificationHref({ kind: "callMissed", callId: "c", dmId: "d", streamId: "s", name: "Ali", userId: "u" }),
    ).toEqual({ pathname: "/dm/[dmId]", params: { dmId: "d", streamId: "s", name: "Ali", userId: "u" } });
    expect(notificationHref({ kind: "callMissed", callId: "c" })).toBe("/recent-calls");
  });

  it("an ended ring → its DM, or the voice channel for an upgrade ring", () => {
    expect(notificationHref({ kind: "callRing", callId: "c", dmId: "d", name: "Ali" })).toEqual({
      pathname: "/dm/[dmId]",
      params: { dmId: "d", name: "Ali" },
    });
    expect(notificationHref({ kind: "callRing", callId: "c", groupId: "g", voiceChannelId: "v" })).toEqual({
      pathname: "/voice/[channelId]",
      params: { channelId: "v", groupId: "g" },
    });
    expect(notificationHref({ kind: "callRing" })).toBe("/recent-calls");
  });
});

describe("callRingDecision", () => {
  const ring = { kind: "callRing" as const, callId: "c-1", dmId: "d", name: "Ali" };

  it("still ringing here → stay on the incoming overlay (accept / decline)", () => {
    expect(callRingDecision(ring, { phase: "incoming", callId: "c-1" })).toBe("overlay");
  });

  it("already accepted on this phone → the call screen", () => {
    expect(callRingDecision(ring, { phase: "active", callId: "c-1" })).toBe("/call");
  });

  it("ring over (or a different call) → the DM it belonged to", () => {
    const dm = { pathname: "/dm/[dmId]", params: { dmId: "d", name: "Ali" } };
    expect(callRingDecision(ring, { phase: "idle", callId: null })).toEqual(dm);
    expect(callRingDecision(ring, { phase: "ended", callId: "c-1" })).toEqual(dm);
    expect(callRingDecision(ring, { phase: "incoming", callId: "other" })).toEqual(dm);
  });
});

describe("streamIdOfPush", () => {
  it("returns the stream for message pushes (drives foreground suppression)", () => {
    expect(streamIdOfPush({ type: "message", channelId: "stream-1" })).toBe("stream-1");
    expect(streamIdOfPush({ type: "dm_message", channelId: "stream-2", dmId: "d" })).toBe("stream-2");
    expect(streamIdOfPush({ channelId: "stream-3" })).toBe("stream-3");
  });

  it("never suppresses friend or call pushes, even while their DM is open", () => {
    expect(streamIdOfPush({ type: "friend_request", channelId: "x" })).toBeUndefined();
    expect(streamIdOfPush({ type: "call_invite", callId: "c", dmId: "d" })).toBeUndefined();
    expect(streamIdOfPush({ type: "call_ended", callId: "c", dmId: "d", channelId: "s" })).toBeUndefined();
  });

  it("returns undefined when no channel key is present", () => {
    expect(streamIdOfPush(undefined)).toBeUndefined();
    expect(streamIdOfPush({})).toBeUndefined();
  });
});
