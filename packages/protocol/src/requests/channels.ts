/**
 * Channel create/update request bodies.
 *
 * Kind-dependent rules (`maxParticipants` only on voice, `slowmodeSeconds` only
 * on text) stay in the API handler on purpose: they need the STORED channel's
 * kind, which a request body cannot be trusted to state. This schema validates
 * shape and bounds; the handler validates against reality.
 */

import { z } from "zod";
import {
  AUDIO_BITRATE_MAX_KBPS,
  AUDIO_BITRATE_MIN_KBPS,
  CHANNEL_DESCRIPTION_MAX_LENGTH,
  CHANNEL_MAX_PARTICIPANTS,
  CHANNEL_NAME_MAX_LENGTH,
  CHANNEL_SLOWMODE_MAX_SECONDS,
  ROLE_ID_LIST_MAX,
} from "@demli/config";
import { requireAtLeastOneField, uuidField } from "./common.js";
import { nameText, sanitizedText, type TextField } from "./text.js";

/** Channel name: 1..64, at least one visible character. */
export const channelNameField: TextField = nameText(CHANNEL_NAME_MAX_LENGTH);

/**
 * Channel topic: 0..512, multiline.
 *
 * 512, not the 280 the desktop channel-settings dialog enforces today. The API
 * has always accepted 512; the client's tighter number was a second, invisible
 * rule that refused text the server would have stored.
 */
export const channelDescriptionField: TextField = sanitizedText({
  max: CHANNEL_DESCRIPTION_MAX_LENGTH,
  multiline: true,
});

/** `/channels/:channelId` routes. */
export const channelParamsSchema = z.object({ channelId: uuidField });

/** `POST /groups/:groupId/channels`. */
export const createChannelBodySchema = z.object({
  name: channelNameField,
  kind: z.enum(["text", "voice"]),
  /** Age-restricted (NSFW) flag; defaults false. */
  nsfw: z.boolean().optional(),
  /**
   * Create-time visibility restriction (ADR 0007). Omitted or empty = visible to
   * every member; non-empty locks the channel to the owner + holders of these
   * roles, applied atomically at creation.
   */
  roleIds: z.array(uuidField).max(ROLE_ID_LIST_MAX).optional(),
  /** Sidebar category (M18). Omitted/null = the uncategorized top-level list. */
  categoryId: uuidField.nullable().optional(),
});

/** `PATCH /channels/:channelId`. */
export const updateChannelBodySchema = z
  .object({
    name: channelNameField.optional(),
    description: channelDescriptionField.nullable().optional(),
    maxParticipants: z
      .number()
      .int()
      .min(1)
      .max(CHANNEL_MAX_PARTICIPANTS)
      .nullable()
      .optional(),
    /** Text channels only; 0 disables slowmode. */
    slowmodeSeconds: z.number().int().min(0).max(CHANNEL_SLOWMODE_MAX_SECONDS).optional(),
    /** Voice channels only; null resets to the media default. */
    audioBitrateKbps: z
      .number()
      .int()
      .min(AUDIO_BITRATE_MIN_KBPS)
      .max(AUDIO_BITRATE_MAX_KBPS)
      .nullable()
      .optional(),
    /** Age-restricted (NSFW) flag; toggles the channel's NSFW gate. */
    nsfw: z.boolean().optional(),
    /**
     * Move into a category, or out of one with `null` (M18). Position within the
     * bucket is set by `PATCH /groups/:groupId/channel-order`, which rewrites
     * both axes atomically.
     */
    categoryId: uuidField.nullable().optional(),
  })
  .superRefine(requireAtLeastOneField);

/** `PUT /channels/:channelId/access`. Empty list = visible to all members. */
export const setChannelAccessBodySchema = z.object({
  roleIds: z.array(uuidField).max(ROLE_ID_LIST_MAX),
});

export type CreateChannelBody = z.infer<typeof createChannelBodySchema>;
export type UpdateChannelBody = z.infer<typeof updateChannelBodySchema>;
export type SetChannelAccessBody = z.infer<typeof setChannelAccessBodySchema>;
