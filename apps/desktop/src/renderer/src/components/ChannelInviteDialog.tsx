/**
 * "Invite a friend into THIS channel" (founder's third reference screenshot).
 *
 * Deliberately NOT a second invite system. It mints an ordinary invite through
 * the ordinary endpoint and only adds `targetChannelId`, so the link it produces
 * is the same shape every other link in the product is, redeems through the same
 * `POST /invites/:code/redeem`, and renders as the SAME in-chat invite card
 * (`InviteEmbedCard`) when it lands in a conversation. There is one link format,
 * one redeem path and one card — this dialog just aims them.
 *
 * Sending to a friend is therefore "post the link into their DM", via
 * `useSendDmMessage` — the profile card's existing send-without-navigating
 * mutation. The friend sees the card they already know how to use, in a place
 * they already look, instead of a bespoke "channel invitation" object with its
 * own inbox, its own notification and its own accept flow.
 *
 * What the redeemer gets is spelled out by the contract, and the VOICE half is
 * the important half: joining the server lands them in the target channel, and a
 * voice channel is opened but NOT connected. They press Join themselves
 * (founder: "tekrar bastığında sesli odaya katılır"). Auto-connecting someone's
 * microphone because they clicked a link is not something a link may do.
 *
 * Degrades cleanly against an API that does not know `targetChannelId` yet: the
 * field is ignored server-side, the dialog still produces a working server
 * invite, and the redeemer lands on the front door instead of the channel. No
 * error, no crash, no dead control (see `readInviteTargetChannel`).
 */
import { useEffect, useMemo, useState } from "react";
import { Check, Hash, Loader2, Volume2 } from "lucide-react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  UserAvatar,
} from "@demli/ui";
import { FormErrorAlert } from "@demli/app-ui";
import type { Channel, User, UserId } from "@demli/types";
import { localizeError } from "../lib/errors";
import { useAppTranslation } from "../lib/i18n";
import { buildInviteLink } from "../lib/invite-link";
import { useCreateInvite, useGroupDetails } from "../queries/chat-queries";
import { useFriends, useSendDmMessage } from "../queries/social-queries";
import { useChatStore } from "../stores/chat-store";
import { useUiStore } from "../stores/ui-store";
import {
  CopyField,
  inviteLimits,
  INVITE_EXPIRES_HOURS,
  INVITE_MAX_USES,
} from "./invite-shared";

/** Per-friend send state. One map in the parent; a row only reads its own entry. */
type SendState = "idle" | "sending" | "sent" | "failed";

/**
 * One friend row: avatar, name, username, and the send button.
 *
 * Subscribes to only THIS user's presence rather than the whole presence map, so
 * a tick for an unrelated user does not rerender the entire list (§27) — the
 * same shape `AddCallMemberDialog`'s candidate row uses.
 */
function FriendInviteRow({
  user,
  state,
  disabled,
  onSend,
}: {
  user: User;
  state: SendState;
  disabled: boolean;
  onSend: (userId: UserId) => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const presence = useChatStore((s) => s.presence[user.id] ?? "offline");
  const sent = state === "sent";

  return (
    <li className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
      <UserAvatar name={user.displayName} colorSeed={user.id} src={user.avatarUrl} size="sm" presence={presence} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-fg">{user.displayName}</span>
        <span className="truncate text-2xs text-fg-faint">@{user.username}</span>
      </span>
      <Button
        size="sm"
        // A sent invite stays visibly sent rather than reverting to "Invite":
        // the whole risk of this list is spamming the same person twice because
        // the row gave no memory of the first send.
        variant={sent ? "secondary" : "default"}
        disabled={sent || disabled}
        onClick={() => onSend(user.id)}
        className="w-28 shrink-0"
      >
        {state === "sending" && <Loader2 className="size-4 animate-spin" />}
        {sent && <Check className="size-4" />}
        {sent ? t("desktop:channelInvite.sent") : t("desktop:channelInvite.send")}
      </Button>
    </li>
  );
}

export function ChannelInviteDialog(): JSX.Element {
  const { t } = useAppTranslation();
  const channelId = useUiStore((s) => s.channelInviteChannelId);
  const setChannelInviteChannelId = useUiStore((s) => s.setChannelInviteChannelId);
  const activeGroupId = useChatStore((s) => s.activeGroupId);

  const open = channelId !== null;
  const { data: details } = useGroupDetails(activeGroupId);
  const { data: friends } = useFriends();

  const channel: Channel | undefined = useMemo(
    () => details?.channels.find((c) => c.id === channelId),
    [details, channelId],
  );
  const groupName = details?.group.name ?? t("desktop:invite.yourGroup");

  const createInvite = useCreateInvite(activeGroupId);
  const { mutate: mintInvite, reset: resetInvite } = createInvite;
  const sendDm = useSendDmMessage();

  const [query, setQuery] = useState("");
  const [sendStates, setSendStates] = useState<Record<UserId, SendState>>({});
  const [sendError, setSendError] = useState<unknown>(null);

  // Mint a fresh invite each time the dialog opens, carrying the target channel.
  // Keyed on `channelId` too, so reopening on a DIFFERENT channel mints a link
  // for THAT channel rather than reusing the previous one — a link that says
  // "#genel" while the dialog says "#oyunlar" is worse than no link at all.
  useEffect(() => {
    if (!open || !activeGroupId || !channelId) return;
    mintInvite({
      expiresInHours: INVITE_EXPIRES_HOURS,
      maxUses: INVITE_MAX_USES,
      targetChannelId: channelId,
    });
  }, [open, activeGroupId, channelId, mintInvite]);

  // Reset every per-open piece of state on close: a reopened dialog must not
  // show last time's "Invited" ticks against a link that no longer exists.
  useEffect(() => {
    if (open) return;
    resetInvite();
    setQuery("");
    setSendStates({});
    setSendError(null);
  }, [open, resetInvite]);

  const invite = createInvite.data?.invite;
  const inviteLink = invite ? buildInviteLink(invite.code) : null;

  const candidates = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (term.length === 0) return friends ?? [];
    return (friends ?? []).filter(
      (f) =>
        f.user.displayName.toLowerCase().includes(term) ||
        f.user.username.toLowerCase().includes(term),
    );
  }, [friends, query]);

  const send = (userId: UserId): void => {
    if (!inviteLink) return;
    setSendStates((prev) => ({ ...prev, [userId]: "sending" }));
    setSendError(null);
    sendDm.mutate(
      { userId, content: inviteLink },
      {
        onSuccess: () => setSendStates((prev) => ({ ...prev, [userId]: "sent" })),
        onError: (error) => {
          // Roll the row back so it can be retried, and say why (§26) — a button
          // that silently stops spinning teaches the user nothing.
          setSendStates((prev) => ({ ...prev, [userId]: "failed" }));
          setSendError(error);
        },
      },
    );
  };

  const ChannelIcon = channel?.kind === "voice" ? Volume2 : Hash;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && setChannelInviteChannelId(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("desktop:channelInvite.title", { group: groupName })}</DialogTitle>
          <DialogDescription>
            {/* The founder's "Alıcılar # genel konumuna gelecek" line. It is the
                only thing that distinguishes this from a plain server invite, so
                it names the channel rather than describing the feature. */}
            <span className="inline-flex items-center gap-1 align-middle">
              <ChannelIcon className="size-3.5 shrink-0" aria-hidden />
              <span>
                {t("desktop:channelInvite.destination", {
                  channel: channel?.name ?? t("desktop:channelInvite.thisChannel"),
                })}
              </span>
            </span>
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          {createInvite.isError && (
            <div className="mb-3 space-y-3">
              <FormErrorAlert>{localizeError(createInvite.error, t)}</FormErrorAlert>
              <Button
                variant="secondary"
                onClick={() => {
                  if (!channelId) return;
                  mintInvite({
                    expiresInHours: INVITE_EXPIRES_HOURS,
                    maxUses: INVITE_MAX_USES,
                    targetChannelId: channelId,
                  });
                }}
              >
                {t("buttons.retry")}
              </Button>
            </div>
          )}

          {sendError !== null && (
            <FormErrorAlert className="mb-3">{localizeError(sendError, t)}</FormErrorAlert>
          )}

          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoFocus
            spellCheck={false}
            placeholder={t("desktop:channelInvite.searchPlaceholder")}
            aria-label={t("desktop:channelInvite.searchPlaceholder")}
          />

          <ul
            className="mt-3 max-h-64 space-y-0.5 overflow-y-auto"
            aria-label={t("desktop:channelInvite.friendsLabel")}
          >
            {candidates.length === 0 ? (
              <li className="px-1 py-6 text-center text-sm text-fg-muted">
                {t("desktop:channelInvite.noFriends")}
              </li>
            ) : (
              candidates.map((friend) => (
                <FriendInviteRow
                  key={friend.user.id}
                  user={friend.user}
                  state={sendStates[friend.user.id] ?? "idle"}
                  // Disabled only until the link exists — sending to several
                  // friends in a row is the normal use, so one in-flight send
                  // must not lock the whole list.
                  disabled={inviteLink === null}
                  onSend={send}
                />
              ))
            )}
          </ul>

          <div className="mt-4 space-y-1.5 border-t border-stroke pt-4">
            <p className="text-xs font-medium text-fg-muted">
              {t("desktop:channelInvite.linkLabel")}
            </p>
            {inviteLink ? (
              <>
                <CopyField label={t("desktop:channelInvite.linkLabel")} value={inviteLink} />
                {invite && <p className="text-2xs text-fg-faint">{inviteLimits(invite, t)}.</p>}
              </>
            ) : (
              <div role="status" className="flex items-center gap-2 py-2 text-sm text-fg-muted">
                <Loader2 className="size-4 animate-spin" />
                {t("desktop:invite.creating")}
              </div>
            )}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
