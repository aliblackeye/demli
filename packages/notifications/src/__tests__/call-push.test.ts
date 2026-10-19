/**
 * Call pushes: the Android channel, the time-to-live, the shared collapse tag,
 * and the silent "answered elsewhere" signal — asserted on the EXACT Expo
 * message the service hands to the push provider.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ExpoPushMessage, ExpoPushTicket } from "expo-server-sdk";
import type { UserPushToken } from "@demli/db";
import {
  ANDROID_PUSH_CHANNEL_ID,
  CALL_CLEARED_PUSH_TTL_SECONDS,
  CALL_MISSED_PUSH_TTL_SECONDS,
  callClearedPush,
  callMissedPush,
  callPushTag,
  callRingPush,
  ExpoPushService,
} from "../index.js";

async function send(notification: Parameters<ExpoPushService["sendToUsers"]>[1]): Promise<ExpoPushMessage> {
  const sent: ExpoPushMessage[] = [];
  const rows: UserPushToken[] = [{ userId: "u1", token: "ExponentPushToken[a]", platform: "android" }];
  const svc = new ExpoPushService({
    tokens: {
      listTokensForUsers: async () => rows,
      deleteByTokens: async () => 0,
    },
    expo: {
      chunkPushNotifications: (messages) => [messages],
      sendPushNotificationsAsync: async (messages) => {
        sent.push(...messages);
        return messages.map(() => ({ status: "ok", id: "r" }) as ExpoPushTicket);
      },
    },
  });
  await svc.sendToUsers(["u1"], notification);
  expect(sent).toHaveLength(1);
  return sent[0]!;
}

describe("call pushes", () => {
  it("every push names the channel the mobile app creates", async () => {
    const ring = await send(
      callRingPush({ callerName: "Ali", callId: "c1", ringSeconds: 30, target: { dmId: "d1" } }),
    );
    const message = await send({ title: "Ada", body: "hi" });
    expect(ring.channelId).toBe(ANDROID_PUSH_CHANNEL_ID);
    expect(message.channelId).toBe(ANDROID_PUSH_CHANNEL_ID);
  });

  it("the server's channel id is the one apps/mobile actually creates", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../../../apps/mobile/src/push/push-manager.ts", import.meta.url)),
      "utf8",
    );
    const match = /const ANDROID_CHANNEL_ID = "([^"]+)"/.exec(source);
    expect(match?.[1]).toBe(ANDROID_PUSH_CHANNEL_ID);
  });

  it("a ring expires with the ring window; an untimed push keeps the provider default", async () => {
    const ring = await send(
      callRingPush({ callerName: "Ali", callId: "c1", ringSeconds: 30, target: { dmId: "d1" } }),
    );
    expect(ring).toMatchObject({
      ttl: 30,
      title: "Ali",
      body: "is calling you.",
      priority: "high",
      tag: callPushTag("c1"),
      collapseId: callPushTag("c1"),
      data: { type: "call_invite", callId: "c1", dmId: "d1" },
    });
    expect((await send({ title: "t", body: "b" })).ttl).toBeUndefined();
  });

  it("the upgrade invite rings on the same per-call slot", async () => {
    const invite = await send(
      callRingPush({
        callerName: "Ali",
        callId: "c1",
        ringSeconds: 30,
        target: { groupId: "g1", voiceChannelId: "v1" },
      }),
    );
    expect(invite).toMatchObject({
      body: "added you to a call.",
      tag: callPushTag("c1"),
      data: { type: "call_invite", callId: "c1", groupId: "g1", voiceChannelId: "v1" },
    });
  });

  it("a missed-call retraction replaces the ring on the same tag", async () => {
    const missed = await send(callMissedPush({ callerName: "Ali", callId: "c1", reason: "timeout" }));
    expect(missed).toMatchObject({
      title: "Ali",
      body: "Missed call",
      tag: callPushTag("c1"),
      ttl: CALL_MISSED_PUSH_TTL_SECONDS,
      data: { type: "call_ended", callId: "c1", reason: "timeout" },
    });
  });

  it("answered elsewhere is silent: no title, body or sound, but the call_ended data", async () => {
    const cleared = await send(callClearedPush({ callId: "c1", reason: "answered" }));
    expect(cleared.title).toBeUndefined();
    expect(cleared.body).toBeUndefined();
    expect(cleared.sound).toBeUndefined();
    expect(cleared).toMatchObject({
      _contentAvailable: true,
      ttl: CALL_CLEARED_PUSH_TTL_SECONDS,
      data: { type: "call_ended", callId: "c1", reason: "answered" },
    });
  });
});
