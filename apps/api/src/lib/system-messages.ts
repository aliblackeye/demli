import type { FastifyBaseLogger } from "fastify";
import type { RealtimeMutationPublisher, Repositories } from "@demli/db";
import { serverEvent } from "@demli/protocol";
import type { FriendGroup, User } from "@demli/types";

/**
 * Server notification ("system") messages — member joined / member left.
 *
 * Written to the server's system channel through the NORMAL message pipeline
 * (`repos.messages.create` with kind "system" + a message.created publish on
 * the mutation bus), so persistence, pagination, and realtime broadcast all
 * behave exactly like user messages — clients only branch on `kind`.
 *
 * The persisted `content` is a stable, language-neutral TOKEN (ADR 0009 §5),
 * never human language and never a display name: the client resolves the
 * author's current displayName from `authorId` and translates the token via
 * `resolveSystemMessage` (@demli/i18n). This keeps the row language- and
 * rename-independent, and lets every viewer read it in their own language.
 *
 * No-ops when the group is not a server (flat group chats never get system
 * messages) or when its system channel is unset (null = feature off).
 * Best-effort by contract: a failure here must never fail the parent request
 * (invite redeem / member leave already committed), so errors are logged and
 * swallowed.
 */

export type SystemMessageEvent = "joined" | "left";

/**
 * Wire contract for system-message content. These literals mirror
 * @demli/i18n's `SYSTEM_MESSAGE_TOKENS` / `resolveSystemMessage`; the API
 * stays React-free so it does not import that package — keep the two in sync.
 */
const CONTENT_TOKEN: Record<SystemMessageEvent, string> = {
  joined: "@sys:member_joined",
  left: "@sys:member_left",
};

export async function postMembershipSystemMessage(input: {
  repos: Repositories;
  mutationBus: RealtimeMutationPublisher | undefined;
  log: FastifyBaseLogger;
  group: FriendGroup;
  /** The user who joined/left — becomes the system message's authorId. */
  affectedUser: User;
  event: SystemMessageEvent;
}): Promise<void> {
  const { group } = input;
  if (group.kind !== "server") return;
  const channelId = group.systemChannelId ?? null;
  if (channelId === null) return;

  try {
    const message = await input.repos.messages.create({
      channelId,
      authorId: input.affectedUser.id,
      content: CONTENT_TOKEN[input.event],
      kind: "system",
    });
    // Fan out to connected WS clients via the api→realtime bus. The publisher
    // itself is best-effort (swallows and logs), matching edit/delete fan-out.
    await input.mutationBus?.publish({
      channelId,
      event: serverEvent.messageCreated(message),
    });
  } catch (err) {
    input.log.error({ err, groupId: group.id }, "system message write failed");
  }
}
