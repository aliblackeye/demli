import type { FastifyBaseLogger } from "fastify";
import type { RealtimeMutationPublisher, Repositories } from "@demli/db";
import { serverEvent } from "@demli/protocol";
import type { ChannelId, DmId, UserId } from "@demli/types";

/**
 * DM-call outcome "system" messages (ADR 0012 §7) — the inline call history in a
 * DM. On every terminal outcome the API writes a `kind: "system"` message into
 * the DM's hidden stream channel through the NORMAL message pipeline
 * (`repos.messages.create` + a channel-scoped `message.created` publish), so
 * persistence, pagination, and realtime broadcast behave exactly like a user
 * message — both members are already subscribed to the DM stream, so the
 * channel-scoped fan-out reaches them without any new routing.
 *
 * Like the server member joined/left notices (see `system-messages.ts`), the
 * persisted `content` is a stable, language-neutral TOKEN, never human language:
 * the client translates it per viewer. This file is the API-side source of the
 * token contract — the API stays React-free, so it does not import
 * `@demli/i18n`; a client wave adds the matching resolver keys (see the
 * `WIRE CONTRACT` note below). Until then, an unknown `@sys:` token renders
 * verbatim (the resolver's documented fallback), which is harmless because no
 * client renders DM-call system messages before that wave.
 *
 * WIRE CONTRACT (keep in sync with @demli/i18n `resolveSystemMessage`):
 *   @sys:call_ended:<seconds>  → "Call ended · mm:ss"  (parse trailing :<seconds>)
 *   @sys:call_missed           → "Missed call"
 *   @sys:call_declined         → "Call declined"
 *   @sys:call_canceled         → "Call canceled"
 *
 * Best-effort by contract: the call row + `call.ended` event are the source of
 * truth, so a failure here never fails the parent request — errors are logged
 * and swallowed.
 */

/** Prefix marking a message content as a system token (mirrors @demli/i18n). */
const SYSTEM_MESSAGE_PREFIX = "@sys:";

/** Terminal DM-call outcomes that produce an inline system message. */
export type DmCallOutcomeToken =
  | "call_ended"
  | "call_missed"
  | "call_declined"
  | "call_canceled";

/**
 * The persisted content for a DM-call outcome. `call_ended` carries the talk
 * time in whole seconds after a second colon (`@sys:call_ended:272`) so the
 * client can format `mm:ss`; the other outcomes are bare tokens.
 */
export function dmCallSystemContent(
  token: DmCallOutcomeToken,
  durationSeconds?: number,
): string {
  if (token === "call_ended" && durationSeconds !== undefined) {
    return `${SYSTEM_MESSAGE_PREFIX}call_ended:${Math.max(0, Math.round(durationSeconds))}`;
  }
  return `${SYSTEM_MESSAGE_PREFIX}${token}`;
}

export async function postDmCallSystemMessage(input: {
  repos: Repositories;
  mutationBus: RealtimeMutationPublisher | undefined;
  log: FastifyBaseLogger;
  dmId: DmId;
  /** The DM's hidden stream channel — where the system message is written. */
  streamId: ChannelId;
  /** Both DM member ids — unhidden so the outcome re-surfaces the conversation. */
  memberIds: readonly UserId[];
  /** The acting participant — becomes the message authorId (a valid user FK). */
  authorId: UserId;
  token: DmCallOutcomeToken;
  /** For `call_ended`: talk time in seconds, encoded into the token content. */
  durationSeconds?: number;
}): Promise<void> {
  try {
    const message = await input.repos.messages.create({
      channelId: input.streamId,
      authorId: input.authorId,
      content: dmCallSystemContent(input.token, input.durationSeconds),
      kind: "system",
    });
    // Channel-scoped fan-out: both DM members are subscribed to the stream, so
    // this reaches both without user-scoped duplication.
    await input.mutationBus?.publish({
      channelId: input.streamId,
      event: serverEvent.messageCreated(message),
    });
    // Re-surface the DM for anyone who had hidden it (a missed / ended call is
    // worth showing, mirroring the inbound-message unhide). Best-effort.
    for (const userId of new Set(input.memberIds)) {
      await input.repos.dms.unhide(input.dmId, userId);
    }
  } catch (err) {
    input.log.error({ err, dmId: input.dmId }, "dm-call system message write failed");
  }
}
