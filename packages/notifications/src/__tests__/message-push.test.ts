/**
 * DM message push builder — the exact payload both send paths (REST + WS) hand
 * the notifier, and the data contract the mobile tap router reads.
 */

import { describe, expect, it } from "vitest";
import {
  dmMessagePush,
  dmPushCollapseKey,
  MESSAGE_PUSH_TTL_SECONDS,
} from "../message-push.js";

describe("dmMessagePush", () => {
  const push = dmMessagePush({
    authorId: "u-ali",
    authorName: "Ali",
    dmId: "d1",
    channelId: "s1",
    messageId: "m1",
    content: "  selam   nasılsın ",
  });

  it("titles with the author and previews the collapsed body", () => {
    expect(push.title).toBe("Ali");
    expect(push.body).toBe("selam nasılsın");
  });

  it("carries everything the DM screen needs to open ready (stream, peer, name)", () => {
    expect(push.data).toEqual({
      type: "dm_message",
      dmId: "d1",
      channelId: "s1",
      messageId: "m1",
      userId: "u-ali",
      name: "Ali",
    });
  });

  it("groups a conversation into one rolling notification and expires stale lines", () => {
    expect(push.collapseKey).toBe(dmPushCollapseKey("d1"));
    expect(push.collapseKey).toBe("dm:d1");
    expect(push.ttlSeconds).toBe(MESSAGE_PUSH_TTL_SECONDS);
    expect(push.silent).toBeUndefined();
  });
});
