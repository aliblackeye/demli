/**
 * Invite-link format — RE-EXPORTED from `@demli/protocol`, which is the one
 * canonical source (`packages/protocol/src/requests/invites.ts`). Links read
 * `https://app.getdemli.com/invite/<code>` everywhere they are PRODUCED, while
 * `parseInviteCode` also accepts a bare code, a `demli://join/…` link and the
 * short `https://…/kat/…` form.
 */

export {
  INVITE_LINK_PREFIX,
  buildInviteLink,
  findInviteCodesInText,
  isInviteLinkUrl,
  parseInviteCode,
} from "@demli/protocol";
