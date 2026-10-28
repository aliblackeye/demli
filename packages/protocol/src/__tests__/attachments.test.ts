import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_LIMITS,
  ATTACHMENT_MAX_PER_MESSAGE,
  attachmentKindForMime,
} from "@demli/config";
import { ATTACHMENT_KINDS, type Attachment } from "@demli/types";
import { clientEvent, serverEvent } from "../factories.js";
import type { MessageDTO } from "../events.js";
import {
  attachmentDTOSchema,
  attachmentUrlSchema,
  clientToServerEventSchema,
  messageDTOSchema,
  sendMessagePayloadSchema,
  serverToClientEventSchema,
} from "../schemas.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const imageAttachment: Attachment = {
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  messageId: "11111111-1111-1111-1111-111111111111",
  channelId: "22222222-2222-2222-2222-222222222222",
  uploaderId: "33333333-3333-3333-3333-333333333333",
  kind: "image",
  mime: "image/png",
  sizeBytes: 2048,
  width: 800,
  height: 600,
  durationMs: null,
  isVoiceMessage: false,
  createdAt: "2026-07-08T10:00:00.000Z",
};

const audioAttachment: Attachment = {
  ...imageAttachment,
  id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  kind: "audio",
  mime: "audio/mpeg",
  width: null,
  height: null,
  durationMs: 30_000,
  isVoiceMessage: false,
};

const baseMessage: MessageDTO = {
  id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
  channelId: imageAttachment.channelId,
  authorId: imageAttachment.uploaderId,
  content: "look at this",
  kind: "user",
  createdAt: "2026-07-08T10:00:01.000Z",
  updatedAt: null,
  deletedAt: null,
};

// ---------------------------------------------------------------------------
// Config — whitelist / caps consistency (@demli/config)
// ---------------------------------------------------------------------------

describe("ATTACHMENT limits config", () => {
  it("caps a positive number of attachments per message", () => {
    expect(ATTACHMENT_MAX_PER_MESSAGE).toBeGreaterThan(0);
    expect(Number.isInteger(ATTACHMENT_MAX_PER_MESSAGE)).toBe(true);
  });

  it("covers exactly the attachment_kind union — no missing or extra kind", () => {
    expect(new Set(Object.keys(ATTACHMENT_LIMITS))).toEqual(new Set(ATTACHMENT_KINDS));
  });

  it("gives every kind a positive byte cap and a non-empty MIME list", () => {
    for (const kind of ATTACHMENT_KINDS) {
      const limit = ATTACHMENT_LIMITS[kind];
      expect(limit.maxBytes).toBeGreaterThan(0);
      expect(limit.mimes.length).toBeGreaterThan(0);
    }
  });

  it("has no MIME appearing in more than one kind (a MIME maps to one kind)", () => {
    const all = ATTACHMENT_KINDS.flatMap((k) => ATTACHMENT_LIMITS[k].mimes);
    expect(new Set(all).size).toBe(all.length);
  });

  it("never whitelists SVG (stored-XSS vector, ADR 0008 §4/§5)", () => {
    const all = ATTACHMENT_KINDS.flatMap((k) => [...ATTACHMENT_LIMITS[k].mimes]);
    expect(all).not.toContain("image/svg+xml");
  });
});

describe("attachmentKindForMime", () => {
  it("maps every whitelisted MIME back to its own kind", () => {
    for (const kind of ATTACHMENT_KINDS) {
      for (const mime of ATTACHMENT_LIMITS[kind].mimes) {
        expect(attachmentKindForMime(mime)).toBe(kind);
      }
    }
  });

  it("returns null for a non-whitelisted MIME", () => {
    expect(attachmentKindForMime("image/svg+xml")).toBeNull();
    expect(attachmentKindForMime("application/pdf")).toBeNull();
    expect(attachmentKindForMime("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// attachmentDTOSchema — metadata only, no URL / no storagePath leak
// ---------------------------------------------------------------------------

describe("attachmentDTOSchema", () => {
  it("accepts a well-formed image (dimensions set, duration null)", () => {
    expect(attachmentDTOSchema.parse(imageAttachment)).toEqual(imageAttachment);
  });

  it("accepts a well-formed audio clip (dimensions null, duration set)", () => {
    expect(attachmentDTOSchema.safeParse(audioAttachment).success).toBe(true);
  });

  it("accepts a null messageId (still inside the upload window)", () => {
    expect(attachmentDTOSchema.safeParse({ ...imageAttachment, messageId: null }).success).toBe(
      true,
    );
  });

  it("rejects a missing required field", () => {
    const { mime: _mime, ...rest } = imageAttachment;
    expect(attachmentDTOSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects an unknown kind", () => {
    expect(attachmentDTOSchema.safeParse({ ...imageAttachment, kind: "document" }).success).toBe(
      false,
    );
  });

  it("rejects a negative or non-integer sizeBytes", () => {
    expect(attachmentDTOSchema.safeParse({ ...imageAttachment, sizeBytes: -1 }).success).toBe(false);
    expect(attachmentDTOSchema.safeParse({ ...imageAttachment, sizeBytes: 1.5 }).success).toBe(
      false,
    );
  });

  it("strips a server-internal storagePath if one is ever sent (never surfaced)", () => {
    const parsed = attachmentDTOSchema.parse({
      ...imageAttachment,
      storagePath: "attachments/secret/obj.png",
    });
    expect("storagePath" in parsed).toBe(false);
  });

  it("does not carry a signed URL field on the message-side shape", () => {
    const parsed = attachmentDTOSchema.parse({ ...imageAttachment, url: "https://leak" });
    expect("url" in parsed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// attachmentUrlSchema — the ONLY place a signed URL appears on the wire
// ---------------------------------------------------------------------------

describe("attachmentUrlSchema", () => {
  it("accepts a signed URL response, with and without a thumbnail", () => {
    expect(
      attachmentUrlSchema.safeParse({
        attachmentId: imageAttachment.id,
        url: "https://storage.example/signed",
        urlExpiresAt: "2026-07-08T11:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      attachmentUrlSchema.safeParse({
        attachmentId: imageAttachment.id,
        url: "https://storage.example/signed",
        urlExpiresAt: "2026-07-08T11:00:00.000Z",
        thumbnailUrl: "https://storage.example/thumb",
      }).success,
    ).toBe(true);
  });

  it("rejects a response missing the url", () => {
    expect(
      attachmentUrlSchema.safeParse({
        attachmentId: imageAttachment.id,
        urlExpiresAt: "2026-07-08T11:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// messageDTOSchema — additive attachments (backward compatible)
// ---------------------------------------------------------------------------

describe("messageDTOSchema with attachments", () => {
  it("accepts a text-only message with no attachments field (pre-M10 shape)", () => {
    expect(messageDTOSchema.safeParse(baseMessage).success).toBe(true);
  });

  it("accepts a message carrying attachments", () => {
    const withAttachments = { ...baseMessage, attachments: [imageAttachment, audioAttachment] };
    expect(messageDTOSchema.safeParse(withAttachments).success).toBe(true);
  });

  it("accepts an empty attachments array", () => {
    expect(messageDTOSchema.safeParse({ ...baseMessage, attachments: [] }).success).toBe(true);
  });

  it("rejects an attachment with a malformed member", () => {
    const bad = { ...baseMessage, attachments: [{ ...imageAttachment, sizeBytes: "big" }] };
    expect(messageDTOSchema.safeParse(bad).success).toBe(false);
  });

  it("survives a JSON wire round-trip via message.created", () => {
    const event = serverEvent.messageCreated({
      ...baseMessage,
      attachments: [imageAttachment],
    });
    const decoded = serverToClientEventSchema.parse(JSON.parse(JSON.stringify(event)));
    expect(decoded).toEqual(event);
  });
});

// ---------------------------------------------------------------------------
// sendMessagePayloadSchema — content OR attachments (additive, back-compat)
// ---------------------------------------------------------------------------

describe("sendMessagePayloadSchema", () => {
  const base = { channelId: baseMessage.channelId, nonce: "nonce-1" };

  it("accepts a text-only send with no attachmentIds (pre-M10 behavior)", () => {
    expect(sendMessagePayloadSchema.safeParse({ ...base, content: "hello" }).success).toBe(true);
  });

  it("accepts an attachment-only send with empty content (caption-less gif)", () => {
    expect(
      sendMessagePayloadSchema.safeParse({
        ...base,
        content: "",
        attachmentIds: [imageAttachment.id],
      }).success,
    ).toBe(true);
  });

  it("accepts text plus attachments", () => {
    expect(
      sendMessagePayloadSchema.safeParse({
        ...base,
        content: "caption",
        attachmentIds: [imageAttachment.id],
      }).success,
    ).toBe(true);
  });

  it("rejects an empty/whitespace content with no attachments", () => {
    expect(sendMessagePayloadSchema.safeParse({ ...base, content: "" }).success).toBe(false);
    expect(sendMessagePayloadSchema.safeParse({ ...base, content: "   " }).success).toBe(false);
    expect(
      sendMessagePayloadSchema.safeParse({ ...base, content: "", attachmentIds: [] }).success,
    ).toBe(false);
  });

  it("rejects more than ATTACHMENT_MAX_PER_MESSAGE attachmentIds", () => {
    const tooMany = Array.from(
      { length: ATTACHMENT_MAX_PER_MESSAGE + 1 },
      (_v, i) => `att-${i}`,
    );
    expect(
      sendMessagePayloadSchema.safeParse({ ...base, content: "x", attachmentIds: tooMany }).success,
    ).toBe(false);
  });

  it("builds a valid attachment-carrying send through the client factory", () => {
    const event = clientEvent.messageSend({
      channelId: baseMessage.channelId,
      content: "",
      nonce: "nonce-2",
      attachmentIds: [imageAttachment.id],
    });
    expect(clientToServerEventSchema.safeParse(event).success).toBe(true);
  });
});
