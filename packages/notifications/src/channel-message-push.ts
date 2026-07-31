import type { Repositories } from "@demli/db";
import type { ChannelId, GroupId, UserId } from "@demli/types";
import { mentionPushBody, resolveMentionRecipients } from "./mention-recipients.js";
import { filterMutedRecipients, type NotificationMuteStore } from "./mute-filter.js";
import type { OfflineNotifier } from "./notifications.js";

/**
 * "All messages" offline push fan-out for group/server channels (#94).
 *
 * Our default: every message in a channel you can see notifies you when you are
 * away — not just DMs and @mentions. This is the single, transport-
 * agnostic dispatcher the REST create path (apps/api) and the WS gateway
 * (apps/realtime) BOTH call for a NON-DM channel message, so the two paths
 * cannot drift (the DM branch stays separate — a DM notifies only the other
 * member, never the whole channel roster).
 *
 * Fan-out audience = every member who can SEE the channel (role visibility
 * enforced in SQL by `recipientIdsForChannel`, so a restricted channel never
 * leaks to a member who lacks the granting role — §28, M9-4), minus the author.
 * That audience splits in two:
 *  - directly @mentioned members keep the higher-signal MENTION push (author as
 *    title, `type:"mention"`, no collapse) — unchanged from before #94;
 *  - everyone else gets the new plain CHANNEL push ("Server #channel" / "Author:
 *    text", `type:"message"`, per-channel collapse).
 *
 * The notification-mute gate (`filterMutedRecipients`) runs on TOP per member
 * with the correct `isMention` flag: `mode:"all"` drops everything, and
 * `mode:"mentions"` passes only the mentioned subset. The offline gate is the
 * notifier's job — an online (WS-connected) member is never pushed.
 */

/**
 * Least-privilege repo slice the dispatcher needs — a full {@link Repositories}
 * satisfies it structurally, and a unit test can stub each method. `channelAccess`
 * carries both the reverse fan-out query and the per-user check the mention
 * resolver re-validates with.
 */
export interface ChannelMessagePushRepos {
  channelAccess: Pick<
    Repositories["channelAccess"],
    "recipientIdsForChannel" | "canUserSeeChannel"
  >;
  groups: Pick<Repositories["groups"], "findById">;
  users: Pick<Repositories["users"], "findById">;
  /** Optional — omitted (passthrough) when the mute feature is not wired in a test. */
  notificationMutes?: NotificationMuteStore;
  /**
   * Block store (M18, ADR 0017). When present, every recipient with a block
   * against the AUTHOR in either direction is dropped from BOTH the mention and
   * the plain-channel push — a block must silence the ping, not just hide the
   * message, or the blocked user could still buzz someone's phone from a shared
   * server. ONE batched query over the already-computed audience. Optional
   * (passthrough) so tests that predate M18 keep their exact behaviour.
   */
  userBlocks?: Pick<Repositories["userBlocks"], "relatedIds">;
  /**
   * Ignore store (migration 0020, ADR 0019 §4). When present, every recipient who
   * IGNORES the author is dropped from both pushes.
   *
   * This is the half of "ignore" that has to be server-side, and it is the only
   * half: a push is handed to a device's OS by the server, so a client cannot
   * suppress a notification it never sees. Message CONTENT is deliberately not
   * filtered here or anywhere — the client collapses those rows instead, because
   * an ignore is about attention rather than access and the user must stay able
   * to expand one (see the ADR, and the contrast with the block filter above:
   * that one hides content precisely because a block IS about access).
   *
   * ONE-DIRECTIONAL by construction: `ignorersAmong` asks "which of these
   * recipients ignore this author", never the reverse. Optional (passthrough) so
   * tests predating 0020 keep their exact behaviour.
   */
  userIgnores?: Pick<Repositories["userIgnores"], "ignorersAmong">;
}

export interface DispatchChannelMessagePushDeps {
  repos: ChannelMessagePushRepos;
  /** Offline-gated push sink. Absent → the whole dispatch is a no-op (no DB work). */
  notifier?: OfflineNotifier;
  log?: (message: string) => void;
}

export interface DispatchChannelMessagePushArgs {
  channelId: ChannelId;
  groupId: GroupId;
  /** The channel's display name — the `#channel` half of the push title. */
  channelName: string;
  authorId: UserId;
  /** The persisted message body (mentions stored inline as `<@id>`). */
  content: string;
  messageId: string;
}

/**
 * Per-channel collapse key for the plain channel push (#94). A burst of messages
 * in the SAME channel collapses to one rolling notification on the device rather
 * than stacking N. Namespaced so it never collides with a future collapse topic.
 */
export function channelPushCollapseKey(channelId: string): string {
  return `channel:${channelId}`;
}

/**
 * The plain channel push's `{ title, body }`: `"Server #channel"` over
 * `"Author: message"`, reusing `mentionPushBody` for the same whitespace-
 * collapsed, 140-char, attachment-aware preview every other push uses.
 */
export function channelMessagePushContent(input: {
  groupName: string;
  channelName: string;
  authorName: string;
  content: string;
}): { title: string; body: string } {
  return {
    title: `${input.groupName} #${input.channelName}`,
    body: `${input.authorName}: ${mentionPushBody(input.content)}`,
  };
}

export async function dispatchChannelMessagePush(
  deps: DispatchChannelMessagePushDeps,
  args: DispatchChannelMessagePushArgs,
): Promise<void> {
  const { notifier } = deps;
  // No notifier → nothing to deliver; bail before any DB work (the common path
  // in every test/route that does not wire push).
  if (!notifier) return;
  const { repos } = deps;
  const log = deps.log ?? (() => undefined);
  const { channelId, groupId, channelName, authorId, content, messageId } = args;

  // Everyone who can SEE this channel, minus the author. Role visibility is
  // enforced in the query, so a member who cannot see a restricted channel is
  // never a push candidate (§28).
  let audience = (
    await repos.channelAccess.recipientIdsForChannel(groupId, channelId)
  ).filter((id) => id !== authorId);
  if (audience.length === 0) return;

  // Block filter (M18, ADR 0017): drop every recipient with a block against the
  // author in EITHER direction, BEFORE the mention split — so a blocked user can
  // neither @ping their way onto someone's lock screen nor be pinged by them. One
  // batched query bounded to this audience (no N+1). The message itself is
  // already hidden from these readers by the SQL filter on the history/search
  // paths; this closes the notification half of the same rule.
  if (repos.userBlocks && audience.length > 0) {
    const blocked = await repos.userBlocks.relatedIds(authorId, audience);
    if (blocked.size > 0) {
      audience = audience.filter((id) => !blocked.has(id));
      if (audience.length === 0) return;
    }
  }

  // Ignore filter (migration 0020, ADR 0019 §4): drop every recipient who has
  // chosen to ignore the author. Applied here, BEFORE the mention split, for the
  // same reason as the block filter — otherwise an ignored user could still buzz
  // someone's phone simply by typing their `<@id>`, and "I stopped being
  // notified by them" would be false in the one case that matters most.
  //
  // Note what this does NOT do, and the difference from the line above: the
  // message is still delivered and still stored, and nothing about the author's
  // experience changes. Only the ping stops.
  if (repos.userIgnores && audience.length > 0) {
    const ignorers = await repos.userIgnores.ignorersAmong(authorId, audience);
    if (ignorers.size > 0) {
      audience = audience.filter((id) => !ignorers.has(id));
      if (audience.length === 0) return;
    }
  }

  // The directly-@mentioned subset (deduped, visibility re-checked, author
  // dropped, count-capped by the shared resolver). These keep the mention push;
  // the rest of the audience gets the plain channel push.
  const resolvedMentions = await resolveMentionRecipients(
    { repos: { channelAccess: repos.channelAccess } },
    { channelId, groupId, authorId, content },
  );
  // Intersect with the (block-filtered) audience: the mention resolver derives
  // its list from the message CONTENT, independently of `audience`, so without
  // this a blocked user named in an `<@id>` would still be pushed (M18).
  const audienceSet = new Set<UserId>(audience);
  const mentioned = resolvedMentions.filter((id) => audienceSet.has(id));
  const mentionedSet = new Set<UserId>(mentioned);
  const plain = audience.filter((id) => !mentionedSet.has(id));

  const author = await repos.users.findById(authorId);
  const authorName = author?.displayName ?? "New message";

  // --- Mention push: unchanged format (author-titled, type "mention", no
  // collapse). `isMention: true` lets a `mode:"mentions"` mute through. ---
  if (mentioned.length > 0) {
    const recipients = await filterMutedRecipients(
      repos.notificationMutes,
      mentioned,
      { channelId, groupId, isMention: true },
      log,
    );
    if (recipients.length > 0) {
      await notifier.notify(recipients, {
        title: authorName,
        body: mentionPushBody(content),
        data: { type: "mention", channelId, groupId, messageId },
      });
    }
  }

  // --- Plain channel push (#94): the all-messages default. `isMention: false`,
  // so a `mode:"mentions"` mute silences it and only `mode:"all"` differs. ---
  if (plain.length > 0) {
    const recipients = await filterMutedRecipients(
      repos.notificationMutes,
      plain,
      { channelId, groupId, isMention: false },
      log,
    );
    if (recipients.length > 0) {
      const group = await repos.groups.findById(groupId);
      const { title, body } = channelMessagePushContent({
        groupName: group?.name ?? "New message",
        channelName,
        authorName,
        content,
      });
      await notifier.notify(recipients, {
        title,
        body,
        data: { type: "message", channelId, groupId, name: channelName, messageId },
        collapseKey: channelPushCollapseKey(channelId),
      });
    }
  }
}
