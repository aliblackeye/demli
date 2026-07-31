import type { Repositories } from "@demli/db";
import { extractMentionTargets, isBroadcastMentionTarget } from "@demli/protocol";
import type { ChannelId, GroupId, UserId } from "@demli/types";

/**
 * Shared @mention recipient resolver (task: chat mentions → offline push).
 *
 * Both the REST create path (apps/api) and the WS gateway (apps/realtime) send
 * messages, and BOTH must fire an offline push at a directly-@mentioned user.
 * This resolver is the single, transport-agnostic place that turns a message
 * body into the deduped, access-checked, bounded list of user ids to notify —
 * so the two paths cannot drift and there is no duplicated logic.
 *
 * The mention wire encoding is owned entirely by @demli/protocol
 * (`extractMentionTargets` / `isBroadcastMentionTarget`); nothing here parses
 * `<@…>` by hand, so there are no magic mention strings (CLAUDE.md §24).
 */

/**
 * Least-privilege repo slice the resolver needs: only the per-user channel
 * visibility check. Narrower than the full {@link Repositories} both so the
 * dependency surface is honest (§28) and so a unit test can stub it with a
 * single method. A full `Repositories` structurally satisfies this at call sites.
 */
export interface MentionRecipientRepos {
  channelAccess: Pick<Repositories["channelAccess"], "canUserSeeChannel">;
}

export interface ResolveMentionRecipientsDeps {
  repos: MentionRecipientRepos;
}

export interface ResolveMentionRecipientsArgs {
  channelId: ChannelId;
  groupId: GroupId;
  authorId: UserId;
  /** The persisted message body — mentions are stored inline as `<@id>`. */
  content: string;
}

/**
 * Max distinct @mention targets a single message may fan a push out to. Bounds
 * the number of visibility checks (DB reads) and the push audience against an
 * adversarial message stuffed with mentions (§28). Applied to the DEDUPED,
 * non-broadcast, non-author candidate set, before any DB work.
 */
export const MENTION_RECIPIENTS_MAX = 50;

/**
 * The deduped user ids that a message's direct @mentions should notify.
 *
 * Pipeline: extract every `<@target>` (protocol) → dedupe in document order →
 * drop the broadcast keywords `@everyone`/`@here` (channel-wide fan-out is a
 * DOCUMENTED SEAM — deliberately NOT notified here) → drop the author's own id
 * (never notify yourself) → cap at {@link MENTION_RECIPIENTS_MAX} → keep only
 * ids that can ACTUALLY see this channel.
 *
 * The visibility re-check is the security boundary: a mention target is just a
 * string the client put in the body, so the sender is never trusted (§28). A
 * fabricated id, a non-member, or a user lacking the granting role for a
 * restricted channel is dropped before it can receive a push.
 */
export async function resolveMentionRecipients(
  deps: ResolveMentionRecipientsDeps,
  args: ResolveMentionRecipientsArgs,
): Promise<UserId[]> {
  const { channelId, groupId, authorId, content } = args;

  // Fast path: the overwhelming majority of messages carry no mention marker,
  // so skip all work (and any DB round-trip) when there is none.
  if (!content.includes("<@")) return [];

  const candidates: UserId[] = [];
  const seen = new Set<string>();
  for (const target of extractMentionTargets(content)) {
    if (seen.has(target)) continue;
    seen.add(target);
    if (isBroadcastMentionTarget(target)) continue; // broadcast seam, not notified
    if (target === authorId) continue; // never notify yourself
    candidates.push(target);
    if (candidates.length >= MENTION_RECIPIENTS_MAX) break; // bound abuse (§28)
  }
  if (candidates.length === 0) return [];

  // Re-validate visibility server-side (§28). Sequential to stay gentle on the
  // connection pool — the candidate set is already bounded by the cap above.
  const recipients: UserId[] = [];
  for (const userId of candidates) {
    if (await deps.repos.channelAccess.canUserSeeChannel(groupId, channelId, userId)) {
      recipients.push(userId);
    }
  }
  return recipients;
}

/**
 * Push-notification body from raw message text: whitespace collapsed to single
 * spaces, trimmed, capped at 140 chars (ellipsized), with a neutral placeholder
 * for an attachment-only (empty-text) message. Shared by the REST and WS send
 * paths so a notification reads identically regardless of transport.
 *
 * NOTE (future seam): a mention body still contains the RAW `<@id>` wire token
 * rather than the mentioned member's display name — acceptable for MVP. Resolving
 * ids → names in the push body is a documented follow-up (it needs a member-name
 * lookup the best-effort push path deliberately does not do today).
 */
export function mentionPushBody(content: string): string {
  const clean = content.replace(/\s+/g, " ").trim();
  if (clean.length === 0) return "Sent an attachment.";
  return clean.length > 140 ? `${clean.slice(0, 139)}…` : clean;
}
