import { describe, expect, it } from "vitest";
import { PERMISSIONS, type ModerationActionEntry, type PermissionBit } from "@demli/types";
import type { ModerationLogPage } from "../clients";
import { canSeeModerationLog, flattenModerationLog } from "../moderation-log";

/** A `can(bit)` that only grants the listed bits. */
function grants(...bits: PermissionBit[]): (bit: PermissionBit) => boolean {
  const set = new Set<number>(bits);
  return (bit) => set.has(bit);
}

function entry(id: string): ModerationActionEntry {
  return {
    action: {
      id,
      groupId: "g1" as ModerationActionEntry["action"]["groupId"],
      actorId: null,
      targetId: "u1" as ModerationActionEntry["action"]["targetId"],
      action: "kick",
      reason: null,
      expiresAt: null,
      createdAt: "2026-07-27T10:00:00.000Z",
    },
    actor: null,
    target: null,
  };
}

function page(ids: string[], nextCursor: string | null = null): ModerationLogPage {
  return { entries: ids.map(entry), nextCursor };
}

describe("canSeeModerationLog", () => {
  it("shows it to the server owner even with no permission bits", () => {
    expect(canSeeModerationLog(true, grants())).toBe(true);
  });

  it("shows it to a non-owner holding KICK_MEMBERS", () => {
    expect(canSeeModerationLog(false, grants(PERMISSIONS.KICK_MEMBERS))).toBe(true);
  });

  it("HIDES it from a member with no moderation authority", () => {
    expect(canSeeModerationLog(false, grants())).toBe(false);
  });

  it("HIDES it from a member holding unrelated permissions", () => {
    // MANAGE_ROLES / MANAGE_CHANNELS are not moderation authority — a role
    // manager who cannot kick must not see who was kicked.
    expect(
      canSeeModerationLog(false, grants(PERMISSIONS.MANAGE_ROLES, PERMISSIONS.MANAGE_CHANNELS)),
    ).toBe(false);
  });
});

describe("flattenModerationLog", () => {
  it("returns an empty list for no pages", () => {
    expect(flattenModerationLog(undefined)).toEqual([]);
    expect(flattenModerationLog([])).toEqual([]);
  });

  it("concatenates pages in order (newest page first)", () => {
    const flat = flattenModerationLog([page(["a", "b"], "cur"), page(["c", "d"])]);
    expect(flat.map((e) => e.action.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("never yields the same action twice across page boundaries", () => {
    // A page that repeats the previous page's last entry must not produce a
    // duplicate FlatList key.
    const flat = flattenModerationLog([page(["a", "b"], "cur"), page(["b", "c"])]);
    expect(flat.map((e) => e.action.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps the FIRST occurrence, so newest-first order survives dedupe", () => {
    const first = page(["a"], "cur");
    const stale = entry("a");
    // Distinguish the two copies to prove which one is kept.
    stale.action.reason = "second copy";
    const flat = flattenModerationLog([first, { entries: [stale], nextCursor: null }]);
    expect(flat).toHaveLength(1);
    expect(flat[0]?.action.reason).toBeNull();
  });

  it("de-duplicates within a single page too", () => {
    expect(flattenModerationLog([page(["a", "a", "b"])]).map((e) => e.action.id)).toEqual([
      "a",
      "b",
    ]);
  });
});
