/**
 * channel-invite — the two pure rules behind "invite someone straight into THIS
 * channel" ("Kanala Davet Et" / "Sesli Sohbete Davet Et").
 *
 * There are exactly two decisions a client has to make on its own, and both of
 * them are the kind that silently diverge between surfaces if each writes its
 * own copy:
 *
 *  1. MAY THIS VIEWER INVITE AT ALL — {@link canCreateServerInvite}. The founder's
 *     reference screenshots make this a HARD requirement, not a nicety: a member
 *     without the permission sees no invite icon on the row and no invite entry
 *     in the menu. Not disabled — ABSENT (§35). The rule mirrors
 *     `POST /groups/:id/invites` in apps/api one-for-one, and it is COSMETIC only:
 *     the API re-checks membership, guest status and the policy on every call
 *     (§28), so a stale client can never mint a link it should not have.
 *
 *  2. WHERE DOES A REDEEMED INVITE LAND — {@link readInviteTargetChannel}. An
 *     invite may carry a `targetChannel`, and the client has to survive three
 *     different shapes of answer: the field present and usable, the field present
 *     but `null` (the channel was deleted, or the joiner cannot see it), and the
 *     field ABSENT ENTIRELY (an older server, or a client that shipped ahead of
 *     the API). The third case is the dangerous one — reading `.targetChannel.id`
 *     off an object that has no such key is how a join flow crashes on the one
 *     deployment where the two sides are half a release apart. So the read is
 *     defensive by construction: unknown in, a validated value or `null` out,
 *     never a throw.
 *
 * Framework-free and in client-core (not app-ui) so the React Native channel list
 * reads the SAME two rules — the exact reason `member-menu.ts`,
 * `voice-channel-chat.ts` and `channel-order.ts` live here.
 */

import type {
  ChannelKind,
  InvitePolicy,
  InviteTargetChannel,
  MemberRole,
} from "@demli/types";

export type { InviteTargetChannel };

/** Everything the invite gate needs to know about the viewer and their server. */
export interface ServerInviteViewer {
  /**
   * `FriendGroup.invitePolicy`. Optional/absent is treated as `"members"`, which
   * is the server's own default and the pre-M9 behavior — a group whose details
   * have not loaded yet therefore does NOT flash an invite control it might have
   * to take away, because `membershipRole` is still undefined and that fails
   * closed below.
   */
  invitePolicy: InvitePolicy | null | undefined;
  /** The viewer's membership role on this server; null/undefined while loading. */
  membershipRole: MemberRole | null | undefined;
  /** The viewer owns the server (bypasses the bitfield entirely, ADR 0007). */
  isOwner: boolean;
  /** The viewer holds `PERMISSIONS.CREATE_INVITE` through some role. */
  hasCreateInvitePermission: boolean;
}

/**
 * Whether the viewer may mint an invite for this server.
 *
 * Mirrors the API gate exactly:
 *   - no membership resolved yet → false (fail closed; never flash a control);
 *   - guest                      → false, always ("Guests cannot create invites.");
 *   - policy `"members"`         → any non-guest member;
 *   - policy `"roles"`           → the owner, or a holder of `CREATE_INVITE`.
 *
 * Channel VISIBILITY needs no separate check: a channel the viewer may not see
 * is absent from `GET /groups/:id` altogether (ADR 0007), so there is no row to
 * hang an invite control off in the first place.
 */
export function canCreateServerInvite(viewer: ServerInviteViewer): boolean {
  const { invitePolicy, membershipRole, isOwner, hasCreateInvitePermission } = viewer;
  if (isOwner) return true;
  if (!membershipRole) return false;
  if (membershipRole === "guest") return false;
  if ((invitePolicy ?? "members") === "members") return true;
  return hasCreateInvitePermission;
}

/*
 * The target's SHAPE is `InviteTargetChannel` from @demli/types (the wire
 * contract, migration 0021), re-exported above so a consumer of this rule does
 * not have to import from two places. What lives here is only the client's
 * willingness to trust an incoming one.
 *
 * `kind` matters because it changes what "landing there" means: a text channel
 * opens its conversation, and a VOICE channel opens its conversation too —
 * deliberately WITHOUT connecting. The founder was explicit about that second
 * step ("tekrar bastığında sesli odaya katılır"): auto-joining a room because
 * someone clicked a link would put a stranger's microphone into a live
 * conversation without a single deliberate gesture.
 */

function isChannelKind(value: unknown): value is ChannelKind {
  return value === "text" || value === "voice";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Pull a usable {@link InviteTargetChannel} out of an invite preview / redeem
 * response, or `null`.
 *
 * `null` is returned for EVERY not-usable case — field absent, field explicitly
 * null, wrong shape, unknown `kind` — and all of them mean the same thing to the
 * caller: treat this as a plain server invite. That collapse is deliberate. A
 * caller that had to distinguish "the server does not support targets" from "the
 * target is gone" would grow two code paths for one outcome, and the branch that
 * ran on the older deployment would be the one nobody ever exercised.
 */
export function readInviteTargetChannel(response: unknown): InviteTargetChannel | null {
  if (typeof response !== "object" || response === null) return null;
  const target = (response as { targetChannel?: unknown }).targetChannel;
  if (typeof target !== "object" || target === null) return null;
  const { id, name, kind } = target as { id?: unknown; name?: unknown; kind?: unknown };
  if (!isNonEmptyString(id) || !isChannelKind(kind)) return null;
  return {
    id,
    // A nameless channel is still a perfectly good navigation target; only the
    // id and the kind are load-bearing, so a missing name degrades to empty
    // rather than throwing the whole target away.
    name: isNonEmptyString(name) ? name : "",
    kind,
  };
}
