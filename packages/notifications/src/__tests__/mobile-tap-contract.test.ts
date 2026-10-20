/**
 * Server → mobile tap contract (field report 2026-10-20). Every push the server
 * builds is fed, exactly as built, through the MOBILE parser and router
 * (apps/mobile/src/push/notification-target.ts — a pure module with no RN
 * imports, so it runs here). A renamed type or id on either side fails this,
 * instead of a tap silently opening the app on the wrong screen.
 */

import { describe, expect, it } from "vitest";
import {
  callRingDecision,
  notificationHref,
  parseNotificationTarget,
  streamIdOfPush,
} from "../../../../apps/mobile/src/push/notification-target.js";
import { callMissedPush, callRingPush } from "../call-push.js";
import { dispatchChannelMessagePush, type ChannelMessagePushRepos } from "../channel-message-push.js";
import { dmMessagePush } from "../message-push.js";
import type { OfflineNotifier } from "../notifications.js";
import type { PushNotification } from "../push.js";

/** Expo/FCM data maps are string→string on the wire. */
function wire(n: PushNotification): Record<string, unknown> {
  return Object.fromEntries(Object.entries(n.data ?? {}).map(([k, v]) => [k, String(v)]));
}

async function channelPushes(kind: "server" | "group"): Promise<PushNotification[]> {
  const sent: PushNotification[] = [];
  const notifier: OfflineNotifier = {
    notify: async (_ids, n) => void sent.push(n),
    notifyAlways: async (_ids, n) => void sent.push(n),
  };
  const repos: ChannelMessagePushRepos = {
    channelAccess: {
      recipientIdsForChannel: async () => ["author", "tagged", "other"],
      canUserSeeChannel: async () => true,
    },
    groups: { findById: async () => ({ name: "Crew", kind }) as never },
    users: { findById: async () => ({ displayName: "Ada" }) as never },
  };
  await dispatchChannelMessagePush(
    { repos, notifier },
    {
      channelId: "c1",
      groupId: "g1",
      channelName: "general",
      authorId: "author",
      content: "hi <@tagged>",
      messageId: "m1",
    },
  );
  return sent;
}

describe("server push data → mobile tap route", () => {
  it("dm_message opens that DM, ready (stream + peer + name)", () => {
    const push = dmMessagePush({
      authorId: "u-ali",
      authorName: "Ali",
      dmId: "d1",
      channelId: "s1",
      messageId: "m1",
      content: "selam",
    });
    const target = parseNotificationTarget(wire(push))!;
    expect(notificationHref(target)).toEqual({
      pathname: "/dm/[dmId]",
      params: { dmId: "d1", streamId: "s1", name: "Ali", userId: "u-ali" },
    });
    expect(streamIdOfPush(wire(push))).toBe("s1");
  });

  it("server channel message AND mention open that channel in its server", async () => {
    const pushes = await channelPushes("server");
    expect(pushes).toHaveLength(2);
    for (const push of pushes) {
      expect(notificationHref(parseNotificationTarget(wire(push))!)).toEqual({
        pathname: "/channel/[channelId]",
        params: { channelId: "c1", groupId: "g1", name: "general" },
      });
    }
  });

  it("a flat group chat's message and mention open the group chat screen", async () => {
    for (const push of await channelPushes("group")) {
      expect(notificationHref(parseNotificationTarget(wire(push))!)).toEqual({
        pathname: "/group-chat/[groupChatId]",
        params: { groupChatId: "g1", name: "Crew" },
      });
    }
  });

  it("a 1-1 ring shows the incoming overlay while ringing, else opens the DM", () => {
    const push = callRingPush({
      callerName: "Ali",
      callId: "c1",
      ringSeconds: 30,
      target: { dmId: "d1" },
      callerId: "u-ali",
    });
    const target = parseNotificationTarget(wire(push))!;
    expect(target.kind).toBe("callRing");
    if (target.kind !== "callRing") return;
    expect(callRingDecision(target, { phase: "incoming", callId: "c1" })).toBe("overlay");
    expect(callRingDecision(target, { phase: "idle", callId: null })).toEqual({
      pathname: "/dm/[dmId]",
      params: { dmId: "d1", name: "Ali", userId: "u-ali" },
    });
    expect(streamIdOfPush(wire(push))).toBeUndefined();
  });

  it("an upgrade ring that ended opens the group's voice channel", () => {
    const push = callRingPush({
      callerName: "Ali",
      callId: "c1",
      ringSeconds: 30,
      target: { groupId: "g1", voiceChannelId: "v1" },
    });
    const target = parseNotificationTarget(wire(push))!;
    if (target.kind !== "callRing") throw new Error("expected callRing");
    expect(callRingDecision(target, { phase: "idle", callId: null })).toEqual({
      pathname: "/voice/[channelId]",
      params: { channelId: "v1", groupId: "g1" },
    });
  });

  it("a missed call opens the DM with the caller; without a route, the call log", () => {
    const routed = callMissedPush({
      callerName: "Ali",
      callId: "c1",
      reason: "timeout",
      dm: { dmId: "d1", channelId: "s1", userId: "u-ali" },
    });
    expect(notificationHref(parseNotificationTarget(wire(routed))!)).toEqual({
      pathname: "/dm/[dmId]",
      params: { dmId: "d1", streamId: "s1", name: "Ali", userId: "u-ali" },
    });
    expect(streamIdOfPush(wire(routed))).toBeUndefined(); // shows even with the DM open
    const bare = callMissedPush({ callerName: "Ali", callId: "c1", reason: "canceled" });
    expect(notificationHref(parseNotificationTarget(wire(bare))!)).toBe("/recent-calls");
  });

  it("friend pushes open the friends list", () => {
    for (const type of ["friend_request", "friend"]) {
      expect(notificationHref(parseNotificationTarget({ type, userId: "u" })!)).toBe("/friends");
    }
  });
});
