/**
 * Pure positioning proof for the in-thread "New Messages" divider. The same
 * logic ships on desktop (renderer/lib/unread-divider.ts); this guards the
 * conservative rules so the divider never lands in a misleading spot.
 */
import { describe, expect, it } from "vitest";
import { firstUnreadMessageId } from "../unread-divider";

const ascending = ["m1", "m2", "m3", "m4", "m5"];

describe("firstUnreadMessageId", () => {
  it("returns null with no watermark (first-ever visit)", () => {
    expect(firstUnreadMessageId(ascending, null)).toBeNull();
    expect(firstUnreadMessageId(ascending, undefined)).toBeNull();
  });

  it("returns null on an empty message window", () => {
    expect(firstUnreadMessageId([], "m3")).toBeNull();
  });

  it("anchors on the message directly after the watermark", () => {
    expect(firstUnreadMessageId(ascending, "m3")).toBe("m4");
    expect(firstUnreadMessageId(ascending, "m1")).toBe("m2");
  });

  it("returns null when the watermark is the newest message (all read)", () => {
    expect(firstUnreadMessageId(ascending, "m5")).toBeNull();
  });

  it("falls back to the oldest loaded message when the watermark is older than the window", () => {
    // Watermark scrolled out of / never in the loaded window → whole window is new.
    expect(firstUnreadMessageId(ascending, "m0")).toBe("m1");
  });
});
