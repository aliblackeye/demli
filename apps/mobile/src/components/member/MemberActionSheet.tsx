/**
 * The USER ACTION SHEET — mobile's answer to the desktop right-click menu on a
 * person (member roster row, message author, DM row, profile screen).
 *
 * WHICH entries appear is NOT decided here. Every visibility rule comes from
 * `memberMenuGroups()` in `@demli/client-core` — the same framework-free
 * module the desktop menu reads — so the two platforms cannot drift on who may
 * kick whom, and §35's "never offer what the server would refuse" is one
 * decision instead of two. This file owns only the mobile PRESENTATION: a
 * long-press bottom sheet, native confirm dialogs, and the sub-sheets that
 * collect a note / nickname / timeout duration.
 *
 * Everything privileged is re-checked server-side (§28); hiding a row is a UX
 * promise, never a security boundary.
 *
 * Data hooks live in {@link MemberMenuBody}, which is mounted only while a
 * target is set — a roster of fifty rows fires zero requests until one of them
 * is long-pressed (§27).
 */

import { useState, type ReactNode } from "react";
import { Alert, View } from "react-native";
import { router } from "expo-router";
import * as Clipboard from "expo-clipboard";
import {
  AtSign,
  Ban,
  BellOff,
  Clock,
  Copy,
  Gavel,
  IdCard,
  LogOut,
  MessageSquare,
  PhoneCall,
  PhoneOff,
  ShieldBan,
  ShieldOff,
  Tag,
  UserMinus,
  UserPen,
  UserPlus,
  UserRoundCheck,
  UserRoundX,
} from "lucide-react-native";
import {
  isDestructiveMemberMenuItem,
  memberMenuEntryVariant,
  memberMenuGroups,
  realNameBehindNickname,
  resolveUserName,
  TIMEOUT_PRESET_MINUTES,
  type MemberMenuContext,
  type MemberMenuItem,
} from "@demli/client-core";
import {
  MEMBER_NICKNAME_MAX_LENGTH,
  USER_NICKNAME_MAX_LENGTH,
  USER_NOTE_MAX_LENGTH,
} from "@demli/config";
import { PERMISSIONS, type ChannelId, type DmId, type GroupId, type UserId } from "@demli/types";
import { useAppTranslation, type AppTFunction } from "@/lib/i18n";
import { localizeError } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { requestMentionInsert } from "@/lib/mention-insert";
import { ActionDivider, ActionRow, ActionSheet } from "@/components/ui/ActionSheet";
import { Text } from "@/components/ui/Text";
import { useGroupDetails, useServerPermissions } from "@/queries/chat-queries";
import {
  useAcceptFriendRequest,
  useOpenDm,
  useProfile,
  useRemoveFriendRequest,
  useSendFriendRequest,
  useUnfriend,
} from "@/queries/social-queries";
import {
  useBanMember,
  useBlockUser,
  useDisconnectFromVoice,
  useIgnores,
  useIgnoreUser,
  useKickMember,
  usePrivateNicknames,
  useRemoveMemberTimeout,
  useSetMemberNickname,
  useSetPrivateNickname,
  useSetUserNote,
  useTimeoutMember,
  useUnblockUser,
  useUnignoreUser,
  useUserNote,
} from "@/queries/member-queries";
import { getCallController } from "@/stores/call-store";
import { useAuthStore } from "@/stores/auth-store";
import { useChatStore } from "@/stores/chat-store";
import { useVoiceOccupancyStore } from "@/stores/voice-occupancy-store";
import { colors, radius, space, typography } from "@/theme/theme";
import { MemberTextForm } from "./MemberTextSheet";

/**
 * Everything the sheet needs about its target that the CALLER already knows.
 * Minimal on purpose: a roster row passes a member, a message row passes an
 * author id, and the profile screen passes what it fetched — none of them
 * should have to assemble a permission context.
 */
export interface MemberSheetTarget {
  userId: UserId;
  /**
   * The user's own display name — NOT nickname-resolved; the sheet applies both
   * nickname layers itself. Optional: a surface holding only an id omits it and
   * the sheet reads the in-memory user directory instead.
   */
  displayName?: string;
  /** `@handle`, used as a fallback when there is no display name. */
  username?: string | null;
  /** The target owns this server (the roster knows it; other surfaces may not). */
  isOwner?: boolean;
  /** Guests hold no roles (ADR 0007) — the roles screen explains rather than offers. */
  isGuest?: boolean;
}

/** Which sub-editor is on top of the menu. `"menu"` is the sheet itself. */
type Mode = "menu" | "note" | "friendNickname" | "serverNickname" | "timeout";

export function MemberActionSheet({
  target,
  groupId,
  channelId = null,
  insideProfile = false,
  footer,
  onClose,
}: {
  /** The person this menu acts on; `null` keeps everything closed and unmounted. */
  target: MemberSheetTarget | null;
  /**
   * The server this menu is opened inside, or null on a surface with no server
   * context (DM row, friends list, flat group chat). Null drops every
   * server-scoped entry — roles, invite, server nickname, and all moderation.
   */
  groupId: GroupId | null;
  /**
   * The open text channel, if any — "Mention" needs a composer to type into.
   * `null` on a roster opened away from a thread.
   */
  channelId?: ChannelId | null;
  /**
   * This sheet IS the profile screen's own ⋯ button. Drops the "Profile" entry,
   * which would otherwise re-open a screen that is already open (§35).
   */
  insideProfile?: boolean;
  /**
   * Rows that belong to the SURFACE rather than to the person — "hide this
   * conversation" on a DM row is the case this exists for. Rendered in their own
   * group under the user entries so the shared rules module stays the only
   * authority on what may be done to a USER, and a surface cannot smuggle a
   * privileged action in beside them.
   */
  footer?: ReactNode;
  onClose: () => void;
}) {
  if (!target) return null;
  return (
    <MemberMenuBody
      // Remount on target change so no sub-editor stays open over a new person.
      key={target.userId}
      target={target}
      groupId={groupId}
      channelId={channelId}
      canOpenProfile={!insideProfile}
      footer={footer}
      onClose={onClose}
    />
  );
}

function MemberMenuBody({
  target,
  groupId,
  channelId,
  canOpenProfile,
  footer,
  onClose,
}: {
  target: MemberSheetTarget;
  groupId: GroupId | null;
  channelId: ChannelId | null;
  canOpenProfile: boolean;
  footer?: ReactNode;
  onClose: () => void;
}) {
  const { t } = useAppTranslation();
  const [mode, setMode] = useState<Mode>("menu");

  const meId = useAuthStore((s) => s.user?.id);
  const isSelf = meId === target.userId;

  const { isOwner: viewerIsOwner, can } = useServerPermissions(groupId);
  const { data: details } = useGroupDetails(groupId);
  const { data: profile } = useProfile(target.userId, groupId ?? undefined, !isSelf);
  const { data: privateNicknames } = usePrivateNicknames();
  const { data: ignores } = useIgnores(!isSelf);
  // EXISTENCE, then content. The row has to say "Add note" or "Edit note", which
  // needs a boolean — so the read is enabled as soon as the sheet is open, and
  // the same cached entry prefills the editor when it opens. Still never for
  // your OWN menu (you cannot note yourself, the entry is not offered), and the
  // body is never rendered in a menu row (ADR 0019 §1). The sheet body mounts
  // only after a long press, so a roster of fifty rows still fires nothing (§27).
  const noteQuery = useUserNote(target.userId, !isSelf);

  const sendFriendRequest = useSendFriendRequest();
  const acceptFriendRequest = useAcceptFriendRequest();
  const removeFriendRequest = useRemoveFriendRequest();
  const unfriend = useUnfriend();
  const openDm = useOpenDm();
  const ignoreUser = useIgnoreUser();
  const unignoreUser = useUnignoreUser();
  const blockUser = useBlockUser();
  const unblockUser = useUnblockUser();
  const setNote = useSetUserNote(target.userId);
  const setPrivateNickname = useSetPrivateNickname(target.userId);
  const setMemberNickname = useSetMemberNickname(groupId);
  const timeoutMember = useTimeoutMember(groupId);
  const removeTimeout = useRemoveMemberTimeout(groupId);
  const kickMember = useKickMember(groupId);
  const banMember = useBanMember(groupId);

  // The membership row carries the SERVER nickname and the timeout instant —
  // read off the roster query the screen already holds, no extra request.
  const membership = details?.members.find((m) => m.userId === target.userId);
  const serverNickname = membership?.nickname ?? null;
  const timedOutUntil = membership?.timedOutUntil ?? null;
  const targetTimedOut = timedOutUntil !== null && Date.parse(timedOutUntil) > Date.now();

  // Fall back to the in-memory user directory when the caller had only an id
  // (message rows). One-user slice → an unrelated directory update never
  // re-renders an open sheet (§27).
  const directoryUser = useChatStore((s) => s.users[target.userId]);
  const nameParts = {
    privateNickname: privateNicknames?.[target.userId] ?? null,
    serverNickname,
    displayName: target.displayName ?? directoryUser?.displayName,
    username: target.username ?? directoryUser?.username,
    fallback: target.userId,
  };
  // The ONE name resolution (ADR 0019 §2): private nickname → server nickname →
  // displayName. Every label, dialog title and mention token below uses it.
  const name = resolveUserName(nameParts);
  const realName = realNameBehindNickname(nameParts) ?? name;

  // Is the target sitting in a voice channel right now? A single derived value,
  // not a subscription to the whole occupancy map, so a join anywhere in the
  // server never re-renders an open sheet (§27).
  const voiceChannelId = useVoiceOccupancyStore((s) => {
    for (const [id, occupants] of Object.entries(s.byChannel)) {
      if (occupants.some((o) => o.userId === target.userId)) return id as ChannelId;
    }
    return null;
  });
  const disconnectFromVoice = useDisconnectFromVoice(voiceChannelId);

  const ctx: MemberMenuContext = {
    isSelf,
    inServer: groupId !== null,
    targetIsOwner: target.isOwner === true,
    viewerIsOwner,
    canManageRoles: viewerIsOwner || can(PERMISSIONS.MANAGE_ROLES),
    canManageNicknames: viewerIsOwner || can(PERMISSIONS.MANAGE_NICKNAMES),
    canModerate: viewerIsOwner || can(PERMISSIONS.KICK_MEMBERS),
    // Every member may share a join link; the API re-checks the group's policy.
    canInvite: true,
    targetInVoice: voiceChannelId !== null,
    targetTimedOut,
    hasTextChannel: channelId !== null,
    canOpenProfile,
    friendship: isSelf ? "unknown" : (profile?.friendship ?? "unknown"),
    blocked: profile?.blocked === true,
    ignored: (ignores ?? []).some((entry) => entry.user.id === target.userId),
  };

  const groups = memberMenuGroups(ctx);

  // "Add" vs "Edit" for the three entries that are ONE action in two states.
  // The DECISION comes from the shared rule desktop reads too (client-core), so
  // the two platforms cannot disagree about when a row starts saying "Edit";
  // only the i18n keys below are ours.
  const privateNickname = privateNicknames?.[target.userId] ?? null;
  const editable = {
    hasNote: Boolean(noteQuery.data?.body),
    hasFriendNickname: privateNickname !== null,
    hasServerNickname: (serverNickname ?? "").length > 0,
  };
  const variantOf = (item: Parameters<typeof memberMenuEntryVariant>[0]): "add" | "edit" =>
    memberMenuEntryVariant(item, editable);

  const fail = (err: unknown): void => {
    Alert.alert(t("mobile:userMenu.actionFailed"), localizeError(err, t));
  };

  /** Run an action and dismiss the sheet — the common case for a menu row. */
  const run = (action: () => void): void => {
    onClose();
    action();
  };

  /**
   * A destructive action, gated behind the OS confirm dialog. The name is always
   * in the title, because on a phone the row you long-pressed is hidden behind
   * the sheet by the time the dialog appears — "Kick?" alone would be a coin
   * flip about who.
   */
  const confirmDestructive = (
    title: string,
    body: string,
    confirmLabel: string,
    action: () => void,
  ): void => {
    haptics.medium();
    Alert.alert(title, body, [
      { text: t("common:buttons.cancel"), style: "cancel" },
      {
        text: confirmLabel,
        style: "destructive",
        onPress: () => {
          onClose();
          action();
        },
      },
    ]);
  };

  const openDmThen = (after: (dmId: DmId, participantName: string) => void): void => {
    openDm.mutate(target.userId, {
      onSuccess: ({ dm }) => after(dm.id as DmId, dm.participant.displayName),
      onError: fail,
    });
  };

  const renderItem = (item: MemberMenuItem) => {
    /**
     * Danger tone comes from the SHARED predicate, not from a per-row hardcoded
     * colour, so an entry added to the destructive set in `client-core` turns red
     * on both platforms at once. Two rows opt back out: "unblock" and "remove
     * timeout" are the UNDOING of a destructive action, and painting them red
     * reads as "this will hurt them" when it does the opposite.
     */
    const undoing = (item === "block" && ctx.blocked) || (item === "timeout" && targetTimedOut);
    const danger = isDestructiveMemberMenuItem(item) && !undoing;
    const rowColor = danger ? colors.danger : colors.fgMuted;

    switch (item) {
      case "profile":
        return (
          <ActionRow
            key={item}
            icon={<IdCard size={20} color={colors.fgMuted} />}
            label={t("mobile:userMenu.profile")}
            onPress={() =>
              run(() =>
                router.push({
                  pathname: "/user/[userId]",
                  params: groupId
                    ? { userId: target.userId, name, groupId }
                    : { userId: target.userId, name },
                }),
              )
            }
          />
        );

      case "mention":
        return (
          <ActionRow
            key={item}
            icon={<AtSign size={20} color={colors.fgMuted} />}
            label={t("mobile:userMenu.mention")}
            onPress={() => run(() => requestMentionInsert({ userId: target.userId, label: name }))}
          />
        );

      case "message":
        return (
          <ActionRow
            key={item}
            icon={<MessageSquare size={20} color={colors.fgMuted} />}
            label={t("mobile:userMenu.message")}
            onPress={() =>
              run(() =>
                openDmThen((dmId, participantName) =>
                  router.push({
                    pathname: "/dm/[dmId]",
                    params: { dmId, name: participantName, userId: target.userId },
                  }),
                ),
              )
            }
          />
        );

      case "call":
        return (
          <ActionRow
            key={item}
            icon={<PhoneCall size={20} color={colors.fgMuted} />}
            label={t("mobile:userMenu.call")}
            onPress={() =>
              run(() =>
                // Same path the profile screen's call button takes (ADR 0012):
                // open/seed the DM, hand the fresh id to the shared controller,
                // then route to the call surface. One call flow on mobile.
                openDmThen((dmId) => {
                  void getCallController()
                    .startCall({ dmId, media: "audio" })
                    .catch(() => {
                      // The controller lands on a friendly terminal + logs why.
                    });
                  router.push({ pathname: "/call", params: { name } });
                }),
              )
            }
          />
        );

      case "note":
        return (
          <ActionRow
            key={item}
            icon={<UserPen size={20} color={colors.fgMuted} />}
            label={
              variantOf("note") === "edit"
                ? t("mobile:userMenu.noteEdit")
                : t("mobile:userMenu.note")
            }
            hint={t("mobile:userMenu.onlyVisibleToYou")}
            onPress={() => setMode("note")}
          />
        );

      case "friendNickname":
        return (
          <ActionRow
            key={item}
            icon={<Tag size={20} color={colors.fgMuted} />}
            label={
              variantOf("friendNickname") === "edit"
                ? t("mobile:userMenu.friendNicknameEdit")
                : t("mobile:userMenu.friendNickname")
            }
            hint={t("mobile:userMenu.onlyVisibleToYou")}
            onPress={() => setMode("friendNickname")}
          />
        );

      case "editServerProfile":
      case "serverNickname":
        return (
          <ActionRow
            key={item}
            icon={<UserPen size={20} color={colors.fgMuted} />}
            label={
              item === "editServerProfile"
                ? t("mobile:userMenu.editServerProfile")
                : variantOf("serverNickname") === "edit"
                  ? t("mobile:userMenu.serverNicknameEdit")
                  : t("mobile:userMenu.serverNickname")
            }
            onPress={() => setMode("serverNickname")}
          />
        );

      case "invite":
        return (
          <ActionRow
            key={item}
            icon={<UserPlus size={20} color={colors.fgMuted} />}
            label={t("mobile:userMenu.invite")}
            onPress={() =>
              run(() => {
                if (groupId) router.push({ pathname: "/invite", params: { groupId } });
              })
            }
          />
        );

      case "addFriend":
        return (
          <ActionRow
            key={item}
            icon={<UserPlus size={20} color={colors.fgMuted} />}
            label={t("mobile:userMenu.addFriend")}
            onPress={() =>
              run(() => sendFriendRequest.mutate({ userId: target.userId }, { onError: fail }))
            }
          />
        );

      case "cancelFriendRequest":
        return (
          <ActionRow
            key={item}
            icon={<UserRoundX size={20} color={colors.fgMuted} />}
            label={t("mobile:userMenu.cancelFriendRequest")}
            onPress={() =>
              run(() => removeFriendRequest.mutate(target.userId, { onError: fail }))
            }
          />
        );

      case "acceptFriendRequest":
        return (
          <ActionRow
            key={item}
            icon={<UserRoundCheck size={20} color={colors.fgMuted} />}
            label={t("mobile:userMenu.acceptFriendRequest")}
            onPress={() => run(() => acceptFriendRequest.mutate(target.userId, { onError: fail }))}
          />
        );

      case "removeFriend":
        return (
          <ActionRow
            key={item}
            icon={<UserMinus size={20} color={colors.fgMuted} />}
            label={t("mobile:userMenu.removeFriend")}
            onPress={() =>
              confirmDestructive(
                t("mobile:userMenu.unfriendTitle", { name }),
                t("mobile:userMenu.unfriendDescription"),
                t("mobile:userMenu.unfriendConfirm"),
                () => unfriend.mutate(target.userId, { onError: fail }),
              )
            }
          />
        );

      case "ignore":
        return (
          <ActionRow
            key={item}
            icon={<BellOff size={20} color={colors.fgMuted} />}
            label={ctx.ignored ? t("mobile:userMenu.unignore") : t("mobile:userMenu.ignore")}
            // An ignore is NOT a block (ADR 0019 §4) and the difference has to be
            // legible at the point of choosing, or people reach for the wrong one.
            hint={t("mobile:userMenu.ignoreHint")}
            onPress={() =>
              run(() =>
                ctx.ignored
                  ? unignoreUser.mutate(target.userId, { onError: fail })
                  : ignoreUser.mutate(target.userId, { onError: fail }),
              )
            }
          />
        );

      case "block":
        return (
          <ActionRow
            key={item}
            icon={
              ctx.blocked ? (
                <ShieldOff size={20} color={rowColor} />
              ) : (
                <ShieldBan size={20} color={rowColor} />
              )
            }
            label={ctx.blocked ? t("mobile:block.unblock") : t("mobile:block.block")}
            labelColor={danger ? colors.danger : undefined}
            onPress={() =>
              ctx.blocked
                ? confirmDestructive(
                    t("mobile:block.unblockConfirmTitle", { name }),
                    t("mobile:block.unblockConfirmBody"),
                    t("mobile:block.unblockConfirmAction"),
                    () => unblockUser.mutate(target.userId, { onError: fail }),
                  )
                : confirmDestructive(
                    t("mobile:block.confirmTitle", { name }),
                    `${t("mobile:block.confirmBody")}\n\n${t("mobile:block.confirmNote")}`,
                    t("mobile:block.confirmAction"),
                    () => blockUser.mutate(target.userId, { onError: fail }),
                  )
            }
          />
        );

      case "roles":
        return (
          <ActionRow
            key={item}
            icon={<Gavel size={20} color={colors.fgMuted} />}
            label={t("mobile:memberRoles.title")}
            onPress={() =>
              run(() => {
                if (groupId) {
                  router.push({
                    pathname: "/member-roles",
                    params: { groupId, userId: target.userId },
                  });
                }
              })
            }
          />
        );

      case "voiceDisconnect":
        return (
          <ActionRow
            key={item}
            icon={<PhoneOff size={20} color={rowColor} />}
            label={t("mobile:userMenu.voiceDisconnect", { name })}
            labelColor={danger ? colors.danger : undefined}
            onPress={() =>
              confirmDestructive(
                t("mobile:userMenu.voiceDisconnectTitle", { name }),
                t("mobile:userMenu.voiceDisconnectDescription"),
                t("mobile:userMenu.voiceDisconnectConfirm"),
                () => disconnectFromVoice.mutate(target.userId, { onError: fail }),
              )
            }
          />
        );

      case "timeout":
        // Already muted → one row that LIFTS it. Offering durations while a
        // timeout is running would hide the only action they actually want.
        return targetTimedOut ? (
          <ActionRow
            key={item}
            icon={<Clock size={20} color={rowColor} />}
            label={t("mobile:userMenu.timeoutRemove")}
            onPress={() => run(() => removeTimeout.mutate(target.userId, { onError: fail }))}
          />
        ) : (
          <ActionRow
            key={item}
            icon={<Clock size={20} color={rowColor} />}
            label={t("mobile:userMenu.timeout", { name })}
            labelColor={danger ? colors.danger : undefined}
            onPress={() => setMode("timeout")}
          />
        );

      case "kick":
        return (
          <ActionRow
            key={item}
            icon={<LogOut size={20} color={rowColor} />}
            label={t("mobile:userMenu.kick", { name })}
            labelColor={danger ? colors.danger : undefined}
            onPress={() =>
              confirmDestructive(
                t("mobile:userMenu.kickTitle", { name }),
                t("mobile:userMenu.kickDescription"),
                t("mobile:userMenu.kickConfirm"),
                () => kickMember.mutate(target.userId, { onError: fail }),
              )
            }
          />
        );

      case "ban":
        return (
          <ActionRow
            key={item}
            icon={<Ban size={20} color={rowColor} />}
            label={t("mobile:userMenu.ban", { name })}
            labelColor={danger ? colors.danger : undefined}
            onPress={() =>
              confirmDestructive(
                t("mobile:userMenu.banTitle", { name }),
                t("mobile:userMenu.banDescription"),
                t("mobile:userMenu.banConfirm"),
                () => banMember.mutate({ userId: target.userId }, { onError: fail }),
              )
            }
          />
        );

      case "copyUserId": {
        /**
         * Copies the USERNAME, not the internal id (founder: "kullanıcı idsini
         * kopyalayınca database id değil, username'ini vermeliydi — id'den
         * kastım oydu").
         *
         * The row used to put the storage uuid on the clipboard, which is
         * useless to a person: you cannot type it into "add friend", search for
         * it, or send it to someone as "this is me". The handle is the identity
         * users actually exchange, so that is what the row hands over. Bare, no
         * leading `@` — that is the form every input in the app accepts.
         *
         * Not rendered at all while the handle is unknown (a message row whose
         * author has not landed in the user directory yet). A copy row that
         * quietly copies something else is exactly the failure being fixed here,
         * so it is better to offer nothing for that beat (§35).
         */
        const handle = nameParts.username ?? null;
        if (!handle) return null;
        return (
          <ActionRow
            key={item}
            icon={<Copy size={20} color={colors.fgMuted} />}
            label={t("mobile:userMenu.copyUsername")}
            trailing={<IdChip label={`@${handle}`} />}
            onPress={() =>
              run(() => {
                void Clipboard.setStringAsync(handle);
              })
            }
          />
        );
      }

      default:
        return null;
    }
  };

  /**
   * ONE sheet whose CONTENT swaps, never two Modals trading places.
   *
   * The first version rendered the menu and each sub-editor as sibling `Modal`s
   * and flipped their `visible` props in the same commit. On Android the
   * incoming Modal is attached but never presented when the outgoing one is
   * being dismissed in that frame: the note editor opened the keyboard over an
   * invisible card (caught on the emulator, not in review). Switching content
   * inside a single Modal has no such race — and it reads better, because the
   * menu morphs into the editor in place instead of blinking.
   */
  const body = (() => {
    switch (mode) {
      case "timeout":
        // A preset ladder, not a form: a moderator wants "mute them for ten
        // minutes", not a number field.
        return TIMEOUT_PRESET_MINUTES.map((minutes) => (
          <ActionRow
            key={minutes}
            icon={<Clock size={20} color={colors.fgMuted} />}
            label={formatTimeoutDuration(minutes, t)}
            onPress={() => {
              setMode("menu");
              onClose();
              timeoutMember.mutate({ userId: target.userId, minutes }, { onError: fail });
            }}
          />
        ));

      case "note":
        return (
          <MemberTextForm
            title={
              editable.hasNote
                ? t("mobile:userMenu.noteEditTitle", { name })
                : t("mobile:userMenu.noteTitle", { name })
            }
            description={t("mobile:userMenu.noteDescription")}
            privacy={t("mobile:userMenu.notePrivacy")}
            placeholder={t("mobile:userMenu.notePlaceholder")}
            maxLength={USER_NOTE_MAX_LENGTH}
            initialValue={noteQuery.data?.body ?? null}
            loading={noteQuery.isPending}
            // Founder: "takma adı ekleyince silme yok, notta da aynı şekilde".
            // Emptying the box and saving already clears it server-side, but
            // nothing on screen said so — the explicit button is the fix.
            clearLabel={t("mobile:userMenu.noteRemove")}
            multiline
            saving={setNote.isPending}
            onSave={(value) =>
              setNote.mutate(value, {
                onSuccess: () => {
                  setMode("menu");
                  onClose();
                },
                onError: fail,
              })
            }
            onCancel={() => setMode("menu")}
          />
        );

      case "friendNickname":
        return (
          <MemberTextForm
            title={
              editable.hasFriendNickname
                ? t("mobile:userMenu.friendNicknameEditTitle", { name: realName })
                : t("mobile:userMenu.friendNicknameTitle", { name: realName })
            }
            description={t("mobile:userMenu.friendNicknameDescription")}
            privacy={t("mobile:userMenu.friendNicknamePrivacy")}
            placeholder={realName}
            maxLength={USER_NICKNAME_MAX_LENGTH}
            initialValue={privateNickname}
            clearLabel={t("mobile:userMenu.nicknameReset")}
            saving={setPrivateNickname.isPending}
            onSave={(value) =>
              setPrivateNickname.mutate(value, {
                onSuccess: () => {
                  setMode("menu");
                  onClose();
                },
                onError: fail,
              })
            }
            onCancel={() => setMode("menu")}
          />
        );

      case "serverNickname":
        return (
          <MemberTextForm
            title={
              isSelf
                ? t("mobile:userMenu.serverProfileTitle")
                : editable.hasServerNickname
                  ? t("mobile:userMenu.serverNicknameEditTitle", { name: realName })
                  : t("mobile:userMenu.serverNicknameTitle", { name: realName })
            }
            description={
              isSelf
                ? t("mobile:userMenu.serverProfileDescription")
                : t("mobile:userMenu.serverNicknameDescription")
            }
            // The one line that must never be copy-pasted from the private
            // editors: this name is visible to the WHOLE server.
            privacy={t("mobile:userMenu.serverNicknamePrivacy")}
            placeholder={realName}
            maxLength={MEMBER_NICKNAME_MAX_LENGTH}
            initialValue={serverNickname}
            clearLabel={t("mobile:userMenu.nicknameReset")}
            saving={setMemberNickname.isPending}
            onSave={(value) =>
              setMemberNickname.mutate(
                { userId: target.userId, nickname: value },
                {
                  onSuccess: () => {
                    setMode("menu");
                    onClose();
                  },
                  onError: fail,
                },
              )
            }
            onCancel={() => setMode("menu")}
          />
        );

      case "menu":
      default:
        return (
          <>
            {groups.map((group, index) => (
              <View key={group.join("|")}>
                {index > 0 ? <ActionDivider /> : null}
                {group.map(renderItem)}
              </View>
            ))}
            {footer ? (
              <View>
                <ActionDivider />
                {footer}
              </View>
            ) : null}
          </>
        );
    }
  })();

  return (
    <ActionSheet
      visible
      // The editors carry their own heading; only the menu is titled with the
      // person, which is also what tells you WHO the rows below act on.
      title={mode === "menu" ? name : mode === "timeout" ? t("mobile:userMenu.timeout", { name }) : undefined}
      // Tapping the scrim inside an editor steps BACK to the menu rather than
      // discarding everything — a stray tap must not throw away typed text.
      onClose={mode === "menu" ? onClose : () => setMode("menu")}
    >
      {body}
    </ActionSheet>
  );
}

/**
 * The trailing chip on the copy row. It shows the EXACT string the row will put
 * on the clipboard (`@handle`), so there is no gap between what the label
 * promises and what you get — the gap that made the old id-copying row a bug.
 * Clamped to one line so a long handle cannot push the label around.
 */
function IdChip({ label }: { label: string }) {
  return (
    <View
      style={{
        maxWidth: 140,
        paddingHorizontal: space.xs,
        paddingVertical: 2,
        borderRadius: radius.sm,
        backgroundColor: colors.surfaceRaised,
      }}
    >
      <Text
        numberOfLines={1}
        style={{
          color: colors.fgFaint,
          fontSize: typography.size["2xs"],
          fontWeight: "700",
        }}
      >
        {label}
      </Text>
    </View>
  );
}

/** "60 seconds" / "5 minutes" / "1 hour" / "1 day" / "1 week", localized. */
function formatTimeoutDuration(minutes: number, t: AppTFunction): string {
  if (minutes < 60) return t("mobile:userMenu.durationMinutes", { count: minutes });
  if (minutes < 1440) return t("mobile:userMenu.durationHours", { count: minutes / 60 });
  if (minutes < 10080) return t("mobile:userMenu.durationDays", { count: minutes / 1440 });
  return t("mobile:userMenu.durationWeeks", { count: minutes / 10080 });
}
