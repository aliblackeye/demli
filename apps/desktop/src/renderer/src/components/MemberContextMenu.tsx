import { Fragment, useState, type ReactElement, type ReactNode } from "react";
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
} from "lucide-react";
import {
  ContextMenuCheckboxItem,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@demli/ui";
import {
  ActionMenu,
  requestMentionInsert,
  useActionMenuAfterClose,
  useActionMenuTrigger,
} from "@demli/app-ui";
import {
  memberMenuEntryVariant,
  realNameBehindNickname,
  resolveUserName,
} from "@demli/client-core";
import { PERMISSIONS, type ChannelId, type GroupId, type RoleId, type UserId } from "@demli/types";
import { errorKey, type CommonErrorKey } from "../lib/errors";
import { useAppTranslation } from "../lib/i18n";
import {
  memberMenuGroups,
  isDestructiveMemberMenuItem,
  type MemberMenuContext,
  type MemberMenuItem,
} from "../lib/member-menu";
import {
  useDisconnectFromVoice,
  useGroupDetails,
  useRemoveMemberTimeout,
  useRoles,
  useServerPermissions,
  useSetMemberRoles,
} from "../queries/chat-queries";
import {
  useAcceptFriendRequest,
  useIgnoreUser,
  useIgnores,
  useOpenDm,
  usePrivateNicknames,
  useProfile,
  useRemoveFriendRequest,
  useSendFriendRequest,
  useUnignoreUser,
  useUserNote,
} from "../queries/social-queries";
import { useAuthStore } from "../stores/auth-store";
import { useChatStore } from "../stores/chat-store";
import { useUiStore } from "../stores/ui-store";
import { useVoiceOccupancyStore } from "../stores/voice-occupancy-store";

/** A role with no colour of its own gets the neutral meta tone (a token, never a literal). */
const ROLE_DOT_FALLBACK = "var(--color-fg-faint)";

/** Entries that act on someone as a MODERATOR — grouped under a label, at the bottom. */
const MODERATION_ITEMS: ReadonlySet<MemberMenuItem> = new Set([
  "voiceDisconnect",
  "timeout",
  "kick",
  "ban",
]);

/**
 * Everything the menu needs about its target that the CALLER already knows.
 * Kept minimal on purpose: the roster passes a `ShellMember`, a message avatar
 * passes an author id, and the profile card passes what it fetched — none of
 * them should have to assemble a permission context.
 */
export interface MemberMenuTarget {
  userId: UserId;
  /**
   * The user's own display name — NOT nickname-resolved; the menu applies both
   * nickname layers itself. Optional: a surface that does not have it (a message
   * avatar, where only the author id is at hand) omits it and the menu reads the
   * in-memory user directory instead, so no caller has to plumb a name through.
   */
  displayName?: string;
  /** `@handle`, used as a fallback when there is no display name. */
  username?: string | null;
  /** The target owns this server (roster knows it; other surfaces may not). */
  isOwner?: boolean;
  /** Guests hold no roles (ADR 0007) — the role submenu explains instead of offering. */
  isGuest?: boolean;
}

/**
 * The user context menu — ONE component behind every surface that offers user
 * actions: the member roster, a message avatar/name, a DM row, a voice tile and
 * the profile card's ⋯ button. A second implementation anywhere would be a
 * second set of permission rules to keep in sync.
 *
 * Which entries render is decided entirely by the pure `memberMenuGroups()`
 * contract in `lib/member-menu` — including the fact that YOUR OWN menu is a
 * different, much shorter menu (you cannot message, call, friend, block, kick,
 * ban or time yourself out; the API rejects all of them). Nothing here is ever
 * rendered disabled: an action the viewer cannot take simply is not offered
 * (§35).
 *
 * Every data hook lives in the BODY, which Radix mounts lazily — so a roster of
 * fifty rows fires zero requests until you right-click one of them (§27).
 */
export function MemberContextMenu({
  target,
  groupId,
  insideProfileCard = false,
  children,
}: {
  target: MemberMenuTarget;
  /**
   * The server this menu is opened inside, or null on a surface with no server
   * context (DM row, friends list, flat group chat). Null drops every
   * server-scoped entry — roles, invite, server nickname, and all moderation.
   */
  groupId: GroupId | null;
  /**
   * This menu IS the profile card's own ⋯ button. Drops the "Profile" entry,
   * which would otherwise re-open a card that is already open (§35).
   */
  insideProfileCard?: boolean;
  children: ReactElement;
}): JSX.Element {
  const { t } = useAppTranslation();
  return (
    <ActionMenu
      contentClassName="w-60"
      // Long-press on touch + right-click on mouse + the caller's own kebab —
      // the web client is opened from phones, where there is no right-click.
      menu={
        <MemberMenuBody
          target={target}
          groupId={groupId}
          canOpenProfile={!insideProfileCard}
          t={t}
        />
      }
    >
      {children}
    </ActionMenu>
  );
}

function MemberMenuBody({
  target,
  groupId,
  canOpenProfile,
  t,
}: {
  target: MemberMenuTarget;
  groupId: GroupId | null;
  canOpenProfile: boolean;
  t: ReturnType<typeof useAppTranslation>["t"];
}): JSX.Element {
  const triggerRef = useActionMenuTrigger();
  const afterClose = useActionMenuAfterClose();
  const meId = useAuthStore((s) => s.user?.id);
  const isSelf = meId === target.userId;

  const activeChannelId = useChatStore((s) => s.activeChannelId);
  const setBlockDialog = useUiStore((s) => s.setBlockDialog);
  const setMemberDialog = useUiStore((s) => s.setMemberDialog);
  const setInviteDialogOpen = useUiStore((s) => s.setInviteDialogOpen);

  const { isOwner: viewerIsOwner, can } = useServerPermissions(groupId);
  const { data: details } = useGroupDetails(groupId);
  const { data: profile } = useProfile(target.userId, groupId ?? undefined, !isSelf);
  const { data: privateNicknames } = usePrivateNicknames();
  const { data: ignores } = useIgnores();
  // Existence ONLY — the entry needs to say "Add note" or "Edit note", never to
  // show the body (ADR 0019 §1). Fetched here because the menu body is mounted
  // lazily by Radix, so a roster of fifty rows still fires nothing until one of
  // them is right-clicked (§27). Never for your own menu: you cannot note
  // yourself, and the entry is not offered.
  const { data: note } = useUserNote(target.userId, !isSelf);

  const [error, setError] = useState<CommonErrorKey | null>(null);
  const fail = (err: unknown): void => setError(errorKey(err));

  const sendFriendRequest = useSendFriendRequest();
  const acceptFriendRequest = useAcceptFriendRequest();
  const removeFriendRequest = useRemoveFriendRequest();
  const openDm = useOpenDm();
  const ignoreUser = useIgnoreUser();
  const unignoreUser = useUnignoreUser();
  const removeTimeout = useRemoveMemberTimeout(groupId);

  // The membership row carries the SERVER nickname and the timeout instant.
  // Read off the roster query the sidebar already holds — no extra request.
  const membership = details?.members.find((m) => m.userId === target.userId);
  const serverNickname = membership?.nickname ?? null;
  const timedOutUntil = membership?.timedOutUntil ?? null;
  const targetTimedOut = timedOutUntil !== null && Date.parse(timedOutUntil) > Date.now();

  // Fall back to the in-memory user directory when the caller had only an id
  // (message avatars). One-user slice → an unrelated directory update never
  // re-renders an open menu (§27).
  const directoryUser = useChatStore((s) => s.users[target.userId]);
  const privateNickname = privateNicknames?.[target.userId] ?? null;
  const nameParts = {
    privateNickname,
    serverNickname,
    displayName: target.displayName ?? directoryUser?.displayName,
    username: target.username ?? directoryUser?.username,
    fallback: target.userId,
  };
  // The ONE name resolution (ADR 0019 §2): private nickname → server nickname →
  // displayName. Every label, dialog title and mention token below uses it.
  const name = resolveUserName(nameParts);
  const realName = realNameBehindNickname(nameParts) ?? name;

  // Is the target sitting in a voice channel right now? A single derived
  // boolean, not a subscription to the whole occupancy map, so a join anywhere
  // in the server does not re-render an open menu (§27).
  const voiceChannelId = useVoiceOccupancyStore((s) => {
    for (const [channelId, occupants] of Object.entries(s.byChannel)) {
      if (occupants.some((o) => o.userId === target.userId)) return channelId as ChannelId;
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
    hasTextChannel: activeChannelId !== null,
    canOpenProfile,
    friendship: isSelf ? "unknown" : (profile?.friendship ?? "unknown"),
    blocked: profile?.blocked === true,
    ignored: (ignores ?? []).some((entry) => entry.user.id === target.userId),
  };

  const groups = memberMenuGroups(ctx);

  // "Add" vs "Edit" for the three entries that are one action in two states.
  // The DECISION is shared with mobile (client-core); only the i18n keys are ours.
  const editable = {
    hasNote: Boolean(note?.body),
    hasFriendNickname: privateNickname !== null,
    hasServerNickname: (serverNickname ?? "").length > 0,
  };
  const variantOf = (item: Parameters<typeof memberMenuEntryVariant>[0]): "add" | "edit" =>
    memberMenuEntryVariant(item, editable);

  // The handle, not the uuid. A raw uuid is a dead end for the person who
  // copied it, while the username is the string they can search,
  // mention and send to a friend. Mobile settled on the handle first; this keeps
  // the two menus from meaning different things by the same gesture.
  const handle = nameParts.username ?? null;
  const copyUsername = (): void => {
    if (!handle) return;
    void navigator.clipboard?.writeText(handle).catch(() => {
      /* Clipboard denied — nothing to recover, and a toast here would be noise. */
    });
  };

  const renderItem = (item: MemberMenuItem): ReactNode => {
    const danger = isDestructiveMemberMenuItem(item);
    switch (item) {
      case "profile":
        // The same popover the row's own click opens — re-dispatched on the
        // profile trigger inside THIS menu's trigger element.
        //
        // Through `afterClose` because a Radix menu TRAPS focus while it is open
        // and restores it on close: opening the card inline would hand it focus,
        // have the menu snatch it back, and the card — a dismissable layer —
        // would close itself in the same tick. That is the founder's "Profil
        // basınca çalışmadı". The trigger node is captured NOW, while the menu
        // still holds it. See useActionMenuAfterClose.
        return (
          <ContextMenuItem
            key={item}
            onSelect={() => {
              const trigger = triggerRef?.current ?? null;
              afterClose(() => openProfileFrom(trigger));
            }}
          >
            <IdCard className="size-4" />
            {t("desktop:userMenu.profile")}
          </ContextMenuItem>
        );

      case "mention":
        // Deferred past the close for the same reason as "Profile": the composer
        // is focused by the insert, and a menu still trapping focus would pull it
        // straight back — leaving the caret nowhere and the mention half-applied.
        return (
          <ContextMenuItem
            key={item}
            onSelect={() =>
              afterClose(() => requestMentionInsert({ userId: target.userId, label: name }))
            }
          >
            <AtSign className="size-4" />
            {t("desktop:userMenu.mention")}
          </ContextMenuItem>
        );

      case "message":
        return (
          <ContextMenuItem
            key={item}
            onSelect={() => void openDm.mutate(target.userId, { onError: fail })}
          >
            <MessageSquare className="size-4" />
            {t("desktop:userMenu.message")}
          </ContextMenuItem>
        );

      case "call":
        return (
          <ContextMenuItem
            key={item}
            // Calling runs through the DM surface (ADR 0012): open the DM, and
            // the call buttons live there. One path, no duplicate call logic.
            onSelect={() => void openDm.mutate(target.userId, { onError: fail })}
          >
            <PhoneCall className="size-4" />
            {t("desktop:userMenu.call")}
          </ContextMenuItem>
        );

      case "note":
        return (
          <ContextMenuItem
            key={item}
            className="items-start"
            onSelect={() =>
              setMemberDialog({ kind: "note", userId: target.userId, displayName: name })
            }
          >
            <UserPen className="mt-0.5 size-4" />
            <span className="flex min-w-0 flex-col">
              <span>
                {variantOf("note") === "edit"
                  ? t("desktop:userMenu.noteEdit")
                  : t("desktop:userMenu.note")}
              </span>
              {/* Second line: states the privacy rule where the action is
                  taken, not three screens away in a settings page. */}
              <span className="text-2xs font-normal text-fg-faint">
                {t("desktop:userMenu.onlyVisibleToYou")}
              </span>
            </span>
          </ContextMenuItem>
        );

      case "friendNickname":
        return (
          <ContextMenuItem
            key={item}
            className="items-start"
            onSelect={() =>
              setMemberDialog({
                kind: "friendNickname",
                userId: target.userId,
                displayName: name,
                realName,
                current: privateNickname,
              })
            }
          >
            <Tag className="mt-0.5 size-4" />
            <span className="flex min-w-0 flex-col">
              <span>
                {variantOf("friendNickname") === "edit"
                  ? t("desktop:userMenu.friendNicknameEdit")
                  : t("desktop:userMenu.friendNickname")}
              </span>
              <span className="text-2xs font-normal text-fg-faint">
                {t("desktop:userMenu.onlyVisibleToYou")}
              </span>
            </span>
          </ContextMenuItem>
        );

      case "editServerProfile":
      case "serverNickname":
        return (
          <ContextMenuItem
            key={item}
            onSelect={() => {
              if (!groupId) return;
              setMemberDialog({
                kind: "serverNickname",
                userId: target.userId,
                displayName: name,
                realName,
                groupId,
                current: serverNickname,
                isSelf,
              });
            }}
          >
            <UserPen className="size-4" />
            {item === "editServerProfile"
              ? t("desktop:userMenu.editServerProfile")
              : variantOf("serverNickname") === "edit"
                ? t("desktop:userMenu.serverNicknameEdit")
                : t("desktop:userMenu.serverNickname")}
          </ContextMenuItem>
        );

      case "invite":
        return (
          <ContextMenuItem key={item} onSelect={() => setInviteDialogOpen(true)}>
            <UserPlus className="size-4" />
            {t("desktop:userMenu.invite")}
          </ContextMenuItem>
        );

      case "addFriend":
        return (
          <ContextMenuItem
            key={item}
            onSelect={() =>
              void sendFriendRequest.mutate({ userId: target.userId }, { onError: fail })
            }
          >
            <UserPlus className="size-4" />
            {t("desktop:userMenu.addFriend")}
          </ContextMenuItem>
        );

      case "cancelFriendRequest":
        return (
          <ContextMenuItem
            key={item}
            onSelect={() => void removeFriendRequest.mutate(target.userId, { onError: fail })}
          >
            <UserRoundX className="size-4" />
            {t("desktop:userMenu.cancelFriendRequest")}
          </ContextMenuItem>
        );

      case "acceptFriendRequest":
        return (
          <ContextMenuItem
            key={item}
            onSelect={() => void acceptFriendRequest.mutate(target.userId, { onError: fail })}
          >
            <UserRoundCheck className="size-4" />
            {t("desktop:userMenu.acceptFriendRequest")}
          </ContextMenuItem>
        );

      case "removeFriend":
        return (
          <ContextMenuItem
            key={item}
            // Confirmed, via the SAME dialog the profile card's banner icon
            // opens — one flow, so a menu row and a small icon can never behave
            // differently. Undoing needs the other person to accept a fresh
            // request, so it is not a click-and-shrug action.
            onSelect={() =>
              setMemberDialog({ kind: "unfriend", userId: target.userId, displayName: name })
            }
          >
            <UserMinus className="size-4" />
            {t("desktop:userMenu.removeFriend")}
          </ContextMenuItem>
        );

      case "ignore":
        return (
          <ContextMenuItem
            key={item}
            className="items-start"
            onSelect={() =>
              ctx.ignored
                ? void unignoreUser.mutate(target.userId, { onError: fail })
                : void ignoreUser.mutate(target.userId, { onError: fail })
            }
          >
            <BellOff className="mt-0.5 size-4" />
            <span className="flex min-w-0 flex-col">
              <span>
                {ctx.ignored ? t("desktop:userMenu.unignore") : t("desktop:userMenu.ignore")}
              </span>
              {/* An ignore is NOT a block (ADR 0019 §4) and the difference has to
                  be legible at the point of choosing, or people reach for the
                  wrong one. */}
              <span className="text-2xs font-normal text-fg-faint">
                {t("desktop:userMenu.ignoreHint")}
              </span>
            </span>
          </ContextMenuItem>
        );

      case "block":
        return (
          <ContextMenuItem
            key={item}
            danger={!ctx.blocked}
            onSelect={() =>
              setBlockDialog({
                userId: target.userId,
                displayName: name,
                blocked: ctx.blocked,
              })
            }
          >
            {ctx.blocked ? <ShieldOff className="size-4" /> : <ShieldBan className="size-4" />}
            {ctx.blocked ? t("desktop:block.unblock") : t("desktop:block.block")}
          </ContextMenuItem>
        );

      case "roles":
        return <RolesSubmenu key={item} target={target} groupId={groupId} t={t} />;

      case "voiceDisconnect":
        return (
          <ContextMenuItem
            key={item}
            danger
            onSelect={() => void disconnectFromVoice.mutate(target.userId, { onError: fail })}
          >
            <PhoneOff className="size-4" />
            {t("desktop:userMenu.voiceDisconnect")}
          </ContextMenuItem>
        );

      case "timeout":
        // Already timed out → one entry that LIFTS it (not destructive, so no
        // confirmation). Otherwise the entry opens the confirmation, where the
        // duration is chosen with the consequences in view — the same
        // "confirmations own the mutations" rule as kick and ban.
        return targetTimedOut ? (
          <ContextMenuItem
            key={item}
            onSelect={() => void removeTimeout.mutate(target.userId, { onError: fail })}
          >
            <Clock className="size-4" />
            {t("desktop:userMenu.timeoutRemove")}
          </ContextMenuItem>
        ) : (
          <ContextMenuItem
            key={item}
            danger={danger}
            onSelect={() => {
              if (!groupId) return;
              setMemberDialog({ kind: "timeout", userId: target.userId, displayName: name, groupId });
            }}
          >
            <Clock className="size-4" />
            {t("desktop:userMenu.timeout", { name })}
          </ContextMenuItem>
        );

      case "kick":
        return (
          <ContextMenuItem
            key={item}
            danger
            onSelect={() => {
              if (!groupId) return;
              setMemberDialog({ kind: "kick", userId: target.userId, displayName: name, groupId });
            }}
          >
            <LogOut className="size-4" />
            {t("desktop:userMenu.kick", { name })}
          </ContextMenuItem>
        );

      case "ban":
        return (
          <ContextMenuItem
            key={item}
            danger
            onSelect={() => {
              if (!groupId) return;
              setMemberDialog({ kind: "ban", userId: target.userId, displayName: name, groupId });
            }}
          >
            <Ban className="size-4" />
            {t("desktop:userMenu.ban", { name })}
          </ContextMenuItem>
        );

      case "copyUserId":
        // No handle resolved yet ⇒ no row. Copying the uuid as a "fallback" would
        // put something on the clipboard that is not what the label promised.
        if (!handle) return null;
        return (
          <ContextMenuItem key={item} onSelect={copyUsername}>
            <Copy className="size-4" />
            <span className="min-w-0 flex-1">{t("desktop:userMenu.copyUsername")}</span>
            {/* Shows exactly what lands on the clipboard. */}
            <span className="max-w-[45%] shrink-0 truncate rounded-[6px] bg-wash px-1.5 py-px text-badge font-medium text-fg-faint">
              @{handle}
            </span>
          </ContextMenuItem>
        );

      default:
        return null;
    }
  };

  return (
    <>
      {error && (
        <p role="alert" className="px-2 py-1 text-2xs text-danger">
          {t(error)}
        </p>
      )}
      {groups.map((group, index) => (
        <Fragment key={group.join("|")}>
          {index > 0 && <ContextMenuSeparator />}
          {/* The moderation block (disconnect / timeout / kick / ban) is named,
              so the destructive rows read as a deliberate section rather than
              more of the same list. */}
          {group.some((item) => MODERATION_ITEMS.has(item)) && (
            <ContextMenuLabel>{t("desktop:userMenu.dangerZoneLabel")}</ContextMenuLabel>
          )}
          {group.map(renderItem)}
        </Fragment>
      ))}
    </>
  );
}

/**
 * Role assignment (ADR 0007), as a submenu so a server with a dozen roles does
 * not push the destructive entries off the bottom of the screen. Its own data
 * hook so the full role list is fetched only when the submenu opens.
 */
function RolesSubmenu({
  target,
  groupId,
  t,
}: {
  target: MemberMenuTarget;
  groupId: GroupId | null;
  t: ReturnType<typeof useAppTranslation>["t"];
}): JSX.Element {
  const { data: roles } = useRoles(groupId);
  const { data: details } = useGroupDetails(groupId);
  const setMemberRoles = useSetMemberRoles(groupId);
  const [error, setError] = useState<CommonErrorKey | null>(null);

  const membership = details?.members.find((m) => m.userId === target.userId);
  const assigned = new Set<RoleId>((membership?.roleIds ?? []) as RoleId[]);

  const toggleRole = (roleId: RoleId, next: boolean): void => {
    const nextSet = new Set(assigned);
    if (next) nextSet.add(roleId);
    else nextSet.delete(roleId);
    setError(null);
    setMemberRoles.mutate(
      { userId: target.userId, roleIds: [...nextSet] },
      { onError: (err) => setError(errorKey(err)) },
    );
  };

  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <Gavel className="size-4" />
        {t("desktop:members.manageRoles")}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="w-56">
        <ContextMenuLabel>{t("desktop:members.manageRoles")}</ContextMenuLabel>
        {error && (
          <p role="alert" className="px-2 py-1 text-2xs text-danger">
            {t(error)}
          </p>
        )}
        {/* Guests can hold no roles (ADR 0007) — explain rather than offer
            toggles the API would reject. */}
        {target.isGuest ? (
          <p className="px-2 py-1.5 text-2xs text-fg-faint">
            {t("desktop:serverSettings.guestNoRoles")}
          </p>
        ) : (roles ?? []).length === 0 ? (
          <p className="px-2 py-1.5 text-2xs text-fg-faint">
            {t("desktop:serverSettings.noRolesToAssign")}
          </p>
        ) : (
          (roles ?? []).map((role) => {
            const on = assigned.has(role.id);
            return (
              <ContextMenuCheckboxItem
                key={role.id}
                checked={on}
                // A real checkbox row (role="menuitemcheckbox" + aria-checked),
                // kept open per toggle so several roles can be flipped in one
                // pass (preventDefault stops Radix's close-on-select).
                onSelect={(event) => {
                  event.preventDefault();
                  toggleRole(role.id, !on);
                }}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: role.color ?? ROLE_DOT_FALLBACK }}
                  />
                  <span className="min-w-0 truncate">{role.name}</span>
                </span>
              </ContextMenuCheckboxItem>
            );
          })
        )}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

/**
 * Open the profile popover from the menu. The card is a Radix Popover anchored
 * to the row's own avatar/name button, so the honest way to open it is to click
 * that button — and the ONLY unambiguous way to find it is inside the element
 * this menu is attached to (`useActionMenuTrigger`). A document-wide lookup
 * would open the first matching row's card, not the right-clicked one.
 *
 * A no-op when the row has gone away, which is the correct outcome: the menu
 * closes and nothing misleading happens.
 */
function openProfileFrom(trigger: HTMLElement | null): void {
  const node =
    trigger?.matches("[data-profile-trigger]") === true
      ? trigger
      : trigger?.querySelector<HTMLElement>("[data-profile-trigger]");
  node?.click();
}
