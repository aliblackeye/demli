import { and, eq, isNull, or, sql } from "drizzle-orm";
import type {
  ChannelId,
  FriendGroup,
  GroupId,
  Invite,
  InviteTargetChannel,
  UserId,
} from "@demli/types";
import { randomBytes } from "node:crypto";
import type { Db } from "../client.js";
import { evaluateInviteRedeem } from "../invite-rules.js";
import { toGroup, toInvite } from "../mappers.js";
import { channelAccessRepo } from "./channel-access.js";
import {
  channels,
  friendGroupMembers,
  friendGroups,
  groupBans,
  invites,
  userBlocks,
  users,
} from "../schema.js";

/** Unambiguous alphabet (no 0/O/1/I/L) for human-shareable codes. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 10;

export function generateInviteCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  for (const byte of bytes) {
    code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  }
  return code;
}

/**
 * Resolve an invite's channel target FOR ONE VIEWER, or null.
 *
 * Null is returned — deliberately, without distinguishing the cases — when:
 *  - the invite has no target (every pre-0021 invite, every plain server link);
 *  - the channel was deleted (the FK already nulled the column) or has since
 *    moved to another group, so the id no longer belongs here;
 *  - the viewer cannot SEE the channel under ADR 0007.
 *
 * That last rule is the honest one. A brand-new member joins with no roles, so a
 * role-restricted channel is invisible to them; advertising it as the
 * destination would hand them a link that lands nowhere (§35). `viewerIsMember`
 * picks which question to ask: an existing member gets their real visibility,
 * a not-yet-member gets the visibility they WILL have a second after joining —
 * which for a role-less member means "only unrestricted channels".
 *
 * Visibility itself is delegated to {@link channelAccessRepo} rather than
 * reimplemented, so this can never drift from the sidebar/WS/HTTP guards.
 */
async function resolveTargetChannel(
  db: Db,
  groupId: GroupId,
  channelId: ChannelId | null,
  userId: UserId,
  viewerIsMember: boolean,
): Promise<InviteTargetChannel | null> {
  if (!channelId) return null;

  const [row] = await db
    .select({
      id: channels.id,
      groupId: channels.groupId,
      name: channels.name,
      kind: channels.kind,
    })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);
  if (!row || row.groupId !== groupId) return null;

  const access = channelAccessRepo(db);
  const visible = viewerIsMember
    ? await access.canUserSeeChannel(groupId, channelId, userId)
    : !(await access.isRestricted(channelId));
  if (!visible) return null;

  return { id: row.id, name: row.name, kind: row.kind };
}

export type RedeemResult =
  | {
      ok: true;
      group: FriendGroup;
      alreadyMember: false;
      /**
       * Where to land the joiner, resolved AFTER the membership committed so the
       * visibility answer is the real one. Null for a server-targeted invite and
       * for a target this new member cannot see — the join still succeeded.
       */
      targetChannel: InviteTargetChannel | null;
    }
  | {
      ok: false;
      reason:
        | "not_found"
        | "expired"
        | "exhausted"
        | "already_member"
        | "banned"
        // M18: the redeemer and the invite's CREATOR have blocked each other
        // (either direction). Group-DM invites only — see the redeem body.
        | "blocked";
    };

/**
 * Read-only lookup behind `GET /invites/:code/preview` (invite embed card).
 * Refusals mirror {@link RedeemResult} with the same precedence — EXCEPT
 * "already_member", which is not a refusal here: an existing member sees the
 * card (with `alreadyMember: true`) even when the invite itself is expired or
 * exhausted, exactly as redeem lets membership beat the expiry rules.
 * `memberIds` excludes soft-deleted accounts (same rule as the member sidebar),
 * so `memberCount === memberIds.length` and the online count draws from the
 * same audience the count promises.
 */
export type InvitePreviewLookup =
  | {
      ok: true;
      invite: Invite;
      group: FriendGroup;
      memberIds: UserId[];
      memberCount: number;
      alreadyMember: boolean;
      /** Per-viewer invite destination — see {@link resolveTargetChannel}. */
      targetChannel: InviteTargetChannel | null;
    }
  | { ok: false; reason: "not_found" | "expired" | "exhausted" | "banned" };

export function invitesRepo(db: Db) {
  return {
    async create(input: {
      groupId: GroupId;
      createdBy: UserId;
      expiresAt: Date | null;
      maxUses: number | null;
      /**
       * Channel this invite lands on (migration 0021). Omit/null = plain server
       * invite, the pre-0021 behavior. The CALLER is responsible for proving the
       * channel belongs to `groupId` and that `createdBy` can see it — the API
       * route does both before reaching here (a route cannot mint an invite to a
       * channel its own author cannot open).
       */
      targetChannelId?: ChannelId | null;
    }): Promise<Invite> {
      const [row] = await db
        .insert(invites)
        .values({
          groupId: input.groupId,
          createdBy: input.createdBy,
          code: generateInviteCode(),
          expiresAt: input.expiresAt,
          maxUses: input.maxUses,
          targetChannelId: input.targetChannelId ?? null,
        })
        .returning();
      if (!row) throw new Error("insert invites returned no row");
      return toInvite(row);
    },

    async findByCode(code: string): Promise<Invite | null> {
      const [row] = await db
        .select()
        .from(invites)
        .where(eq(invites.code, code))
        .limit(1);
      return row ? toInvite(row) : null;
    },

    async listForGroup(groupId: GroupId): Promise<Invite[]> {
      const rows = await db.select().from(invites).where(eq(invites.groupId, groupId));
      return rows.map(toInvite);
    },

    /**
     * Revoke one invite. The `group_id` predicate is deliberately part of the
     * WHERE (not just an authorization check upstream): an invite id from another
     * group can never be deleted through a group-scoped route, even if a caller
     * guesses one. Returns true when a row was actually removed.
     */
    async revoke(inviteId: string, groupId: GroupId): Promise<boolean> {
      const rows = await db
        .delete(invites)
        .where(and(eq(invites.id, inviteId), eq(invites.groupId, groupId)))
        .returning({ id: invites.id });
      return rows.length > 0;
    },

    /**
     * READ-ONLY preview of an invite code (invite embed card). Never writes:
     * `use_count` is untouched, no membership is created, no row is locked —
     * previewing a link a thousand times must not burn a single use.
     *
     * Check order deliberately mirrors {@link redeem}: membership first (an
     * existing member gets the card whatever the invite's expiry state), then
     * the ban gate (a banned user gets ONE answer regardless of invite
     * validity, §28 — no oracle for guessing live codes), then the pure
     * expiry/max-use rules. A `kind='dm'` group is unreachable by invites and
     * answers not_found defensively.
     */
    async previewByCode(
      code: string,
      userId: UserId,
      now: Date = new Date(),
    ): Promise<InvitePreviewLookup> {
      const [inviteRow] = await db
        .select()
        .from(invites)
        .where(eq(invites.code, code))
        .limit(1);
      if (!inviteRow) return { ok: false, reason: "not_found" } as const;
      const invite = toInvite(inviteRow);

      const [groupRow] = await db
        .select()
        .from(friendGroups)
        .where(eq(friendGroups.id, invite.groupId))
        .limit(1);
      if (!groupRow || groupRow.kind === "dm") {
        return { ok: false, reason: "not_found" } as const;
      }

      // Visible members only: soft-deleted accounts are hidden from the member
      // sidebar (M15), so the card's count — and the online count derived from
      // these ids — must not include them either.
      const memberRows = await db
        .select({ userId: friendGroupMembers.userId })
        .from(friendGroupMembers)
        .innerJoin(users, eq(users.id, friendGroupMembers.userId))
        .where(
          and(eq(friendGroupMembers.groupId, invite.groupId), isNull(users.deletedAt)),
        );
      const memberIds = memberRows.map((r) => r.userId);

      const base = {
        ok: true,
        invite,
        group: toGroup(groupRow),
        memberIds,
        memberCount: memberIds.length,
      } as const;

      if (memberIds.includes(userId)) {
        return {
          ...base,
          alreadyMember: true,
          targetChannel: await resolveTargetChannel(
            db,
            invite.groupId,
            invite.targetChannelId,
            userId,
            true,
          ),
        };
      }

      const [banned] = await db
        .select({ userId: groupBans.userId })
        .from(groupBans)
        .where(and(eq(groupBans.groupId, invite.groupId), eq(groupBans.userId, userId)))
        .limit(1);
      if (banned) return { ok: false, reason: "banned" } as const;

      const verdict = evaluateInviteRedeem(invite, now);
      if (!verdict.ok) return { ok: false, reason: verdict.reason } as const;

      return {
        ...base,
        alreadyMember: false,
        // Not a member yet: answer with what they WOULD see after joining, i.e.
        // unrestricted channels only. Never promise a destination the join
        // cannot deliver.
        targetChannel: await resolveTargetChannel(
          db,
          invite.groupId,
          invite.targetChannelId,
          userId,
          false,
        ),
      };
    },

    /**
     * Atomically redeem a code: lock the invite row, apply the pure rules
     * (expiry, max uses), reject existing members, then add the membership
     * and bump use_count in the same transaction.
     *
     * The channel target (migration 0021) is resolved AFTER the transaction
     * commits, on purpose: visibility depends on the membership row this
     * transaction just created, and the resolution is a read that must never be
     * able to fail the join. A target the new member cannot see, or one whose
     * channel is gone, simply yields `targetChannel: null` — the user is inside
     * the server either way.
     */
    async redeem(code: string, userId: UserId, now: Date = new Date()): Promise<RedeemResult> {
      const outcome = await db.transaction(async (tx) => {
        const [inviteRow] = await tx
          .select()
          .from(invites)
          .where(eq(invites.code, code))
          .for("update")
          .limit(1);
        if (!inviteRow) return { ok: false, reason: "not_found" } as const;

        const invite = toInvite(inviteRow);

        // Membership first: "already a member" beats "expired/exhausted"
        // as feedback for someone who is already inside the group.
        const [existing] = await tx
          .select({ userId: friendGroupMembers.userId })
          .from(friendGroupMembers)
          .where(
            and(
              eq(friendGroupMembers.groupId, invite.groupId),
              eq(friendGroupMembers.userId, userId),
            ),
          )
          .limit(1);
        if (existing) return { ok: false, reason: "already_member" } as const;

        // Ban gate (migration 0017): a banned user can NEVER rejoin, even with a
        // valid invite. Checked inside the SAME locked transaction as the insert
        // so there is no ban-then-redeem race — a ban committed before this read
        // is honored, and a redeem in flight when a ban lands still races on the
        // invite row lock, not the ban.
        const [banned] = await tx
          .select({ userId: groupBans.userId })
          .from(groupBans)
          .where(
            and(
              eq(groupBans.groupId, invite.groupId),
              eq(groupBans.userId, userId),
            ),
          )
          .limit(1);
        if (banned) return { ok: false, reason: "banned" } as const;

        const verdict = evaluateInviteRedeem(invite, now);
        if (!verdict.ok) return { ok: false, reason: verdict.reason } as const;

        const [groupRow] = await tx
          .select()
          .from(friendGroups)
          .where(eq(friendGroups.id, invite.groupId))
          .limit(1);
        if (!groupRow) throw new Error("invite points at missing group");

        // Block gate for GROUP-DM invite links (M18, ADR 0017). A flat group chat
        // is a private space, so a link must not put two people who blocked each
        // other into the same room. The pair checked is the redeemer vs. the
        // invite's CREATOR — the person who actually handed out the link — in
        // EITHER direction. Deliberately NOT applied to servers: blocking is a
        // personal-contact tool and never gates joining a public-ish
        // server; the per-surface guards still hide the blocked user's content
        // inside it. Same locked transaction as the insert, so a block committed
        // before this read is honored.
        if (groupRow.kind !== "server") {
          const [blocked] = await tx
            .select({ blockerId: userBlocks.blockerId })
            .from(userBlocks)
            .where(
              or(
                and(
                  eq(userBlocks.blockerId, userId),
                  eq(userBlocks.blockedId, invite.createdBy),
                ),
                and(
                  eq(userBlocks.blockerId, invite.createdBy),
                  eq(userBlocks.blockedId, userId),
                ),
              ),
            )
            .limit(1);
          if (blocked) return { ok: false, reason: "blocked" } as const;
        }

        await tx
          .insert(friendGroupMembers)
          .values({ groupId: invite.groupId, userId, role: "member" });
        await tx
          .update(invites)
          .set({ useCount: sql`${invites.useCount} + 1` })
          .where(eq(invites.id, invite.id));

        return {
          ok: true,
          group: toGroup(groupRow),
          targetChannelId: invite.targetChannelId,
        } as const;
      });

      if (!outcome.ok) return outcome;

      return {
        ok: true,
        group: outcome.group,
        alreadyMember: false,
        targetChannel: await resolveTargetChannel(
          db,
          outcome.group.id,
          outcome.targetChannelId,
          userId,
          true,
        ),
      };
    },
  };
}

export type InvitesRepo = ReturnType<typeof invitesRepo>;
