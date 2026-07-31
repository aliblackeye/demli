/**
 * The user context menu's visibility contract (ADR 0019 + §35).
 *
 * These tests exist because the menu's whole promise is "you are never offered
 * something the server would refuse". That promise is only as good as the rules
 * in `member-menu.ts`, and those rules are exactly the kind of thing that rots
 * quietly: someone adds an entry, forgets the owner-immunity guard, and the UI
 * ships a "Ban" button that 403s. So the pure contract is asserted here rather
 * than eyeballed in a 600-line JSX tree.
 */

import { describe, expect, it } from "vitest";
import {
  friendshipItemFor,
  isDestructiveMemberMenuItem,
  memberMenuGroups,
  memberMenuHas,
  memberMenuItems,
  TIMEOUT_PRESET_MINUTES,
  type MemberMenuContext,
} from "./member-menu";

/** A plain member looking at another plain member inside a server. */
function ctx(overrides: Partial<MemberMenuContext> = {}): MemberMenuContext {
  return {
    isSelf: false,
    inServer: true,
    targetIsOwner: false,
    viewerIsOwner: false,
    canManageRoles: false,
    canManageNicknames: false,
    canModerate: false,
    canInvite: true,
    targetInVoice: false,
    targetTimedOut: false,
    hasTextChannel: true,
    canOpenProfile: true,
    friendship: "none",
    blocked: false,
    ignored: false,
    ...overrides,
  };
}

const DESTRUCTIVE = ["kick", "ban", "timeout", "voiceDisconnect"] as const;

describe("an unauthorized viewer", () => {
  it("is offered NO moderation entry at all", () => {
    const items = memberMenuItems(ctx());
    for (const item of DESTRUCTIVE) {
      expect(items).not.toContain(item);
    }
  });

  it("is not offered the role submenu", () => {
    expect(memberMenuHas(ctx(), "roles")).toBe(false);
  });

  it("is not offered another member's server nickname", () => {
    expect(memberMenuHas(ctx(), "serverNickname")).toBe(false);
  });

  it("still gets the personal actions, which need no permission", () => {
    const items = memberMenuItems(ctx());
    expect(items).toEqual(
      expect.arrayContaining(["profile", "message", "note", "friendNickname", "ignore", "block"]),
    );
  });
});

describe("an authorized moderator", () => {
  const mod = ctx({ canModerate: true });

  it("is offered kick, ban and timeout", () => {
    const items = memberMenuItems(mod);
    expect(items).toEqual(expect.arrayContaining(["kick", "ban", "timeout"]));
  });

  it("is NEVER offered them against the server owner", () => {
    const items = memberMenuItems(ctx({ canModerate: true, targetIsOwner: true }));
    for (const item of DESTRUCTIVE) {
      expect(items).not.toContain(item);
    }
  });

  it("is offered voice-disconnect only while the target is actually in voice", () => {
    expect(memberMenuHas(mod, "voiceDisconnect")).toBe(false);
    expect(memberMenuHas(ctx({ canModerate: true, targetInVoice: true }), "voiceDisconnect")).toBe(
      true,
    );
  });

  it("loses every server-scoped entry outside a server (DM / friends list)", () => {
    const items = memberMenuItems(ctx({ canModerate: true, inServer: false, canManageRoles: true }));
    for (const item of [...DESTRUCTIVE, "roles", "invite", "serverNickname"] as const) {
      expect(items).not.toContain(item);
    }
  });
});

describe("permission bits are not interchangeable", () => {
  it("MANAGE_NICKNAMES alone grants the nickname entry and nothing destructive", () => {
    const items = memberMenuItems(ctx({ canManageNicknames: true }));
    expect(items).toContain("serverNickname");
    expect(items).not.toContain("kick");
    expect(items).not.toContain("roles");
  });

  it("KICK_MEMBERS alone does not grant renaming or role assignment", () => {
    const items = memberMenuItems(ctx({ canModerate: true }));
    expect(items).not.toContain("serverNickname");
    expect(items).not.toContain("roles");
  });

  it("owner immunity applies to the nickname entry too", () => {
    expect(
      memberMenuHas(ctx({ canManageNicknames: true, targetIsOwner: true }), "serverNickname"),
    ).toBe(false);
  });
});

describe("your OWN menu is a different menu", () => {
  const self = ctx({ isSelf: true, viewerIsOwner: true, canModerate: true, canManageRoles: true });

  it("offers none of the self-directed no-ops the API would reject", () => {
    const items = memberMenuItems(self);
    for (const item of [
      "message",
      "call",
      "addFriend",
      "removeFriend",
      "ignore",
      "block",
      "kick",
      "ban",
      "timeout",
      "voiceDisconnect",
      "note",
      "friendNickname",
    ] as const) {
      expect(items).not.toContain(item);
    }
  });

  it("offers exactly profile, mention, server profile, roles and copy-id", () => {
    expect(memberMenuItems(self)).toEqual([
      "profile",
      "mention",
      "editServerProfile",
      "roles",
      "copyUserId",
    ]);
  });

  it("lets a plain member edit their own server profile — no bit required", () => {
    expect(memberMenuHas(ctx({ isSelf: true }), "editServerProfile")).toBe(true);
  });

  it("renames itself with the SELF entry, never the moderator one", () => {
    const items = memberMenuItems(ctx({ isSelf: true }));
    expect(items).toContain("editServerProfile");
    expect(items).not.toContain("serverNickname");
  });
});

describe("blocked and ignored targets", () => {
  it("hides message/call while a block holds — both are refused server-side", () => {
    const items = memberMenuItems(ctx({ blocked: true, friendship: "friends" }));
    expect(items).not.toContain("message");
    expect(items).not.toContain("call");
    // Unblocking must stay reachable, or a block is a one-way door.
    expect(items).toContain("block");
  });

  it("hides the friendship action while a block holds", () => {
    expect(memberMenuHas(ctx({ blocked: true, friendship: "none" }), "addFriend")).toBe(false);
  });

  it("keeps the note and the private nickname, which a block does not affect", () => {
    const items = memberMenuItems(ctx({ blocked: true }));
    expect(items).toEqual(expect.arrayContaining(["note", "friendNickname"]));
  });

  it("offers ignore whether or not it is already on (the entry flips label)", () => {
    expect(memberMenuHas(ctx({ ignored: true }), "ignore")).toBe(true);
    expect(memberMenuHas(ctx({ ignored: false }), "ignore")).toBe(true);
  });
});

describe("context-dependent entries", () => {
  it("offers Mention only when a text channel is open", () => {
    expect(memberMenuHas(ctx({ hasTextChannel: false }), "mention")).toBe(false);
    expect(memberMenuHas(ctx({ hasTextChannel: true }), "mention")).toBe(true);
    // …and on your own menu too, matching the reference layout.
    expect(memberMenuHas(ctx({ isSelf: true, hasTextChannel: true }), "mention")).toBe(true);
  });

  it("offers Call only to a mutual friend", () => {
    expect(memberMenuHas(ctx({ friendship: "friends" }), "call")).toBe(true);
    for (const friendship of ["none", "incoming", "outgoing"] as const) {
      expect(memberMenuHas(ctx({ friendship }), "call")).toBe(false);
    }
  });

  it("offers no friendship entry while the friendship is still unknown", () => {
    const items = memberMenuItems(ctx({ friendship: "unknown" }));
    for (const item of [
      "addFriend",
      "removeFriend",
      "acceptFriendRequest",
      "cancelFriendRequest",
    ] as const) {
      expect(items).not.toContain(item);
    }
  });

  it("maps each friendship state to exactly one entry", () => {
    expect(friendshipItemFor("none")).toBe("addFriend");
    expect(friendshipItemFor("outgoing")).toBe("cancelFriendRequest");
    expect(friendshipItemFor("incoming")).toBe("acceptFriendRequest");
    expect(friendshipItemFor("friends")).toBe("removeFriend");
    expect(friendshipItemFor("unknown")).toBeNull();
  });

  it("drops the invite entry when the viewer may not invite", () => {
    expect(memberMenuHas(ctx({ canInvite: false }), "invite")).toBe(false);
  });

  it("drops Profile inside the profile card's own menu — the card is already open", () => {
    expect(memberMenuHas(ctx({ canOpenProfile: false }), "profile")).toBe(false);
    expect(memberMenuHas(ctx({ canOpenProfile: false, isSelf: true }), "profile")).toBe(false);
    // …and the group it led must not be left empty behind it.
    for (const group of memberMenuGroups(ctx({ canOpenProfile: false }))) {
      expect(group.length).toBeGreaterThan(0);
    }
  });
});

describe("layout", () => {
  it("always ends with Copy user ID, in its own group", () => {
    for (const c of [ctx(), ctx({ isSelf: true }), ctx({ canModerate: true, inServer: false })]) {
      const groups = memberMenuGroups(c);
      expect(groups.at(-1)).toEqual(["copyUserId"]);
    }
  });

  it("always starts with Profile", () => {
    expect(memberMenuItems(ctx())[0]).toBe("profile");
    expect(memberMenuItems(ctx({ isSelf: true }))[0]).toBe("profile");
  });

  it("never emits an empty group (which would render a doubled separator)", () => {
    const cases = [
      ctx(),
      ctx({ isSelf: true }),
      ctx({ inServer: false }),
      ctx({ inServer: false, isSelf: true, hasTextChannel: false }),
      ctx({ canModerate: true, canManageRoles: true, canManageNicknames: true }),
    ];
    for (const c of cases) {
      for (const group of memberMenuGroups(c)) {
        expect(group.length).toBeGreaterThan(0);
      }
    }
  });

  it("puts the destructive entries last, just above Copy user ID", () => {
    const items = memberMenuItems(ctx({ canModerate: true, targetInVoice: true }));
    const firstDestructive = items.findIndex(isDestructiveMemberMenuItem);
    const lastDestructive = items.map(isDestructiveMemberMenuItem).lastIndexOf(true);
    // Block is destructive-coloured too and sits earlier by design; what must
    // hold is that the MODERATION trio is the final block before copy-id.
    expect(firstDestructive).toBeGreaterThan(-1);
    expect(items[lastDestructive + 1]).toBe("copyUserId");
  });

  it("marks exactly the consequential entries as destructive", () => {
    expect(isDestructiveMemberMenuItem("kick")).toBe(true);
    expect(isDestructiveMemberMenuItem("ban")).toBe(true);
    expect(isDestructiveMemberMenuItem("timeout")).toBe(true);
    expect(isDestructiveMemberMenuItem("voiceDisconnect")).toBe(true);
    expect(isDestructiveMemberMenuItem("block")).toBe(true);
    expect(isDestructiveMemberMenuItem("note")).toBe(false);
    expect(isDestructiveMemberMenuItem("ignore")).toBe(false);
    expect(isDestructiveMemberMenuItem("copyUserId")).toBe(false);
  });

  it("renders no entry twice", () => {
    const items = memberMenuItems(
      ctx({ canModerate: true, canManageRoles: true, canManageNicknames: true, targetInVoice: true }),
    );
    expect(new Set(items).size).toBe(items.length);
  });
});

describe("timeout presets", () => {
  it("are all inside the API's accepted range (1 … 28 days)", () => {
    for (const minutes of TIMEOUT_PRESET_MINUTES) {
      expect(minutes).toBeGreaterThanOrEqual(1);
      expect(minutes).toBeLessThanOrEqual(28 * 24 * 60);
    }
  });

  it("are the expected ladder: 60s, 5m, 10m, 1h, 1d, 1w", () => {
    expect([...TIMEOUT_PRESET_MINUTES]).toEqual([1, 5, 10, 60, 1440, 10080]);
  });
});
