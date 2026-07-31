/**
 * Group-DM invite links — the pure rules behind "anyone in the group can hand
 * out a link, only its owner can take one back" (M18).
 *
 * A flat group chat (ADR 0005) reuses the SERVER invite machinery wholesale: the
 * same `invites` table, the same code format, and the same
 * `POST /invites/:code/redeem` endpoint. That is deliberate — a second redeem
 * path would mean a second deep-link format, and every surface that detects an
 * invite in pasted text would have to learn both. There is one link shape, and
 * this module never builds it; the per-app deep-link module does (each platform
 * has its own registered URL patterns).
 *
 * What DOES need deciding on every surface is the asymmetry between creating and
 * revoking, and that asymmetry is not guessable from the endpoint list:
 *
 *   - CREATE  — any member. A group chat has no roles; membership is the whole
 *     permission model, and the owner already controls who stays (they can
 *     remove anyone). Gating creation would make the feature useless in the
 *     groups that want it most.
 *   - REVOKE  — the owner ONLY, mirroring "only the owner adds members". The API
 *     answers 403 for anyone else, so a revoke button shown to a plain member is
 *     a control that can only fail (§35: not disabled — NOT RENDERED).
 *
 * Framework-free and in client-core so the desktop dialog and the mobile screen
 * read ONE copy of that rule. A hand-written second comparison is exactly how the
 * two surfaces end up disagreeing about who may revoke — the failure
 * `member-menu.ts` and `voice-channel-chat.ts` exist to prevent.
 *
 * COSMETIC gate only: the API re-checks ownership on every revoke (§28).
 */

import type { Invite, UserId } from "@demli/types";

/** Who is looking, and who owns the group chat they are looking at. */
export interface GroupChatInviteViewer {
  /** `Group.ownerId` from `GET /group-chats/:id`; null while it is still loading. */
  groupOwnerId: UserId | null | undefined;
  /** The signed-in user, or null when the session is not resolved yet. */
  viewerId: UserId | null | undefined;
}

/**
 * Every member may mint a link. Spelled out as a function rather than left
 * implicit so the asymmetry with {@link canRevokeGroupChatInvite} is visible at
 * both call sites — the pair reads as one decision, and a future "only the owner
 * may invite" policy has exactly one place to land.
 */
export function canCreateGroupChatInvite(): boolean {
  return true;
}

/**
 * Only the group's owner may revoke a link. False while either id is still
 * unresolved, so a slow roster fetch never flashes an owner-only control at a
 * plain member.
 */
export function canRevokeGroupChatInvite(viewer: GroupChatInviteViewer): boolean {
  const { groupOwnerId, viewerId } = viewer;
  if (!groupOwnerId || !viewerId) return false;
  return groupOwnerId === viewerId;
}

/**
 * What a link's limits amount to RIGHT NOW, as numbers a renderer turns into its
 * own localized line.
 *
 * Deliberately returns data, not a string: the desktop dialog and the mobile
 * screen use different i18n namespaces and different separators, but the
 * arithmetic — clamping a past expiry to zero, counting uses left — must not be
 * written twice. It already was (desktop's `inviteLimits` and mobile's had
 * independent copies of the same `Math.max(0, …)` rounding), which is how one
 * surface can start showing "-3 hours".
 *
 * `revoked` is not modelled: revoking hard-DELETEs the row, so a revoked link
 * simply stops being listed. Expired and exhausted links DO stay in the list —
 * the server does not filter them — which is why both flags are reported.
 */
export interface InviteUsage {
  /** Past its `expiresAt`. Always false for a never-expiring link. */
  expired: boolean;
  /** `useCount` has reached `maxUses`. Always false for an unlimited link. */
  exhausted: boolean;
  /** Whole hours until expiry, clamped at 0; null when it never expires. */
  hoursLeft: number | null;
  /** Whole days until expiry, clamped at 0; null when it never expires. */
  daysLeft: number | null;
  /** Uses remaining, clamped at 0; null when uses are unlimited. */
  usesLeft: number | null;
  /** Echo of `maxUses` so a renderer can say "3 of 25 left" without re-reading. */
  maxUses: number | null;
}

export function inviteUsage(invite: Invite, now: number = Date.now()): InviteUsage {
  const expiresAt = invite.expiresAt ? new Date(invite.expiresAt).getTime() : null;
  const msLeft = expiresAt === null ? null : expiresAt - now;
  const hoursLeft = msLeft === null ? null : Math.max(0, Math.round(msLeft / 3_600_000));
  const daysLeft = hoursLeft === null ? null : Math.max(0, Math.round(hoursLeft / 24));

  return {
    expired: msLeft !== null && msLeft <= 0,
    exhausted: invite.maxUses !== null && invite.useCount >= invite.maxUses,
    hoursLeft,
    daysLeft,
    usesLeft: invite.maxUses === null ? null : Math.max(0, invite.maxUses - invite.useCount),
    maxUses: invite.maxUses,
  };
}

/**
 * Whether an expiry reads better in days than in hours. Two days is the cut-over
 * the desktop dialog already used; sharing it keeps "expires in 7 days" from
 * becoming "expires in 168 hours" on one platform.
 */
export const INVITE_EXPIRY_DAYS_THRESHOLD_HOURS = 48;

export function prefersDaysWording(usage: InviteUsage): boolean {
  return usage.hoursLeft !== null && usage.hoursLeft >= INVITE_EXPIRY_DAYS_THRESHOLD_HOURS;
}
