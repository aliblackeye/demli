/**
 * Invite request bodies + the ONE canonical invite link format and parser.
 *
 * The desktop/web renderer re-exports these from `lib/invite-link.ts`;
 * `apps/mobile/src/lib/deep-links.ts` still carries its own copy (mobile parity
 * is a tracked Director queue item). The parse is part of the schema: whatever
 * the user pasted becomes a code first, and the code is what gets validated.
 */

import { z } from "zod";
import {
  INVITE_CODE_MAX_LENGTH,
  INVITE_CODE_MIN_LENGTH,
  INVITE_EXPIRES_HOURS_MAX,
  INVITE_EXPIRES_HOURS_MIN,
  INVITE_MAX_USES_MAX,
  INVITE_MAX_USES_MIN,
} from "@demli/config";
import { customIssue } from "./codes.js";
import { type TextField } from "./text.js";

/**
 * The ONE public invite origin (founder, 2026-07-27): links read
 * `https://app.getdemli.com/invite/<kod>` — short, brandable, and English on
 * purpose ("kat olmasın. belki kullanan adam ingilizce"): an invite link is
 * pasted into arbitrary chats and read by people who do not share our UI
 * language, so the path segment stays language-neutral. The web SPA at that
 * host resolves `/invite/<code>` into the join flow. The old brand name must never
 * appear in anything a user SEES; the legacy formats below survive only as
 * parse/detect inputs.
 */
export const INVITE_LINK_HOST = "app.getdemli.com";
/** URL path segment that opens the join flow (canonical, English). */
export const INVITE_LINK_PATH = "invite";
/** Scheme + host + path prefix of a shareable invite link. */
export const INVITE_LINK_PREFIX = `https://${INVITE_LINK_HOST}/${INVITE_LINK_PATH}/`;

/**
 * Custom-scheme form of an invite link. The shareable link is always the https
 * one above (it works for a recipient WITHOUT the app installed); this scheme is
 * what the OS hands back when an installed app claims the link.
 */
export const INVITE_SCHEME_PREFIX = "demli://join/";

/** Short path segment (`/kat/`) — the mobile deep-link contract shares it. */
export const SHORT_INVITE_LINK_PATH = "kat";

/** Build the shareable link for an invite code. */
export function buildInviteLink(code: string): string {
  return `${INVITE_LINK_PREFIX}${encodeURIComponent(code)}`;
}

/**
 * Extract a bare invite code from whatever the user pasted — a raw code, a
 * `demli://join/<code>` link, an `https://…/invite/<code>` (or the short
 * `…/kat/<code>`) web link, or any of those with a trailing query/hash.
 *
 * Keeps the last non-empty path segment and drops the `?`/`#` tail. Returns `""`
 * when nothing usable is left, which the schema turns into a real error rather
 * than sending an empty code to the API.
 */
export function parseInviteCode(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) return "";
  const withoutQuery = trimmed.split(/[?#]/)[0] ?? trimmed;
  return withoutQuery.split("/").filter(Boolean).pop() ?? "";
}

/* ── In-chat invite-link detection (davet embed kartı) ─────────────────────── */

/**
 * The code charset a DETECTED link must carry. Wider than the server's
 * generation alphabet (unambiguous A-Z/2-9) on purpose — historic codes and
 * future alphabet changes keep matching — but still URL-path-safe, so a normal
 * sentence can never bleed into a match.
 */
const INVITE_CODE_CHARSET = `[A-Za-z0-9_-]{${INVITE_CODE_MIN_LENGTH},${INVITE_CODE_MAX_LENGTH}}`;

/**
 * Every link shape that means "this is an invite" inside chat text: the
 * canonical `https://app.getdemli.com/invite/<code>`, the same host's short
 * `/kat/<code>` form, and the `demli://join/<code>` scheme. HOST-ANCHORED
 * deliberately — a random `https://example.com/invite/x` is somebody's URL,
 * not our invite (no false positives), which is also why this is stricter than
 * {@link parseInviteCode} (that one normalizes text the user explicitly pasted
 * INTO the join form).
 */
const INVITE_LINK_DETECT_SOURCE =
  `(?:https?://${INVITE_LINK_HOST.replace(/\./g, "\\.")}/(?:${INVITE_LINK_PATH}|${SHORT_INVITE_LINK_PATH})/` +
  `|demli://join/)(${INVITE_CODE_CHARSET})`;

/** Whether one URL (e.g. a server-unfurled embed's) is an invite link. */
export function isInviteLinkUrl(url: string): boolean {
  return new RegExp(`^${INVITE_LINK_DETECT_SOURCE}(?:[/?#]|$)`, "i").test(url.trim());
}

/**
 * Every invite CODE mentioned in a chat message, in order, deduplicated.
 * Only full links count — a bare code inside prose is just a word. The caller
 * caps how many cards it renders; this returns them all.
 */
export function findInviteCodesInText(text: string): string[] {
  if (text.length === 0 || !text.includes("/")) return [];
  const re = new RegExp(INVITE_LINK_DETECT_SOURCE, "gi");
  const seen = new Set<string>();
  const codes: string[] = [];
  for (const match of text.matchAll(re)) {
    const code = match[1];
    if (code === undefined || seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }
  return codes;
}

/**
 * An invite code as TYPED: parsed down from a link if needed, then bounded.
 *
 * The bounds apply to the parsed code, not the pasted text — a 90-character
 * invite URL is perfectly valid input even though the code inside it is 8
 * characters, and checking the raw string would reject it.
 */
export const inviteCodeField: TextField = z
  .string()
  .transform(parseInviteCode)
  .superRefine((code, ctx) => {
    if (code.length < INVITE_CODE_MIN_LENGTH || code.length > INVITE_CODE_MAX_LENGTH) {
      ctx.addIssue(customIssue("invalidInviteCode"));
    }
  });

/** `POST /invites/:code/redeem` — the `:code` segment (already a bare code). */
export const redeemParamsSchema = z.object({
  code: z.string().trim().min(INVITE_CODE_MIN_LENGTH).max(INVITE_CODE_MAX_LENGTH),
});

/**
 * `POST /groups/:groupId/invites` and `POST /group-chats/:id/invites`.
 *
 * ONE schema for both on purpose: a group-DM link is the SAME `invites` row
 * against a `kind='group'` friend_group, redeemed through the SAME endpoint. The
 * API declares the identical body twice with a comment explaining they are
 * deliberately identical — which is the moment to have one of them.
 */
export const createInviteBodySchema = z.object({
  /** Hours until expiry; omit for a non-expiring invite. */
  expiresInHours: z
    .number()
    .int()
    .min(INVITE_EXPIRES_HOURS_MIN)
    .max(INVITE_EXPIRES_HOURS_MAX)
    .optional(),
  /** Maximum redemptions; omit for unlimited. */
  maxUses: z
    .number()
    .int()
    .min(INVITE_MAX_USES_MIN)
    .max(INVITE_MAX_USES_MAX)
    .optional(),
});

/**
 * `POST /groups/:groupId/invites` — the SERVER form of the body.
 *
 * Servers get one extra, optional field that a group-DM link has no meaning for:
 * the channel the invite lands on. Kept as an extension rather than folded into
 * {@link createInviteBodySchema} so `POST /group-chats/:id/invites` cannot
 * silently accept a field it would ignore — a flat group chat has no channel
 * picker, and a body it drops on the floor is a lie about what the API does.
 *
 * The invite LINK is unchanged either way: one deep-link shape
 * (`…/invite/<code>`). The destination rides on the invite row, not the URL, so
 * every existing parser and every already-shared link keeps working.
 */
export const createServerInviteBodySchema = createInviteBodySchema.extend({
  /**
   * Channel to land the joiner on; omit for a plain "join my server" invite.
   * The API additionally proves the channel is in THIS group and that the
   * creator can see it — an invite to a channel its own author cannot open is
   * refused rather than minted (ADR 0007, CLAUDE.md §35).
   */
  targetChannelId: z.string().uuid().optional(),
});

/** The join form's body: whatever the user pasted, parsed to a code. */
export const joinByCodeBodySchema = z.object({ code: inviteCodeField });

export type CreateInviteBody = z.infer<typeof createInviteBodySchema>;
export type CreateServerInviteBody = z.infer<typeof createServerInviteBodySchema>;
export type JoinByCodeBody = z.infer<typeof joinByCodeBodySchema>;
