/**
 * The invite gate and the target-channel read.
 *
 * Two failures these lock down, both of which reach a user rather than a log:
 *
 *  1. Offering an invite control to someone the API will refuse. The founder's
 *     reference screenshots are explicit — the member without the permission has
 *     NO "Kanala Davet Et" row at all — so "shows it disabled" is a failure here,
 *     and so is "shows it while the membership is still loading".
 *  2. Crashing on an invite response from a server that predates `targetChannel`.
 *     The client ships on its own cadence; a redeem must degrade to a plain
 *     server invite, never throw.
 */

import { describe, expect, it } from "vitest";
import {
  canCreateServerInvite,
  readInviteTargetChannel,
  type ServerInviteViewer,
} from "../channel-invite.js";

function viewer(overrides: Partial<ServerInviteViewer> = {}): ServerInviteViewer {
  return {
    invitePolicy: "members",
    membershipRole: "member",
    isOwner: false,
    hasCreateInvitePermission: false,
    ...overrides,
  };
}

describe("canCreateServerInvite", () => {
  it("lets any plain member invite under the default 'members' policy", () => {
    expect(canCreateServerInvite(viewer())).toBe(true);
  });

  it("treats an absent policy as 'members' (pre-M9 servers keep working)", () => {
    expect(canCreateServerInvite(viewer({ invitePolicy: undefined }))).toBe(true);
    expect(canCreateServerInvite(viewer({ invitePolicy: null }))).toBe(true);
  });

  it("never lets a guest invite, whatever the policy says", () => {
    expect(canCreateServerInvite(viewer({ membershipRole: "guest" }))).toBe(false);
    expect(
      canCreateServerInvite(viewer({ membershipRole: "guest", invitePolicy: "roles" })),
    ).toBe(false);
    // Even holding the bit — a guest can hold no roles server-side (ADR 0007),
    // so a client that saw one anyway must still not offer the control.
    expect(
      canCreateServerInvite(
        viewer({ membershipRole: "guest", hasCreateInvitePermission: true }),
      ),
    ).toBe(false);
  });

  it("under the 'roles' policy, refuses a member without CREATE_INVITE", () => {
    expect(canCreateServerInvite(viewer({ invitePolicy: "roles" }))).toBe(false);
  });

  it("under the 'roles' policy, allows a CREATE_INVITE holder and the owner", () => {
    expect(
      canCreateServerInvite(
        viewer({ invitePolicy: "roles", hasCreateInvitePermission: true }),
      ),
    ).toBe(true);
    expect(canCreateServerInvite(viewer({ invitePolicy: "roles", isOwner: true }))).toBe(true);
  });

  it("fails closed while the membership is still loading", () => {
    // A control that appears and then disappears a beat later is worse than one
    // that appears a beat late — this is the "no flash" half of the rule.
    expect(canCreateServerInvite(viewer({ membershipRole: undefined }))).toBe(false);
    expect(canCreateServerInvite(viewer({ membershipRole: null }))).toBe(false);
  });

  it("still allows the owner before their membership row resolves", () => {
    // Ownership comes off the group itself, not the roster, so it is known first.
    expect(canCreateServerInvite(viewer({ membershipRole: null, isOwner: true }))).toBe(true);
  });
});

describe("readInviteTargetChannel", () => {
  it("reads a well-formed target", () => {
    expect(
      readInviteTargetChannel({
        group: { id: "g1" },
        targetChannel: { id: "ch-1", name: "lobby", kind: "voice" },
      }),
    ).toEqual({ id: "ch-1", name: "lobby", kind: "voice" });
  });

  it("answers null when the field is absent — an API that predates it", () => {
    // The regression this file exists for: `{ group }` is exactly what the
    // current `POST /invites/:code/redeem` returns.
    expect(readInviteTargetChannel({ group: { id: "g1" } })).toBeNull();
  });

  it("answers null for an explicit null target (channel deleted / not visible)", () => {
    expect(readInviteTargetChannel({ targetChannel: null })).toBeNull();
  });

  it("answers null rather than throwing on junk", () => {
    for (const junk of [null, undefined, 0, "", "targetChannel", [], { targetChannel: 7 }]) {
      expect(readInviteTargetChannel(junk)).toBeNull();
    }
  });

  it("rejects a target with no usable id or an unknown kind", () => {
    expect(readInviteTargetChannel({ targetChannel: { name: "x", kind: "text" } })).toBeNull();
    expect(readInviteTargetChannel({ targetChannel: { id: "", kind: "text" } })).toBeNull();
    expect(
      readInviteTargetChannel({ targetChannel: { id: "ch-1", kind: "forum" } }),
    ).toBeNull();
  });

  it("keeps a target whose name is missing — id + kind are what navigation needs", () => {
    expect(readInviteTargetChannel({ targetChannel: { id: "ch-1", kind: "text" } })).toEqual({
      id: "ch-1",
      name: "",
      kind: "text",
    });
  });
});
