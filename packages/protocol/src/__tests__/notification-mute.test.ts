import { describe, expect, it } from "vitest";
import { SERVER_EVENT, serverEvent } from "../factories.js";
import {
  notificationMuteUpdatedPayloadSchema,
  serverToClientEventSchema,
} from "../schemas.js";
import type { NotificationMuteUpdatedPayload } from "../events.js";

const CHANNEL_ID = "11111111-1111-1111-1111-111111111111";
const GROUP_ID = "22222222-2222-2222-2222-222222222222";

describe("notification_mute.updated event (migration 0013)", () => {
  it("exposes the SERVER_EVENT constant (no magic strings, §24)", () => {
    expect(SERVER_EVENT.notificationMuteUpdated).toBe("notification_mute.updated");
  });

  it("factory builds a channel-scope mute event that round-trips through the schema", () => {
    const payload: NotificationMuteUpdatedPayload = {
      scope: "channel",
      targetId: CHANNEL_ID,
      mute: { mode: "mentions", until: "2026-07-17T12:00:00.000Z" },
    };
    const event = serverEvent.notificationMuteUpdated(payload);
    expect(event.type).toBe("notification_mute.updated");

    const parsed = serverToClientEventSchema.parse(event);
    expect(parsed).toEqual(event);
  });

  it("accepts a group-scope indefinite mute (until null)", () => {
    const payload: NotificationMuteUpdatedPayload = {
      scope: "group",
      targetId: GROUP_ID,
      mute: { mode: "all", until: null },
    };
    expect(notificationMuteUpdatedPayloadSchema.parse(payload)).toEqual(payload);
  });

  it("accepts an unmute (mute null) — the cross-device 'dropped' signal", () => {
    const payload: NotificationMuteUpdatedPayload = {
      scope: "group",
      targetId: GROUP_ID,
      mute: null,
    };
    const event = serverEvent.notificationMuteUpdated(payload);
    expect(serverToClientEventSchema.parse(event)).toEqual(event);
  });

  it("rejects an unknown scope and an unknown mode", () => {
    expect(
      notificationMuteUpdatedPayloadSchema.safeParse({
        scope: "server",
        targetId: GROUP_ID,
        mute: null,
      }).success,
    ).toBe(false);
    expect(
      notificationMuteUpdatedPayloadSchema.safeParse({
        scope: "channel",
        targetId: CHANNEL_ID,
        mute: { mode: "loud", until: null },
      }).success,
    ).toBe(false);
  });
});
