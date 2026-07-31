/**
 * Who may revoke a group-DM invite link — the one rule both the desktop dialog
 * and the mobile screen must agree on, because the API answers 403 to everyone
 * else and a rendered-but-doomed button is exactly the dead control §35 forbids.
 */

import { describe, expect, it } from "vitest";
import type { GroupId, Invite, InviteId, UserId } from "@demli/types";
import {
  canCreateGroupChatInvite,
  canRevokeGroupChatInvite,
  inviteUsage,
  prefersDaysWording,
} from "../group-chat-invite.js";

const OWNER = "u-owner" as UserId;
const MEMBER = "u-member" as UserId;

const invite = (over: Partial<Invite> = {}): Invite => ({
  id: "i1" as InviteId,
  groupId: "g1" as GroupId,
  code: "ABCD234567",
  createdBy: OWNER,
  expiresAt: null,
  maxUses: null,
  useCount: 0,
  createdAt: "2026-07-01T00:00:00.000Z",
  // Group-DM links never carry a channel target (migration 0021) — a flat chat
  // has no channel picker. Pinned here so the fixture stays honest about it.
  targetChannelId: null,
  ...over,
});

describe("revoke is owner-only, create is not", () => {
  it("lets the owner revoke", () => {
    expect(canRevokeGroupChatInvite({ groupOwnerId: OWNER, viewerId: OWNER })).toBe(true);
  });

  it("refuses a plain member", () => {
    expect(canRevokeGroupChatInvite({ groupOwnerId: OWNER, viewerId: MEMBER })).toBe(false);
  });

  it("refuses while the roster or the session is still loading", () => {
    // A slow fetch must not flash an owner-only control at a member.
    expect(canRevokeGroupChatInvite({ groupOwnerId: null, viewerId: MEMBER })).toBe(false);
    expect(canRevokeGroupChatInvite({ groupOwnerId: OWNER, viewerId: null })).toBe(false);
    expect(canRevokeGroupChatInvite({ groupOwnerId: undefined, viewerId: undefined })).toBe(false);
  });

  it("lets any member mint a link — membership is the whole permission model", () => {
    expect(canCreateGroupChatInvite()).toBe(true);
  });
});

describe("a link's limits are computed once, not per platform", () => {
  const NOW = Date.parse("2026-07-27T12:00:00.000Z");

  it("reports a never-expiring, unlimited link as neither expired nor exhausted", () => {
    const usage = inviteUsage(invite(), NOW);
    expect(usage).toMatchObject({
      expired: false,
      exhausted: false,
      hoursLeft: null,
      daysLeft: null,
      usesLeft: null,
      maxUses: null,
    });
  });

  it("clamps a past expiry to zero instead of going negative", () => {
    const usage = inviteUsage(invite({ expiresAt: "2026-07-27T09:00:00.000Z" }), NOW);
    expect(usage.expired).toBe(true);
    expect(usage.hoursLeft).toBe(0);
    expect(usage.daysLeft).toBe(0);
  });

  it("counts uses left and clamps an over-used link to zero", () => {
    expect(inviteUsage(invite({ maxUses: 25, useCount: 3 }), NOW).usesLeft).toBe(22);
    const over = inviteUsage(invite({ maxUses: 25, useCount: 40 }), NOW);
    expect(over.usesLeft).toBe(0);
    expect(over.exhausted).toBe(true);
  });

  it("switches to day wording only past the 48-hour threshold", () => {
    const week = inviteUsage(invite({ expiresAt: "2026-08-03T12:00:00.000Z" }), NOW);
    expect(week.daysLeft).toBe(7);
    expect(prefersDaysWording(week)).toBe(true);

    const soon = inviteUsage(invite({ expiresAt: "2026-07-28T12:00:00.000Z" }), NOW);
    expect(soon.hoursLeft).toBe(24);
    expect(prefersDaysWording(soon)).toBe(false);
  });
});
