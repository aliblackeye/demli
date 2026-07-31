/**
 * Pure decision logic for the USER context menu — WHICH entries a given viewer
 * may see for a given target, and in WHICH order.
 *
 * The menu opens from a right-click on desktop/web and from a long press on
 * mobile, over the same surfaces on both: a roster row, a message avatar, a DM
 * row, a voice tile, and the profile card's ⋯ button. Those are two very
 * different renderers, so the RULES live here — framework-free, in the package
 * both clients already depend on — and each renderer only decides what a row
 * looks like.
 *
 * Every visibility rule lives in this one module for four reasons:
 *
 * 1. §35 — no dead controls. An entry the API would reject is not disabled, it
 *    is NOT RENDERED. That rule is only checkable if the rules are in one place
 *    rather than spread across a 600-line JSX tree.
 * 2. The self-menu and the other-menu are genuinely DIFFERENT menus: you
 *    cannot message, call, friend, block, kick, ban or time
 *    out yourself, and the API rejects every one of those with a 400. Modelling
 *    that as `isSelf && ...` guards inline is how half of them get forgotten.
 * 3. Two platforms. A second copy of these rules for React Native is a second
 *    set of permission decisions to keep in sync, and the two would drift on the
 *    first rule change — the exact failure `resolveUserName` was extracted to
 *    avoid (ADR 0019 §2).
 * 4. The test suites are node-only on both sides, so a pure function is testable
 *    without a DOM or a native harness — the test IS the contract.
 *
 * COSMETIC gate only: the API re-checks every permission on every mutation
 * (§28). Hiding an entry is a UX promise, never a security boundary.
 */

import type { ProfileFriendshipStatus } from "@demli/types";

/**
 * Every entry the menu can render, in the order it renders them. The union is
 * exhaustive on purpose — adding an action without deciding where it sits and
 * who may see it is a type error, not a merge-time surprise.
 */
export type MemberMenuItem =
  // group 1 — identity & reaching them
  | "profile"
  | "mention"
  | "message"
  | "call"
  | "note"
  | "friendNickname"
  // group 2 — server-scoped identity + relationship
  | "editServerProfile"
  | "serverNickname"
  | "invite"
  | "addFriend"
  | "cancelFriendRequest"
  | "acceptFriendRequest"
  | "removeFriend"
  | "ignore"
  | "block"
  // group 3 — roles
  | "roles"
  // group 4 — moderation (destructive; rendered in danger colour)
  | "voiceDisconnect"
  | "timeout"
  | "kick"
  | "ban"
  // group 5 — always last
  | "copyUserId";

/** The separator-delimited groups, in render order. See {@link memberMenuGroups}. */
export type MemberMenuGroup = MemberMenuItem[];

export interface MemberMenuContext {
  /** The target IS the signed-in user — selects the (much shorter) self menu. */
  isSelf: boolean;
  /**
   * The viewer is looking at this user inside a SERVER (`kind === "server"`), so
   * server-scoped entries are meaningful at all. False on a DM row, the friends
   * list, or a flat group chat — there is no server to nickname, invite to,
   * kick from or assign roles in.
   */
  inServer: boolean;
  /** The target owns this server — never moderatable by anyone, mirroring the API guard. */
  targetIsOwner: boolean;
  /** The viewer owns this server (implies every permission). */
  viewerIsOwner: boolean;
  /** Viewer holds MANAGE_ROLES (or is the owner) — gates the role submenu. */
  canManageRoles: boolean;
  /**
   * Viewer holds MANAGE_NICKNAMES (or is the owner) — gates renaming SOMEONE
   * ELSE in this server. Renaming yourself needs no bit (ADR 0019 §2), which is
   * why the self menu offers it unconditionally.
   */
  canManageNicknames: boolean;
  /**
   * Viewer holds KICK_MEMBERS (or is the owner). One bit gates kick, ban,
   * timeout and voice-disconnect alike — see ADR 0019 §3 for why timeout reuses
   * it rather than minting a bit.
   */
  canModerate: boolean;
  /** Viewer may mint invite links here (owner ∨ CREATE_INVITE ∨ open policy). */
  canInvite: boolean;
  /** Target is connected to a voice channel right now, so "disconnect" means something. */
  targetInVoice: boolean;
  /** Target is currently timed out — flips the entry to "remove timeout". */
  targetTimedOut: boolean;
  /**
   * A text channel is selected, so inserting `@name` into a composer has
   * somewhere to land. Without one, "Mention" would type into nothing.
   */
  hasTextChannel: boolean;
  /**
   * There is a profile card this menu can open. False when the menu IS the
   * profile card's own ⋯ button: the card is already open, so a "Profile" entry
   * there would do nothing — a dead control §35 forbids, even a harmless one.
   */
  canOpenProfile: boolean;
  /**
   * Friendship as loaded from the profile query; `"unknown"` while it is still
   * pending, so no (possibly wrong) relationship entry is offered yet.
   */
  friendship: ProfileFriendshipStatus | "unknown";
  /** The viewer has blocked the target — every relationship action is refused server-side. */
  blocked: boolean;
  /** The viewer is ignoring the target — flips the entry to "un-ignore". */
  ignored: boolean;
}

/**
 * The single relationship entry that fits a friendship state. Mirrors the
 * profile card's primary button so the two surfaces never disagree about what
 * you can do with a person. `null` while the friendship is unknown (query
 * pending) — offering "Add friend" to an existing friend is worse than offering
 * nothing for a beat.
 */
export function friendshipItemFor(
  friendship: ProfileFriendshipStatus | "unknown",
): MemberMenuItem | null {
  switch (friendship) {
    case "none":
      return "addFriend";
    case "outgoing":
      return "cancelFriendRequest";
    case "incoming":
      return "acceptFriendRequest";
    case "friends":
      return "removeFriend";
    case "unknown":
    default:
      return null;
  }
}

/**
 * The menu as GROUPS of entries, separated by hairlines in the rendered menu.
 * Empty groups are dropped, so the caller can render one separator between
 * consecutive groups and never gets a stray divider or a doubled one.
 *
 * The grouping is the founder's reference layout:
 *
 *   SELF                          OTHER
 *   ────────────────────          ──────────────────────────────
 *   Profile                       Profile / Mention / Message /
 *   Mention                       Call / Note / Friend nickname
 *   ──────                        ──────────────────────────────
 *   Edit server profile           Server nickname / Invite /
 *   ──────                        Remove friend / Ignore / BLOCK
 *   Roles                    ▸    ──────────────────────────────
 *   ──────                        Roles                    ▸
 *   Copy user ID                  ──────────────────────────────
 *                                 TIMEOUT / KICK / BAN
 *                                 ──────────────────────────────
 *                                 Copy user ID
 *
 * "Copy user ID" is always last and always present — it is the one entry with
 * no precondition at all.
 */
export function memberMenuGroups(ctx: MemberMenuContext): MemberMenuGroup[] {
  return ctx.isSelf ? selfMenuGroups(ctx) : otherMenuGroups(ctx);
}

/**
 * Your OWN menu. Deliberately short: message/call/friend/block/kick/ban/timeout
 * are all self-directed no-ops the API rejects with a 400, so none of them
 * appear. What remains is the handful of things you really can do to yourself —
 * open your profile, mention yourself, rename yourself in this server, see your
 * roles, copy your id.
 */
function selfMenuGroups(ctx: MemberMenuContext): MemberMenuGroup[] {
  const identity: MemberMenuItem[] = [];
  if (ctx.canOpenProfile) identity.push("profile");
  if (ctx.hasTextChannel) identity.push("mention");

  const server: MemberMenuItem[] = [];
  // Renaming YOURSELF in a server needs no permission bit at all (ADR 0019 §2).
  if (ctx.inServer) server.push("editServerProfile");

  const roles: MemberMenuItem[] = [];
  // Same gate as anyone else's menu: the submenu appears only for a viewer who
  // may actually assign roles, so a plain member never sees a set of checkboxes
  // the API would reject (§35).
  if (ctx.inServer && ctx.canManageRoles) roles.push("roles");

  return dropEmpty([identity, server, roles, ["copyUserId"]]);
}

/** Somebody else's menu — the full surface, gated entry by entry. */
function otherMenuGroups(ctx: MemberMenuContext): MemberMenuGroup[] {
  const identity: MemberMenuItem[] = [];
  if (ctx.canOpenProfile) identity.push("profile");
  if (ctx.hasTextChannel) identity.push("mention");
  // A block refuses messaging and calling server-side, so offering either would
  // be a dead control (§35). Unblocking is the way back, and it stays below.
  if (!ctx.blocked) {
    identity.push("message");
    // Calling requires a mutual friendship (the DM-call rule, ADR 0012).
    if (ctx.friendship === "friends") identity.push("call");
  }
  // A note and a private nickname are yours, about them, and need no
  // relationship or permission whatsoever — they survive a block.
  identity.push("note", "friendNickname");

  const relationship: MemberMenuItem[] = [];
  // Renaming someone else for the whole server: owner ∨ MANAGE_NICKNAMES, and
  // never the owner (mirrors the API's owner immunity).
  if (ctx.inServer && ctx.canManageNicknames && !ctx.targetIsOwner) {
    relationship.push("serverNickname");
  }
  if (ctx.inServer && ctx.canInvite) relationship.push("invite");
  if (!ctx.blocked) {
    const friendItem = friendshipItemFor(ctx.friendship);
    if (friendItem) relationship.push(friendItem);
  }
  relationship.push("ignore", "block");

  const roles: MemberMenuItem[] = [];
  if (ctx.inServer && ctx.canManageRoles) roles.push("roles");

  // Moderation: authorized viewer only, and NEVER against the server owner.
  const moderation: MemberMenuItem[] = [];
  if (ctx.inServer && ctx.canModerate && !ctx.targetIsOwner) {
    // Only offered while they are actually in a voice channel — otherwise there
    // is nothing to disconnect them from.
    if (ctx.targetInVoice) moderation.push("voiceDisconnect");
    moderation.push("timeout", "kick", "ban");
  }

  return dropEmpty([identity, relationship, roles, moderation, ["copyUserId"]]);
}

function dropEmpty(groups: MemberMenuGroup[]): MemberMenuGroup[] {
  return groups.filter((group) => group.length > 0);
}

/** Flat, ordered list of every entry the menu would render. */
export function memberMenuItems(ctx: MemberMenuContext): MemberMenuItem[] {
  return memberMenuGroups(ctx).flat();
}

/** Whether a given entry is visible in this context — the assertion tests read. */
export function memberMenuHas(ctx: MemberMenuContext, item: MemberMenuItem): boolean {
  return memberMenuItems(ctx).includes(item);
}

/**
 * The destructive entries, rendered in the danger colour and always last before
 * "Copy user ID". Block sits with them visually even though it is a personal
 * action rather than a moderation one, because it is equally consequential.
 */
export const DESTRUCTIVE_MEMBER_MENU_ITEMS: ReadonlySet<MemberMenuItem> = new Set<MemberMenuItem>([
  "block",
  "voiceDisconnect",
  "timeout",
  "kick",
  "ban",
]);

/** Whether an entry must render in the danger colour. */
export function isDestructiveMemberMenuItem(item: MemberMenuItem): boolean {
  return DESTRUCTIVE_MEMBER_MENU_ITEMS.has(item);
}

/**
 * Timeout durations, in minutes. Offered as a submenu rather than a free-text
 * field: a moderator wants "mute them for ten minutes", not a form.
 * All are inside the API's [1 … 40320] range.
 */
export const TIMEOUT_PRESET_MINUTES: readonly number[] = [1, 5, 10, 60, 1440, 10080];

/**
 * The three entries that are the SAME action in two states — creating a value or
 * changing the one already there.
 */
export type MemberMenuEditableItem = "note" | "friendNickname" | "serverNickname";

/** Whether an editable entry currently has a value behind it. */
export interface MemberMenuEditableState {
  /** The viewer has a private note on this user. */
  hasNote: boolean;
  /** The viewer has a private nickname for this user (global, ADR 0019 §2). */
  hasFriendNickname: boolean;
  /** This user has a nickname in the server the menu was opened in. */
  hasServerNickname: boolean;
}

/**
 * "Add note" vs "Edit note" — and the same for both nicknames.
 *
 * A menu that always says "Add" when a value already exists is lying about what
 * the entry does, and the user cannot tell whether they are about to create or
 * overwrite (founder: "not ekle'ye basınca notu düzenle olmalı").
 *
 * Lives here rather than in either renderer because the desktop menu and the
 * mobile action sheet must agree — a second copy would drift on the first change,
 * the exact failure this module exists to prevent. Renderers map the variant onto
 * their own i18n keys; the DECISION is made once.
 *
 * NB: `editServerProfile` (renaming YOURSELF in a server) is the self-menu's
 * spelling of `serverNickname`, so callers pass `"serverNickname"` for both.
 */
export function memberMenuEntryVariant(
  item: MemberMenuEditableItem,
  state: MemberMenuEditableState,
): "add" | "edit" {
  switch (item) {
    case "note":
      return state.hasNote ? "edit" : "add";
    case "friendNickname":
      return state.hasFriendNickname ? "edit" : "add";
    case "serverNickname":
      return state.hasServerNickname ? "edit" : "add";
    default:
      return "add";
  }
}

/** Longest note shown inline beside a name on the profile card. */
export const NOTE_BADGE_MAX_LENGTH = 24;

/**
 * The SHORT form of a private note, for the `Name (note)` line on the profile
 * card (founder: "notu isminin yanına parantezle koyalım. kısa bişey olsun uzun
 * değil").
 *
 * Collapses newlines and runs of whitespace — a note is a free-text box and a
 * multi-line one would otherwise wreck the name row — then truncates on a word
 * boundary where one is close enough, with an ellipsis. Returns null for an
 * absent or whitespace-only note so the caller renders nothing at all rather
 * than an empty `()`.
 *
 * Formatting only: this never fetches, stores or forwards a note. The privacy
 * rule (a note is visible to its author and to nobody else) is enforced where it
 * is read — see the renderer's note-privacy invariant test.
 */
export function noteBadgeText(
  note: string | null | undefined,
  max: number = NOTE_BADGE_MAX_LENGTH,
): string | null {
  const flat = (note ?? "").replace(/\s+/g, " ").trim();
  if (flat.length === 0) return null;
  if (flat.length <= max) return flat;
  const clipped = flat.slice(0, max);
  const lastSpace = clipped.lastIndexOf(" ");
  // Only break on a word if that keeps most of the budget; otherwise hard-cut,
  // so a single long word does not collapse the badge to two characters.
  const body = lastSpace >= Math.floor(max * 0.6) ? clipped.slice(0, lastSpace) : clipped;
  return `${body.trimEnd()}…`;
}
