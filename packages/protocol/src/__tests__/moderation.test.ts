/**
 * Server-moderation events (migration 0017): `member.kicked` / `member.banned`
 * (user-scoped notices) and `voice.disconnected` (user-scoped voice boot). Every
 * event name is a typed literal built through the factories, and the schema mirrors
 * the union — these tests assert acceptance, rejection, and a JSON wire round-trip.
 */

import { describe, expect, it } from "vitest";
import { SERVER_EVENT, serverEvent } from "../factories.js";
import { serverToClientEventSchema } from "../schemas.js";

const GROUP_ID = "11111111-1111-1111-1111-111111111111";
const CHANNEL_ID = "22222222-2222-2222-2222-222222222222";

describe("member.kicked / member.banned", () => {
  it("exposes stable SERVER_EVENT name constants", () => {
    expect(SERVER_EVENT.memberKicked).toBe("member.kicked");
    expect(SERVER_EVENT.memberBanned).toBe("member.banned");
  });

  it("accepts well-formed kicked/banned events", () => {
    expect(
      serverToClientEventSchema.safeParse(
        serverEvent.memberKicked({ groupId: GROUP_ID, groupName: "Film Night" }),
      ).success,
    ).toBe(true);
    expect(
      serverToClientEventSchema.safeParse(
        serverEvent.memberBanned({ groupId: GROUP_ID, groupName: "Film Night" }),
      ).success,
    ).toBe(true);
  });

  it("carries groupName so the notice renders after the group is dropped", () => {
    const event = serverEvent.memberKicked({ groupId: GROUP_ID, groupName: "Film Night" });
    if (event.type === SERVER_EVENT.memberKicked) {
      expect(event.payload.groupName).toBe("Film Night");
    }
  });

  it("rejects a kicked event missing groupName", () => {
    expect(
      serverToClientEventSchema.safeParse({
        type: "member.kicked",
        payload: { groupId: GROUP_ID },
      }).success,
    ).toBe(false);
  });

  it("survives a JSON wire round-trip and re-validates", () => {
    const event = serverEvent.memberBanned({ groupId: GROUP_ID, groupName: "Film Night" });
    const decoded = serverToClientEventSchema.parse(JSON.parse(JSON.stringify(event)));
    expect(decoded).toEqual(event);
  });
});

describe("voice.disconnected", () => {
  it("exposes a stable SERVER_EVENT name constant", () => {
    expect(SERVER_EVENT.voiceDisconnected).toBe("voice.disconnected");
  });

  it("accepts a well-formed disconnect with the moderator reason", () => {
    const result = serverToClientEventSchema.safeParse(
      serverEvent.voiceDisconnected({
        roomId: CHANNEL_ID,
        channelId: CHANNEL_ID,
        reason: "moderator",
      }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects any reason outside the closed enum", () => {
    expect(
      serverToClientEventSchema.safeParse({
        type: "voice.disconnected",
        payload: { roomId: CHANNEL_ID, channelId: CHANNEL_ID, reason: "kicked" },
      }).success,
    ).toBe(false);
  });

  it("survives a JSON wire round-trip and re-validates", () => {
    const event = serverEvent.voiceDisconnected({
      roomId: CHANNEL_ID,
      channelId: CHANNEL_ID,
      reason: "moderator",
    });
    const decoded = serverToClientEventSchema.parse(JSON.parse(JSON.stringify(event)));
    expect(decoded).toEqual(event);
  });
});
