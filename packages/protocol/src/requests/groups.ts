/**
 * Server (`friend_group`) and group-chat request bodies, plus the moderation
 * bodies that hang off a server.
 */

import { z } from "zod";
import {
  BAN_REASON_MAX_LENGTH,
  GROUP_NAME_MAX_LENGTH,
  MEDIA_URL_MAX_LENGTH,
  MEMBER_NICKNAME_MAX_LENGTH,
  TIMEOUT_MAX_MINUTES,
  TIMEOUT_MIN_MINUTES,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from "@demli/config";
import { requireAtLeastOneField, uuidField } from "./common.js";
import { httpUrl, nameText, sanitizedText, type TextField } from "./text.js";

/** Server / group-chat name: 1..64, at least one visible character. */
export const groupNameField: TextField = nameText(GROUP_NAME_MAX_LENGTH);

/** `POST /groups`. */
export const createGroupBodySchema = z.object({ name: groupNameField });

/** `PATCH /groups/:groupId`. */
export const updateGroupBodySchema = z
  .object({
    name: groupNameField.optional(),
    iconUrl: httpUrl(MEDIA_URL_MAX_LENGTH).nullable().optional(),
    /**
     * Server banner (M20); `null` REMOVES it. Only a removal (or a re-point at an
     * URL the server itself already issued) is expressible here — a new image
     * arrives as bytes through `POST /groups/:groupId/banner`, which is the only
     * path that can verify what it is.
     */
    bannerUrl: httpUrl(MEDIA_URL_MAX_LENGTH).nullable().optional(),
    /** Text channel of THIS server that receives system messages; null = off. */
    systemChannelId: uuidField.nullable().optional(),
    /** Who may create invites (M9): "members" (default) or "roles". Owner-only. */
    invitePolicy: z.enum(["members", "roles"]).optional(),
  })
  .superRefine(requireAtLeastOneField);

/** `GET|PATCH|DELETE /groups/:groupId` and everything nested under it. */
export const groupParamsSchema = z.object({ groupId: uuidField });

/** `/groups/:groupId/members/:userId` routes (kick, roles, ban lift). */
export const memberParamsSchema = z.object({ groupId: uuidField, userId: uuidField });

/** `POST /group-chats` — a flat group DM. Same name rules as a server. */
export const createGroupChatBodySchema = z.object({ name: groupNameField });

/** `/group-chats/:id` routes. */
export const groupChatParamsSchema = z.object({ id: uuidField });

/** `/group-chats/:id/members/:userId`. */
export const groupChatMemberParamsSchema = z.object({ id: uuidField, userId: uuidField });

/**
 * `POST /group-chats/:id/members` — add by username.
 *
 * The `@` a user naturally types is stripped INSIDE the schema, then the real
 * username bounds (3..32) apply. The API currently caps the analogous
 * friends-by-username field at a hand-written 64 while a username can only be
 * 32, so a client can send 40 characters that could never match any account and
 * gets a uniform "no result" instead of "that is not a username at all".
 *
 * The grammar is NOT enforced here: an unknown-but-legal value and a malformed
 * one must produce the SAME uniform response, or this route becomes an existence
 * oracle for accounts (§28). Only the bounds are checked, so a typo the user can
 * see and fix gets a real message while a probe learns nothing.
 */
export const addGroupChatMemberBodySchema = z.object({
  username: z
    .string()
    .transform((value) => value.trim().replace(/^@+/, "").trim().toLowerCase())
    .pipe(z.string().min(USERNAME_MIN_LENGTH).max(USERNAME_MAX_LENGTH)),
});

/**
 * `POST /groups/:groupId/bans`.
 *
 * `reason` is a moderator note stored on the ban row — free text, never shown to
 * the banned user, so it is sanitized and capped and nothing more.
 */
export const banBodySchema = z.object({
  userId: uuidField,
  reason: sanitizedText({ max: BAN_REASON_MAX_LENGTH, multiline: true }).optional(),
});

/**
 * `PUT /groups/:groupId/members/:userId/nickname` (migration 0020, ADR 0019).
 *
 * The PUBLIC, per-server nickname — everyone in the server sees it. `null` (or a
 * value that sanitizes to empty) CLEARS it and falls back to the display name,
 * the same "empty means clear" rule the custom status uses, so clearing never
 * needs a second endpoint.
 *
 * `nameText` rather than a bare length cap: a nickname stands in for a display
 * name in the member list and on every message row, so an all-invisible one would
 * blank a member out of the roster — exactly what the visible-character rule
 * exists to stop.
 */
export const setMemberNicknameBodySchema = z.object({
  nickname: nameText(MEMBER_NICKNAME_MAX_LENGTH).nullable(),
});

/**
 * `POST /groups/:groupId/members/:userId/timeout` (migration 0020, ADR 0019).
 *
 * `minutes` is a DURATION, not an instant: a client that sent an absolute
 * timestamp would put the length of a mute at the mercy of its own clock, and a
 * device an hour fast would silently issue an hour-shorter timeout. The server
 * turns this into `now + minutes` with its own clock, so the value the moderator
 * picked is the value that is served.
 *
 * The 28-day ceiling is a real product bound — see `TIMEOUT_MAX_MINUTES`.
 */
export const timeoutMemberBodySchema = z.object({
  minutes: z.number().int().min(TIMEOUT_MIN_MINUTES).max(TIMEOUT_MAX_MINUTES),
  reason: sanitizedText({ max: BAN_REASON_MAX_LENGTH, multiline: true }).optional(),
});

export type CreateGroupBody = z.infer<typeof createGroupBodySchema>;
export type UpdateGroupBody = z.infer<typeof updateGroupBodySchema>;
export type CreateGroupChatBody = z.infer<typeof createGroupChatBodySchema>;
export type AddGroupChatMemberBody = z.infer<typeof addGroupChatMemberBodySchema>;
export type BanBody = z.infer<typeof banBodySchema>;
export type SetMemberNicknameBody = z.infer<typeof setMemberNicknameBodySchema>;
export type TimeoutMemberBody = z.infer<typeof timeoutMemberBodySchema>;
