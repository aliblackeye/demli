/**
 * The social + moderation items for a voice participant's RIGHT-CLICK menu. Shared
 * by both voice-roster surfaces: {@link ParticipantVolumeMenu} (participants in
 * YOUR room — appended below the volume slider) and {@link VoiceOccupantRow}
 * (occupants of a channel you are not in). It renders raw `ContextMenuItem`s, so
 * the caller supplies the surrounding `ContextMenu` / `ContextMenuContent`.
 *
 * Every visibility rule is the pure {@link visibleParticipantActions} contract
 * (unit-tested): an UNAUTHORIZED viewer only ever sees the social action + invite;
 * disconnect/kick/ban appear ONLY for an authorized viewer, and never against the
 * owner or oneself (§35). The permission gate here is COSMETIC — the API re-checks
 * every mutation (§28).
 *
 * Data hooks (profile query for the friendship-appropriate action, the moderation
 * mutations) live in this component, which Radix mounts lazily with the menu, so a
 * voice roster full of rows fires nothing until a row is actually right-clicked
 * (CLAUDE.md §27, same pattern as ProfileCardBody / MemberRoleContextMenu).
 */

import { useState } from "react";
import {
  Ban,
  Check,
  Link as LinkIcon,
  Loader2,
  MessageSquare,
  PhoneOff,
  UserMinus,
  UserPlus,
  X,
} from "lucide-react";
import { ContextMenuItem, ContextMenuLabel, ContextMenuSeparator } from "@demli/ui";
import type { ChannelId, GroupId, UserId } from "@demli/types";
import { localizeError } from "../lib/errors";
import { useAppTranslation } from "../lib/i18n";
import {
  visibleParticipantActions,
  type ParticipantMenuContext,
} from "../lib/participant-actions";
import {
  useAcceptFriendRequest,
  useOpenDm,
  useProfile,
  useRemoveFriendRequest,
  useSendFriendRequest,
} from "../queries/social-queries";
import { useBanMember, useDisconnectFromVoice, useKickMember } from "../queries/chat-queries";
import { useUiStore } from "../stores/ui-store";

export interface ParticipantActionItemsProps {
  userId: UserId;
  /** The server that owns the voice channel — kick/ban + profile role context. */
  groupId: GroupId | null;
  /** The voice channel the target is in — force-disconnect target. */
  channelId: ChannelId | null;
  /** The target is the signed-in user (no self-actions). */
  isSelf: boolean;
  /** The target owns this server (never moderatable). */
  isTargetOwner: boolean;
  /** Viewer is owner ∨ KICK_MEMBERS on this server. */
  canModerate: boolean;
  /** Target is currently in a voice channel (disconnect applies). */
  inVoice: boolean;
}

/**
 * Renders the participant action items. Returns `null` when nothing applies (e.g.
 * the local user), so callers can drop it into a menu unconditionally.
 */
export function ParticipantActionItems({
  userId,
  groupId,
  channelId,
  isSelf,
  isTargetOwner,
  canModerate,
  inVoice,
}: ParticipantActionItemsProps): JSX.Element | null {
  const { t } = useAppTranslation();
  const setInviteDialogOpen = useUiStore((s) => s.setInviteDialogOpen);

  // Friendship drives the single social action, mirroring the ProfileCard button.
  // Only fires while the menu is open (this component is mounted lazily by Radix).
  const { data: profile } = useProfile(userId, groupId ?? undefined, true);
  const friendship = profile?.friendship ?? "unknown";

  const ctx: ParticipantMenuContext = {
    isSelf,
    isOwner: isTargetOwner,
    canModerate,
    inVoice,
    friendship,
  };
  const actions = new Set(visibleParticipantActions(ctx));

  const openDm = useOpenDm();
  const sendRequest = useSendFriendRequest();
  const acceptRequest = useAcceptFriendRequest();
  const removeRequest = useRemoveFriendRequest();
  const kick = useKickMember(groupId);
  const ban = useBanMember(groupId);
  const disconnect = useDisconnectFromVoice(channelId);

  // Destructive actions ask for a second click before firing (misclick guard,
  // §26/§35). `null` = idle; the item transforms into its "Confirm …" variant.
  const [confirm, setConfirm] = useState<"kick" | "ban" | null>(null);

  const actionError =
    openDm.error ??
    sendRequest.error ??
    acceptRequest.error ??
    removeRequest.error ??
    kick.error ??
    ban.error ??
    disconnect.error ??
    null;

  const showModeration = actions.has("kick") || actions.has("ban") || actions.has("disconnect");

  if (actions.size === 0) return null;

  return (
    <>
      {/* --- Social + invite --- */}
      {actions.has("message") && (
        <ContextMenuItem
          disabled={openDm.isPending}
          onSelect={() => void openDm.mutate(userId)}
        >
          {openDm.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <MessageSquare className="size-3.5" />
          )}
          {t("desktop:voice.participantMenu.message")}
        </ContextMenuItem>
      )}
      {actions.has("addFriend") && (
        <ContextMenuItem
          disabled={sendRequest.isPending}
          onSelect={() => void sendRequest.mutate({ userId })}
        >
          {sendRequest.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <UserPlus className="size-3.5" />
          )}
          {t("desktop:voice.participantMenu.addFriend")}
        </ContextMenuItem>
      )}
      {actions.has("cancelRequest") && (
        <ContextMenuItem
          disabled={removeRequest.isPending}
          onSelect={() => void removeRequest.mutate(userId)}
        >
          {removeRequest.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <X className="size-3.5" />
          )}
          {t("desktop:voice.participantMenu.cancelRequest")}
        </ContextMenuItem>
      )}
      {actions.has("acceptRequest") && (
        <ContextMenuItem
          disabled={acceptRequest.isPending}
          onSelect={() => void acceptRequest.mutate(userId)}
        >
          {acceptRequest.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Check className="size-3.5" />
          )}
          {t("desktop:voice.participantMenu.acceptRequest")}
        </ContextMenuItem>
      )}
      {actions.has("invite") && (
        <ContextMenuItem onSelect={() => setInviteDialogOpen(true)}>
          <LinkIcon className="size-3.5" />
          {t("desktop:voice.participantMenu.invite")}
        </ContextMenuItem>
      )}

      {/* --- Moderation (authorized viewers only) --- */}
      {showModeration && (
        <>
          <ContextMenuSeparator />
          <ContextMenuLabel>{t("desktop:voice.participantMenu.moderation")}</ContextMenuLabel>
          {actions.has("disconnect") && (
            <ContextMenuItem
              danger
              disabled={disconnect.isPending}
              // Keep the menu open while it runs so a failure can show inline; on
              // success the gateway removes the row (the menu unmounts with it).
              onSelect={(e) => {
                e.preventDefault();
                disconnect.mutate(userId);
              }}
            >
              {disconnect.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <PhoneOff className="size-3.5" />
              )}
              {t("desktop:voice.participantMenu.disconnect")}
            </ContextMenuItem>
          )}
          {actions.has("kick") && (
            <ContextMenuItem
              danger
              disabled={kick.isPending}
              onSelect={(e) => {
                e.preventDefault();
                if (confirm !== "kick") {
                  setConfirm("kick");
                  return;
                }
                kick.mutate(userId);
              }}
            >
              {kick.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <UserMinus className="size-3.5" />
              )}
              {confirm === "kick"
                ? t("desktop:voice.participantMenu.kickConfirm")
                : t("desktop:voice.participantMenu.kick")}
            </ContextMenuItem>
          )}
          {actions.has("ban") && (
            <ContextMenuItem
              danger
              disabled={ban.isPending}
              onSelect={(e) => {
                e.preventDefault();
                if (confirm !== "ban") {
                  setConfirm("ban");
                  return;
                }
                ban.mutate({ userId });
              }}
            >
              {ban.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Ban className="size-3.5" />
              )}
              {confirm === "ban"
                ? t("desktop:voice.participantMenu.banConfirm")
                : t("desktop:voice.participantMenu.ban")}
            </ContextMenuItem>
          )}
        </>
      )}

      {actionError && (
        <p role="alert" className="px-2 py-1 text-2xs text-danger">
          {localizeError(actionError, t)}
        </p>
      )}
    </>
  );
}
