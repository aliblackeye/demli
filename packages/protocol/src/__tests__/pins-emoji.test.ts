import { describe, expect, it } from "vitest";
import { SERVER_EVENT, serverEvent } from "../factories.js";
import {
  customEmojiSchema,
  emojiCreatedPayloadSchema,
  emojiDeletedPayloadSchema,
  messageDTOSchema,
  messagePinnedPayloadSchema,
  messageUnpinnedPayloadSchema,
  serverToClientEventSchema,
} from "../schemas.js";
import type {
  EmojiCreatedPayload,
  EmojiDeletedPayload,
  MessagePinnedPayload,
  MessageUnpinnedPayload,
} from "../events.js";

const CHANNEL_ID = "11111111-1111-1111-1111-111111111111";
const MESSAGE_ID = "22222222-2222-2222-2222-222222222222";
const USER_ID = "33333333-3333-3333-3333-333333333333";
const GROUP_ID = "44444444-4444-4444-4444-444444444444";
const EMOJI_ID = "55555555-5555-5555-5555-555555555555";

describe("message.pinned / message.unpinned events (M17)", () => {
  it("exposes the SERVER_EVENT constants (no magic strings, §24)", () => {
    expect(SERVER_EVENT.messagePinned).toBe("message.pinned");
    expect(SERVER_EVENT.messageUnpinned).toBe("message.unpinned");
  });

  it("factory builds a pin event that round-trips through the schema", () => {
    const payload: MessagePinnedPayload = {
      channelId: CHANNEL_ID,
      messageId: MESSAGE_ID,
      pinnedBy: USER_ID,
      pinnedAt: "2026-07-22T10:00:00.000Z",
    };
    const event = serverEvent.messagePinned(payload);
    expect(event.type).toBe("message.pinned");
    expect(serverToClientEventSchema.parse(event)).toEqual(event);
  });

  it("factory builds an unpin event that round-trips through the schema", () => {
    const payload: MessageUnpinnedPayload = {
      channelId: CHANNEL_ID,
      messageId: MESSAGE_ID,
    };
    const event = serverEvent.messageUnpinned(payload);
    expect(serverToClientEventSchema.parse(event)).toEqual(event);
  });

  it("carries channelId so the mutation bus can route it (channel-scoped)", () => {
    // The bus requires exactly one scope id; a pin event without channelId could
    // not be routed and would silently never reach anyone.
    expect(messagePinnedPayloadSchema.shape.channelId).toBeDefined();
    expect(messageUnpinnedPayloadSchema.shape.channelId).toBeDefined();
  });

  it("rejects a pin payload missing its pin metadata", () => {
    expect(
      messagePinnedPayloadSchema.safeParse({
        channelId: CHANNEL_ID,
        messageId: MESSAGE_ID,
      }).success,
    ).toBe(false);
  });

  it("does NOT carry the message body — the board is fetched, not pushed (§27)", () => {
    const parsed = messagePinnedPayloadSchema.parse({
      channelId: CHANNEL_ID,
      messageId: MESSAGE_ID,
      pinnedBy: USER_ID,
      pinnedAt: "2026-07-22T10:00:00.000Z",
      // A well-meaning server that also pushed the message must have it stripped.
      message: { id: MESSAGE_ID, content: "should not travel" },
    });
    expect(parsed).not.toHaveProperty("message");
  });
});

describe("MessageDTO.pinned (M17)", () => {
  const base = {
    id: MESSAGE_ID,
    channelId: CHANNEL_ID,
    authorId: USER_ID,
    content: "hi",
    createdAt: "2026-07-22T10:00:00.000Z",
    updatedAt: null,
    deletedAt: null,
  };

  it("is optional — absent reads identically to not-pinned (pre-M17 compat)", () => {
    expect(messageDTOSchema.parse(base).pinned).toBeUndefined();
  });

  it("round-trips when present", () => {
    expect(messageDTOSchema.parse({ ...base, pinned: true }).pinned).toBe(true);
  });
});

describe("emoji.created / emoji.deleted events (M17)", () => {
  const emoji = {
    id: EMOJI_ID,
    groupId: GROUP_ID,
    name: "party_cat",
    mime: "image/png",
    sizeBytes: 4096,
    createdBy: USER_ID,
    createdAt: "2026-07-22T10:00:00.000Z",
  };

  it("exposes the SERVER_EVENT constants (no magic strings, §24)", () => {
    expect(SERVER_EVENT.emojiCreated).toBe("emoji.created");
    expect(SERVER_EVENT.emojiDeleted).toBe("emoji.deleted");
  });

  it("factory builds a create event that round-trips through the schema", () => {
    const payload: EmojiCreatedPayload = { groupId: GROUP_ID, emoji };
    const event = serverEvent.emojiCreated(payload);
    expect(event.type).toBe("emoji.created");
    expect(serverToClientEventSchema.parse(event)).toEqual(event);
  });

  it("factory builds a delete event that round-trips through the schema", () => {
    const payload: EmojiDeletedPayload = { groupId: GROUP_ID, emojiId: EMOJI_ID };
    expect(serverToClientEventSchema.parse(serverEvent.emojiDeleted(payload))).toEqual({
      type: "emoji.deleted",
      payload,
    });
  });

  it("carries groupId so the mutation bus can route it (group-scoped)", () => {
    expect(emojiCreatedPayloadSchema.shape.groupId).toBeDefined();
    expect(emojiDeletedPayloadSchema.shape.groupId).toBeDefined();
  });

  it("STRIPS storagePath — the bucket key must never reach a client (§28)", () => {
    // The security-critical assertion for this whole feature: even if a mapper
    // regressed and leaked the path, the codec on the mutation bus drops it.
    const parsed = customEmojiSchema.parse({
      ...emoji,
      storagePath: "emoji/g1/secret.png",
    });
    expect(parsed).not.toHaveProperty("storagePath");
  });

  it("strips a url too — emoji images are only ever short-lived signed URLs", () => {
    const parsed = customEmojiSchema.parse({ ...emoji, url: "https://leak.example/e.png" });
    expect(parsed).not.toHaveProperty("url");
  });

  it("rejects an emoji whose name exceeds the shortcode cap", () => {
    expect(customEmojiSchema.safeParse({ ...emoji, name: "a".repeat(33) }).success).toBe(false);
  });
});
