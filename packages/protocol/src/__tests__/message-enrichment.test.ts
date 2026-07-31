/**
 * M14 message-enrichment protocol contract tests (ADR 0011).
 *
 * Covers the additive, backward-compatible extensions:
 * - messageReactionSummarySchema / messageReplyPreviewSchema shape validation
 * - messageDTOSchema carrying reactions + replyTo (and staying valid without them)
 * - sendMessagePayloadSchema accepting an optional replyToMessageId
 * - the two channel-scoped reaction events (schemas, factories, SERVER_EVENT
 *   constants, JSON wire round-trip through the server union)
 */

import { describe, expect, it } from "vitest";
import { REACTION_EMOJI, isReactionEmoji } from "@demli/config";
import { serverEvent } from "../factories.js";
import { SERVER_EVENT } from "../factories.js";
import type { MessageDTO } from "../events.js";
import {
  clientToServerEventSchema,
  messageDTOSchema,
  messageReactionPayloadSchema,
  messageReactionSummarySchema,
  messageReplyPreviewSchema,
  sendMessagePayloadSchema,
  serverToClientEventSchema,
} from "../schemas.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CHANNEL = "22222222-2222-2222-2222-222222222222";
const AUTHOR = "33333333-3333-3333-3333-333333333333";
const MSG = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const TARGET = "dddddddd-dddd-dddd-dddd-dddddddddddd";

const baseMessage: MessageDTO = {
  id: MSG,
  channelId: CHANNEL,
  authorId: AUTHOR,
  content: "look at this",
  kind: "user",
  createdAt: "2026-07-15T10:00:01.000Z",
  updatedAt: null,
  deletedAt: null,
};

const replyPreview = {
  id: TARGET,
  authorId: AUTHOR,
  content: "the quoted message",
  kind: "user" as const,
  deleted: false,
};

// ---------------------------------------------------------------------------
// Config palette
// ---------------------------------------------------------------------------

describe("REACTION_EMOJI palette", () => {
  it("is a non-empty set of distinct emoji", () => {
    expect(REACTION_EMOJI.length).toBeGreaterThan(0);
    expect(new Set(REACTION_EMOJI).size).toBe(REACTION_EMOJI.length);
  });

  it("isReactionEmoji accepts palette members and rejects anything else", () => {
    for (const e of REACTION_EMOJI) expect(isReactionEmoji(e)).toBe(true);
    expect(isReactionEmoji("🦄")).toBe(false);
    expect(isReactionEmoji("not-an-emoji")).toBe(false);
    expect(isReactionEmoji("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Enrichment sub-schemas
// ---------------------------------------------------------------------------

describe("messageReactionSummarySchema", () => {
  it("accepts a well-formed summary entry", () => {
    expect(
      messageReactionSummarySchema.safeParse({ emoji: "👍", count: 3, reactedByMe: true }).success,
    ).toBe(true);
  });

  it("rejects a negative or non-integer count", () => {
    expect(
      messageReactionSummarySchema.safeParse({ emoji: "👍", count: -1, reactedByMe: false }).success,
    ).toBe(false);
    expect(
      messageReactionSummarySchema.safeParse({ emoji: "👍", count: 1.5, reactedByMe: false }).success,
    ).toBe(false);
  });

  it("rejects a missing field", () => {
    expect(messageReactionSummarySchema.safeParse({ emoji: "👍", count: 1 }).success).toBe(false);
  });
});

describe("messageReplyPreviewSchema", () => {
  it("accepts a normal preview and a deleted stub", () => {
    expect(messageReplyPreviewSchema.safeParse(replyPreview).success).toBe(true);
    expect(
      messageReplyPreviewSchema.safeParse({ ...replyPreview, deleted: true, content: "" }).success,
    ).toBe(true);
  });

  it("rejects an unknown kind and a missing deleted flag", () => {
    expect(messageReplyPreviewSchema.safeParse({ ...replyPreview, kind: "bot" }).success).toBe(false);
    const { deleted: _d, ...noDeleted } = replyPreview;
    expect(messageReplyPreviewSchema.safeParse(noDeleted).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// messageDTOSchema — additive reactions + replyTo (backward compatible)
// ---------------------------------------------------------------------------

describe("messageDTOSchema with enrichment", () => {
  it("accepts a message with neither field (pre-M14 shape)", () => {
    expect(messageDTOSchema.safeParse(baseMessage).success).toBe(true);
  });

  it("accepts reactions + a reply preview", () => {
    const enriched = {
      ...baseMessage,
      reactions: [{ emoji: "👍", count: 2, reactedByMe: true }],
      replyTo: replyPreview,
    };
    expect(messageDTOSchema.safeParse(enriched).success).toBe(true);
  });

  it("accepts replyTo: null and an empty reactions array", () => {
    expect(
      messageDTOSchema.safeParse({ ...baseMessage, replyTo: null, reactions: [] }).success,
    ).toBe(true);
  });

  it("rejects a malformed reaction entry", () => {
    const bad = { ...baseMessage, reactions: [{ emoji: "👍", count: "lots", reactedByMe: true }] };
    expect(messageDTOSchema.safeParse(bad).success).toBe(false);
  });

  it("survives a JSON wire round-trip via message.created", () => {
    const event = serverEvent.messageCreated({
      ...baseMessage,
      reactions: [{ emoji: "🔥", count: 1, reactedByMe: false }],
      replyTo: replyPreview,
    });
    const decoded = serverToClientEventSchema.parse(JSON.parse(JSON.stringify(event)));
    expect(decoded).toEqual(event);
  });

  it("strips the raw replyToMessageId FK if a mapper leaks it (wire carries the preview)", () => {
    const parsed = messageDTOSchema.parse({ ...baseMessage, replyToMessageId: TARGET });
    expect("replyToMessageId" in parsed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sendMessagePayloadSchema — optional replyToMessageId (additive)
// ---------------------------------------------------------------------------

describe("sendMessagePayloadSchema with replyToMessageId", () => {
  const base = { channelId: CHANNEL, nonce: "nonce-1" };

  it("accepts a send with no replyToMessageId (pre-M14 behavior)", () => {
    expect(sendMessagePayloadSchema.safeParse({ ...base, content: "hi" }).success).toBe(true);
  });

  it("accepts a reply send", () => {
    expect(
      sendMessagePayloadSchema.safeParse({ ...base, content: "hi", replyToMessageId: TARGET })
        .success,
    ).toBe(true);
  });

  it("still rejects an empty text send with no attachments", () => {
    expect(
      sendMessagePayloadSchema.safeParse({ ...base, content: "", replyToMessageId: TARGET }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Reaction events — schemas, factories, SERVER_EVENT constants, round-trip
// ---------------------------------------------------------------------------

describe("reaction events (message.reaction_added / _removed)", () => {
  const payload = { channelId: CHANNEL, messageId: MSG, emoji: "👍", userId: AUTHOR };

  it("exposes both event-name constants", () => {
    expect(SERVER_EVENT.messageReactionAdded).toBe("message.reaction_added");
    expect(SERVER_EVENT.messageReactionRemoved).toBe("message.reaction_removed");
  });

  it("payload schema accepts a valid delta and rejects a missing field", () => {
    expect(messageReactionPayloadSchema.safeParse(payload).success).toBe(true);
    const { emoji: _e, ...noEmoji } = payload;
    expect(messageReactionPayloadSchema.safeParse(noEmoji).success).toBe(false);
  });

  it("factories build events that round-trip through the server union", () => {
    for (const event of [
      serverEvent.messageReactionAdded(payload),
      serverEvent.messageReactionRemoved(payload),
    ]) {
      const decoded = serverToClientEventSchema.parse(JSON.parse(JSON.stringify(event)));
      expect(decoded).toEqual(event);
    }
  });

  it("is not a client→server event", () => {
    expect(
      clientToServerEventSchema.safeParse({ type: "message.reaction_added", payload }).success,
    ).toBe(false);
  });
});
