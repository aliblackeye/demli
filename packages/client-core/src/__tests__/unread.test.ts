/**
 * The shared unread-badge text rule (#110). Proves the "no fake number" contract:
 * a real count prints as-is (capped), an unknown-but-unread stream prints "1+",
 * and a read stream prints nothing.
 */
import { describe, expect, it } from "vitest";

import { UNREAD_BADGE_CAP, unreadBadgeText } from "../unread.js";

describe("unreadBadgeText", () => {
  it("shows nothing for a read stream (count 0, no flag)", () => {
    expect(unreadBadgeText(0, false)).toBeNull();
  });

  it("shows the neutral '1+' marker when unread but never counted (cold start)", () => {
    expect(unreadBadgeText(0, true)).toBe("1+");
  });

  it("shows the exact counted number", () => {
    expect(unreadBadgeText(1, true)).toBe("1");
    expect(unreadBadgeText(7, true)).toBe("7");
    expect(unreadBadgeText(UNREAD_BADGE_CAP, true)).toBe(String(UNREAD_BADGE_CAP));
  });

  it("caps large counts at '{CAP}+'", () => {
    expect(unreadBadgeText(UNREAD_BADGE_CAP + 1, true)).toBe(`${UNREAD_BADGE_CAP}+`);
    expect(unreadBadgeText(9999, true)).toBe(`${UNREAD_BADGE_CAP}+`);
  });

  it("a positive count wins even if the boolean flag was never set", () => {
    // Defensive: a counted delta implies unread regardless of the legacy flag.
    expect(unreadBadgeText(3, false)).toBe("3");
  });

  it("clamps a bad (negative / fractional) count instead of printing garbage", () => {
    expect(unreadBadgeText(-5, false)).toBeNull();
    expect(unreadBadgeText(-5, true)).toBe("1+");
    expect(unreadBadgeText(2.9, true)).toBe("2");
  });
});
