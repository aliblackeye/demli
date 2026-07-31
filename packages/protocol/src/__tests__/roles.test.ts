import { describe, expect, it } from "vitest";
import { PERMISSIONS, hasPermission, type Role } from "@demli/types";
import { SERVER_EVENT, serverEvent } from "../factories.js";
import { roleSchema, serverToClientEventSchema } from "../schemas.js";

const sampleRole: Role = {
  id: "44444444-4444-4444-4444-444444444444",
  groupId: "55555555-5555-5555-5555-555555555555",
  name: "Moderator",
  color: "#e91e63",
  position: 1,
  permissions: PERMISSIONS.MANAGE_MESSAGES | PERMISSIONS.KICK_MEMBERS,
  createdAt: "2026-07-07T10:00:00.000Z",
};

// ---------------------------------------------------------------------------
// hasPermission helper (packages/types)
// ---------------------------------------------------------------------------

describe("hasPermission", () => {
  it("returns true when the exact bit is set", () => {
    expect(hasPermission(PERMISSIONS.MANAGE_CHANNELS, PERMISSIONS.MANAGE_CHANNELS)).toBe(true);
  });

  it("returns false when the bit is not set", () => {
    expect(hasPermission(PERMISSIONS.MANAGE_CHANNELS, PERMISSIONS.MANAGE_MESSAGES)).toBe(false);
  });

  it("returns false for an empty bitfield", () => {
    expect(hasPermission(0, PERMISSIONS.MANAGE_ROLES)).toBe(false);
  });

  it("detects a bit inside a combined (OR'd) bitfield", () => {
    const effective =
      PERMISSIONS.MANAGE_MESSAGES | PERMISSIONS.KICK_MEMBERS | PERMISSIONS.CREATE_INVITE;
    expect(hasPermission(effective, PERMISSIONS.KICK_MEMBERS)).toBe(true);
    expect(hasPermission(effective, PERMISSIONS.CREATE_INVITE)).toBe(true);
    expect(hasPermission(effective, PERMISSIONS.MANAGE_ROLES)).toBe(false);
    expect(hasPermission(effective, PERMISSIONS.MANAGE_CHANNELS)).toBe(false);
  });

  it("treats every declared permission as a distinct power-of-two bit", () => {
    const values = Object.values(PERMISSIONS);
    // No two permissions collide on the same bit.
    expect(new Set(values).size).toBe(values.length);
    for (const bit of values) {
      // Each bit is a single power of two.
      expect(bit & (bit - 1)).toBe(0);
      // And is individually detectable in an all-bits bitfield.
      const all = values.reduce((acc, b) => acc | b, 0);
      expect(hasPermission(all, bit)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// roleSchema
// ---------------------------------------------------------------------------

describe("roleSchema", () => {
  it("accepts a well-formed role", () => {
    expect(roleSchema.parse(sampleRole)).toEqual(sampleRole);
  });

  it("accepts a null color and zero permissions", () => {
    const plain: Role = { ...sampleRole, color: null, permissions: 0 };
    expect(roleSchema.safeParse(plain).success).toBe(true);
  });

  it("rejects a missing groupId", () => {
    const { groupId: _groupId, ...rest } = sampleRole;
    expect(roleSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a non-integer permissions bitfield", () => {
    expect(roleSchema.safeParse({ ...sampleRole, permissions: 1.5 }).success).toBe(false);
  });

  it("rejects a negative permissions bitfield", () => {
    expect(roleSchema.safeParse({ ...sampleRole, permissions: -1 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Server event schemas — accept / reject the five new events
// ---------------------------------------------------------------------------

describe("roles server events — schema acceptance", () => {
  it("accepts role.created", () => {
    const result = serverToClientEventSchema.safeParse(serverEvent.roleCreated({ role: sampleRole }));
    expect(result.success).toBe(true);
  });

  it("accepts role.updated", () => {
    const result = serverToClientEventSchema.safeParse(serverEvent.roleUpdated({ role: sampleRole }));
    expect(result.success).toBe(true);
  });

  it("accepts role.deleted", () => {
    const result = serverToClientEventSchema.safeParse(
      serverEvent.roleDeleted({ groupId: sampleRole.groupId, roleId: sampleRole.id }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts member.roles_updated", () => {
    const result = serverToClientEventSchema.safeParse(
      serverEvent.memberRolesUpdated({
        groupId: sampleRole.groupId,
        userId: "66666666-6666-6666-6666-666666666666",
        roleIds: [sampleRole.id],
      }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts member.roles_updated with an empty roleIds list", () => {
    const result = serverToClientEventSchema.safeParse(
      serverEvent.memberRolesUpdated({
        groupId: sampleRole.groupId,
        userId: "66666666-6666-6666-6666-666666666666",
        roleIds: [],
      }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts channel.access_changed", () => {
    const result = serverToClientEventSchema.safeParse(
      serverEvent.channelAccessChanged({
        groupId: sampleRole.groupId,
        channelId: "77777777-7777-7777-7777-777777777777",
      }),
    );
    expect(result.success).toBe(true);
  });
});

describe("roles server events — schema rejection", () => {
  it("rejects role.created carrying a malformed role", () => {
    const result = serverToClientEventSchema.safeParse({
      type: "role.created",
      payload: { role: { ...sampleRole, permissions: "lots" } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects role.deleted missing the group-scope groupId", () => {
    const result = serverToClientEventSchema.safeParse({
      type: "role.deleted",
      payload: { roleId: sampleRole.id },
    });
    expect(result.success).toBe(false);
  });

  it("rejects member.roles_updated with a non-array roleIds", () => {
    const result = serverToClientEventSchema.safeParse({
      type: "member.roles_updated",
      payload: {
        groupId: sampleRole.groupId,
        userId: "66666666-6666-6666-6666-666666666666",
        roleIds: sampleRole.id,
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects channel.access_changed missing groupId", () => {
    const result = serverToClientEventSchema.safeParse({
      type: "channel.access_changed",
      payload: { channelId: "77777777-7777-7777-7777-777777777777" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown event type", () => {
    const result = serverToClientEventSchema.safeParse({
      type: "role.renamed",
      payload: { role: sampleRole },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Factories — constants and round-trip through the wire schema
// ---------------------------------------------------------------------------

describe("roles factories", () => {
  it("exposes stable SERVER_EVENT name constants", () => {
    expect(SERVER_EVENT.roleCreated).toBe("role.created");
    expect(SERVER_EVENT.roleUpdated).toBe("role.updated");
    expect(SERVER_EVENT.roleDeleted).toBe("role.deleted");
    expect(SERVER_EVENT.memberRolesUpdated).toBe("member.roles_updated");
    expect(SERVER_EVENT.channelAccessChanged).toBe("channel.access_changed");
  });

  it("builds events that survive a JSON wire round-trip and re-validate", () => {
    const event = serverEvent.roleCreated({ role: sampleRole });
    const decoded = serverToClientEventSchema.parse(JSON.parse(JSON.stringify(event)));
    expect(decoded).toEqual(event);
  });

  it("tags each factory output with its SERVER_EVENT type", () => {
    expect(serverEvent.roleCreated({ role: sampleRole }).type).toBe(SERVER_EVENT.roleCreated);
    expect(
      serverEvent.channelAccessChanged({ groupId: sampleRole.groupId, channelId: "c1" }).type,
    ).toBe(SERVER_EVENT.channelAccessChanged);
  });
});
