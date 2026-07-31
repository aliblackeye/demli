/**
 * Watch-party QUEUE contract (M20 wave 2, ADR 0016).
 *
 * The playback contract's centre of gravity is the video REFERENCE, because it
 * ends up inside an iframe URL. The queue adds a second untrusted string with a
 * different failure mode: the TITLE, which is one member's text rendered as a row
 * on everyone else's screen. It cannot execute anything — clients render it as
 * text — but it can lie about its own shape, so this file is mostly about the
 * boundary refusing embedded newlines, bidi overrides and zero-width characters
 * that would let one row impersonate several or read backwards.
 *
 * Plus the ordinary contract obligations: every new frame parses, `itemId` is a
 * uuid so mutations name an item rather than a position, and the arrays are
 * bounded by the same cap the gateway enforces.
 */

import { describe, expect, it } from "vitest";
import { WATCH_QUEUE_MAX_ITEMS, WATCH_QUEUE_TITLE_MAX_LENGTH } from "@demli/config";
import { clientEvent, CLIENT_EVENT, serverEvent, SERVER_EVENT } from "../factories.js";
import {
  clientToServerEventSchema,
  serverToClientEventSchema,
  watchQueueAddPayloadSchema,
  watchQueueItemSchema,
  watchQueueReorderPayloadSchema,
  watchQueueUpdatedPayloadSchema,
} from "../schemas.js";

const CH = "11111111-1111-4111-8111-111111111111";
const UID = "33333333-3333-4333-8333-333333333333";
const ITEM = "44444444-4444-4444-8444-444444444444";
const VIDEO = "dQw4w9WgXcQ";

/** Parse an add payload and hand back the sanitized title (or undefined). */
function parsedTitle(title: string): string | null | undefined {
  const parsed = watchQueueAddPayloadSchema.safeParse({
    channelId: CH,
    itemId: ITEM,
    videoRef: VIDEO,
    title,
  });
  if (!parsed.success) return undefined;
  return parsed.data.title;
}

describe("watch queue item ids", () => {
  it("requires a uuid, because a mutation names an ITEM and not a position", () => {
    // Indexes shift the instant anyone else acts on the queue (or the automatic
    // advance consumes its head), so the wire deliberately has no concept of one.
    for (const itemId of ["", "1", "first", "../../etc", "x".repeat(200)]) {
      expect(
        watchQueueAddPayloadSchema.safeParse({
          channelId: CH,
          itemId,
          videoRef: VIDEO,
        }).success,
        itemId,
      ).toBe(false);
    }
    expect(
      watchQueueAddPayloadSchema.safeParse({ channelId: CH, itemId: ITEM, videoRef: VIDEO })
        .success,
    ).toBe(true);
  });

  it("applies the same video-reference grammar as watch.start", () => {
    // Accepts what a person pastes…
    expect(
      watchQueueAddPayloadSchema.safeParse({
        channelId: CH,
        itemId: ITEM,
        videoRef: `https://www.youtube.com/watch?v=${VIDEO}&t=42`,
      }).success,
    ).toBe(true);
    // …and refuses the same hostile set the playback contract refuses, at the
    // boundary, so no handler ever sees it.
    for (const videoRef of [
      "https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ",
      "javascript:alert(1)",
      "../../etc/passwd",
      "dQw4w9WgXcQQQQ",
      "",
    ]) {
      expect(
        watchQueueAddPayloadSchema.safeParse({ channelId: CH, itemId: ITEM, videoRef })
          .success,
        videoRef,
      ).toBe(false);
    }
  });
});

describe("watch queue title sanitization", () => {
  it("keeps ordinary text intact", () => {
    expect(parsedTitle("PSY - GANGNAM STYLE (강남스타일) M/V")).toBe(
      "PSY - GANGNAM STYLE (강남스타일) M/V",
    );
  });

  it("collapses newlines so one row cannot look like several", () => {
    const title = parsedTitle("line one\nline two\r\nline three");
    expect(title).toBe("line one line two line three");
    expect(title).not.toContain("\n");
  });

  it("strips bidi overrides and zero-width characters", () => {
    // A bidi override would let a row render backwards; a zero-width joiner lets
    // text hide characters that are really there. Neither is display text.
    const title = parsedTitle("safe\u202Ereversed\u202C\u200Bhidden\u2066x\u2069");
    expect(title).not.toContain("\u202E");
    expect(title).not.toContain("\u202C");
    expect(title).not.toContain("\u200B");
    expect(title).not.toContain("\u2066");
    expect(title).toContain("safe");
  });

  it("turns a title that reduces to nothing into null, not an empty string", () => {
    // An empty title masquerading as a title would render a blank row.
    expect(parsedTitle("   ")).toBeNull();
    expect(parsedTitle("\n\t \u200B")).toBeNull();
  });

  it("bounds the stored title", () => {
    const title = parsedTitle("a".repeat(WATCH_QUEUE_TITLE_MAX_LENGTH * 2));
    expect(title).toHaveLength(WATCH_QUEUE_TITLE_MAX_LENGTH);
  });

  it("refuses an input so long it should never have been sent", () => {
    // Sanitizing is not a licence to accept a megabyte: the cap above trims what
    // a real title overshoots by, this refuses what is not a title at all.
    expect(parsedTitle("a".repeat(WATCH_QUEUE_TITLE_MAX_LENGTH * 4 + 1))).toBeUndefined();
  });

  it("is optional — a pasted link carries no metadata at all", () => {
    const parsed = watchQueueAddPayloadSchema.safeParse({
      channelId: CH,
      itemId: ITEM,
      videoRef: VIDEO,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.title).toBeUndefined();
  });
});

describe("watch queue frames", () => {
  it("round-trips every new client→server frame through the union", () => {
    const frames = [
      clientEvent.watchQueueAdd({
        channelId: CH,
        itemId: ITEM,
        videoRef: VIDEO,
        title: "Something",
        durationSeconds: 212,
      }),
      clientEvent.watchQueueRemove({ channelId: CH, itemId: ITEM }),
      clientEvent.watchQueueReorder({ channelId: CH, itemIds: [ITEM] }),
      clientEvent.watchQueuePlay({ channelId: CH, itemId: ITEM }),
      clientEvent.watchEnded({ channelId: CH, videoId: VIDEO }),
    ];
    for (const frame of frames) {
      expect(clientToServerEventSchema.safeParse(frame).success, frame.type).toBe(true);
    }
    expect(frames.map((f) => f.type)).toEqual([
      CLIENT_EVENT.watchQueueAdd,
      CLIENT_EVENT.watchQueueRemove,
      CLIENT_EVENT.watchQueueReorder,
      CLIENT_EVENT.watchQueuePlay,
      CLIENT_EVENT.watchEnded,
    ]);
  });

  it("round-trips the server→client queue frame", () => {
    const frame = serverEvent.watchQueueUpdated({
      channelId: CH,
      queue: [
        {
          itemId: ITEM,
          videoId: VIDEO,
          addedBy: UID,
          addedAt: new Date().toISOString(),
          title: "Something",
          durationSeconds: 212,
        },
      ],
    });
    expect(serverToClientEventSchema.safeParse(frame).success).toBe(true);
    expect(frame.type).toBe(SERVER_EVENT.watchQueueUpdated);
  });

  it("only ever emits a NORMALIZED video id on a queue row", () => {
    const row = {
      itemId: ITEM,
      addedBy: UID,
      addedAt: new Date().toISOString(),
      title: null,
      durationSeconds: null,
    };
    expect(watchQueueItemSchema.safeParse({ ...row, videoId: VIDEO }).success).toBe(true);
    // A server payload carrying a raw link would mean the gateway skipped its
    // own normalization; the schema is the tripwire for that.
    for (const videoId of [`https://youtu.be/${VIDEO}`, "short", ""]) {
      expect(watchQueueItemSchema.safeParse({ ...row, videoId }).success, videoId).toBe(false);
    }
  });

  it("caps both arrays at the queue limit", () => {
    const itemIds = Array.from({ length: WATCH_QUEUE_MAX_ITEMS + 1 }, (_, i) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    // An unbounded reorder would hand the server an arbitrary array to permute.
    expect(watchQueueReorderPayloadSchema.safeParse({ channelId: CH, itemIds }).success).toBe(
      false,
    );
    expect(
      watchQueueReorderPayloadSchema.safeParse({
        channelId: CH,
        itemIds: itemIds.slice(0, WATCH_QUEUE_MAX_ITEMS),
      }).success,
    ).toBe(true);

    const queue = itemIds.map((itemId) => ({
      itemId,
      videoId: VIDEO,
      addedBy: UID,
      addedAt: new Date().toISOString(),
      title: null,
      durationSeconds: null,
    }));
    expect(watchQueueUpdatedPayloadSchema.safeParse({ channelId: CH, queue }).success).toBe(
      false,
    );
  });

  it("accepts an empty reorder and an empty queue (both are real states)", () => {
    expect(
      watchQueueReorderPayloadSchema.safeParse({ channelId: CH, itemIds: [] }).success,
    ).toBe(true);
    expect(watchQueueUpdatedPayloadSchema.safeParse({ channelId: CH, queue: [] }).success).toBe(
      true,
    );
  });

  it("requires watch.ended to name a normalized id (the idempotency guard)", () => {
    // The id is what makes a duplicate ENDED harmless; a frame without a usable
    // one would have to be trusted blindly.
    expect(
      clientToServerEventSchema.safeParse({
        type: CLIENT_EVENT.watchEnded,
        payload: { channelId: CH, videoId: `https://youtu.be/${VIDEO}` },
      }).success,
    ).toBe(false);
    expect(
      clientToServerEventSchema.safeParse({
        type: CLIENT_EVENT.watchEnded,
        payload: { channelId: CH },
      }).success,
    ).toBe(false);
  });
});
