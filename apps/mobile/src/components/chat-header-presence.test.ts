/**
 * Conversation-header presence logic (founder P0: "in a DM I can't tell whether
 * the other person is online"). Proves the wording rules the DM header shows and
 * the online fold the group/channel header summarizes with — the pure half of
 * ChatHeaderTitle.tsx.
 */
import { describe, expect, it } from "vitest";
import type { PresenceStatus, UserId } from "@demli/types";
import { countOnline, presenceLabelKey, showsMobileGlyph } from "./chat-header-presence";

const A = "u-a" as UserId;
const B = "u-b" as UserId;
const C = "u-c" as UserId;

describe("presenceLabelKey", () => {
  it("plain statuses when the platform is unknown or desktop", () => {
    expect(presenceLabelKey("online")).toBe("mobile:presence.online");
    expect(presenceLabelKey("idle")).toBe("mobile:presence.idle");
    expect(presenceLabelKey("offline")).toBe("mobile:presence.offline");
    expect(presenceLabelKey("online", "desktop")).toBe("mobile:presence.online");
    expect(presenceLabelKey("idle", "desktop")).toBe("mobile:presence.idle");
  });

  it("mobile-connected peers get the platform-aware wording", () => {
    expect(presenceLabelKey("online", "mobile")).toBe("mobile:presence.onlineOnMobile");
    expect(presenceLabelKey("idle", "mobile")).toBe("mobile:presence.idleOnMobile");
  });

  it("offline never claims a platform (a stale mobile flag can't say 'on mobile')", () => {
    expect(presenceLabelKey("offline", "mobile")).toBe("mobile:presence.offline");
    expect(showsMobileGlyph("offline", "mobile")).toBe(false);
  });

  it("the phone glyph tracks exactly the platform-aware wording", () => {
    expect(showsMobileGlyph("online", "mobile")).toBe(true);
    expect(showsMobileGlyph("idle", "mobile")).toBe(true);
    expect(showsMobileGlyph("online", "desktop")).toBe(false);
    expect(showsMobileGlyph("online")).toBe(false);
  });
});

describe("countOnline", () => {
  const presence: Record<UserId, PresenceStatus> = {
    [A]: "online",
    [B]: "idle",
    [C]: "offline",
  };

  it("counts online AND idle as present (idle still means connected)", () => {
    expect(countOnline(presence, [A, B, C])).toBe(2);
  });

  it("a member with no presence entry reads as offline", () => {
    expect(countOnline(presence, [A, "u-missing" as UserId])).toBe(1);
  });

  it("empty roster folds to zero", () => {
    expect(countOnline(presence, [])).toBe(0);
  });

  it("is a pure fold — same inputs, same number (safe inside a store selector)", () => {
    // The header subscribes via `useChatStore((s) => countOnline(s.presence, ids))`;
    // a stable number is what keeps a presence tick from re-rendering it (§27).
    expect(countOnline(presence, [A, B])).toBe(countOnline(presence, [A, B]));
  });
});
