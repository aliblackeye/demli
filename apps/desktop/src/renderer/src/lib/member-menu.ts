/**
 * User action-menu rules — RE-EXPORT ONLY.
 *
 * The rules themselves live in `@demli/client-core` (`member-menu.ts`) so the
 * desktop/web renderer and the React Native app decide visibility from ONE
 * implementation. They were duplicated for exactly one wave (mobile lifted the
 * module out while this file was locked), and duplication is precisely how a
 * menu drifts: the first rule change lands on one surface while the other keeps
 * offering an action the server refuses — or, worse, hides a moderation action a
 * moderator actually holds.
 *
 * This stays as the renderer's import path so call sites read locally and a
 * future desktop-only helper has a home. It must not re-implement anything: add
 * shared behaviour to the client-core module, where its tests already live.
 */

export {
  DESTRUCTIVE_MEMBER_MENU_ITEMS,
  friendshipItemFor,
  isDestructiveMemberMenuItem,
  memberMenuGroups,
  memberMenuHas,
  memberMenuItems,
  TIMEOUT_PRESET_MINUTES,
  type MemberMenuContext,
  type MemberMenuGroup,
  type MemberMenuItem,
} from "@demli/client-core";
