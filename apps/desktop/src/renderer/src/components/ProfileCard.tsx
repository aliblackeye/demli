import { cloneElement, isValidElement, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { m } from "framer-motion";
import {
  Check,
  Loader2,
  MoreVertical,
  Pencil,
  SendHorizontal,
  ShieldBan,
  ShieldOff,
  SmilePlus,
  UserMinus,
  UserPlus,
  UserRoundX,
  X,
} from "lucide-react";
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  PresenceBadge,
  Skeleton,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  UserAvatar,
  cn,
} from "@demli/ui";
import { RoleChip, staggerContainer, staggerItem } from "@demli/app-ui";
import { noteBadgeText, realNameBehindNickname, resolveUserName } from "@demli/client-core";
import { MESSAGE_MAX_LENGTH } from "@demli/config";
import type { GroupId, ProfileFriendshipStatus, UserId } from "@demli/types";
import { bannerGradient, userBannerUrl } from "../lib/banner";
import { localizeBlockedError, localizeError } from "../lib/errors";
import { useAppTranslation } from "../lib/i18n";
import { useGroupDetails } from "../queries/chat-queries";
import {
  useAcceptFriendRequest,
  usePrivateNicknames,
  useProfile,
  useRemoveFriendRequest,
  useSendDmMessage,
  useSendFriendRequest,
  useUserNote,
} from "../queries/social-queries";
import { useAuthStore } from "../stores/auth-store";
import { useChatStore } from "../stores/chat-store";
import { useUiStore } from "../stores/ui-store";
import { AvatarLightbox } from "./AvatarLightbox";
import { EmojiPicker } from "./EmojiPicker";
import { MemberContextMenu } from "./MemberContextMenu";

interface ProfileCardProps {
  userId: UserId;
  /** Shared-server context: roles show only when both belong to this server. */
  groupId?: GroupId;
  /** The trigger (avatar / name button); rendered via `asChild`. */
  children: ReactNode;
}

/**
 * One boxed section inside the card's sectioned body (the "About / Roles /
 * Mutual servers" stack). The sections share ONE inset panel with hairline
 * dividers between rows; {@link ProfileCardBody} renders the panel and
 * drops in only the sections that have content.
 */
function ProfileSection({
  heading,
  children,
  aside,
}: {
  heading: string;
  children: ReactNode;
  /** Small trailing note on the heading row, e.g. "only visible to you". */
  aside?: ReactNode;
}): JSX.Element {
  return (
    <div className="px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2 pb-1.5">
        <p className="text-badge font-semibold uppercase tracking-wider text-fg-faint">{heading}</p>
        {aside}
      </div>
      {children}
    </div>
  );
}

/**
 * The popover body — all data hooks live here so they only run while the card is
 * open (Radix mounts `PopoverContent` children lazily). Keeping the mutation /
 * query hooks out of the always-mounted {@link ProfileCard} shell means a chat
 * full of avatars stays cheap (CLAUDE.md §27).
 */
function ProfileCardBody({
  userId,
  groupId,
  onClose,
}: {
  userId: UserId;
  groupId: GroupId | undefined;
  onClose: () => void;
}): JSX.Element {
  const { t, i18n } = useAppTranslation();
  const queryClient = useQueryClient();
  const meId = useAuthStore((s) => s.user?.id);
  const openSettings = useUiStore((s) => s.openSettings);
  // The banner's destructive icons open the SAME confirmations the context menu
  // does — one flow per action, never a second implementation behind an icon.
  const setBlockDialog = useUiStore((s) => s.setBlockDialog);
  const setMemberDialog = useUiStore((s) => s.setMemberDialog);
  // Presence is only known for users the client tracks (member roster, self);
  // an untracked user (a stranger's message avatar) has no entry — show no dot
  // rather than a misleading "offline". One-user slice → no presence-tick storm.
  const presence = useChatStore((s) => s.presence[userId]);
  // One-user slice, same as `presence` above → a status change anywhere else in
  // the roster never re-renders this card (§27).
  const liveCustomStatus = useChatStore((s) => s.customStatuses[userId] ?? null);
  const isSelf = meId === userId;
  const [avatarOpen, setAvatarOpen] = useState(false);

  const { data: profile, isPending, error, refetch } = useProfile(userId, groupId, true);
  const { data: privateNicknames } = usePrivateNicknames();
  const { data: details } = useGroupDetails(groupId ?? null);
  // The viewer's PRIVATE note, fetched only for someone else's card and never
  // rendered anywhere a third party can see it (ADR 0019 §1).
  const { data: note } = useUserNote(userId, !isSelf);

  const sendRequest = useSendFriendRequest();
  const acceptRequest = useAcceptFriendRequest();
  const removeRequest = useRemoveFriendRequest();
  const busy = sendRequest.isPending || acceptRequest.isPending || removeRequest.isPending;

  // "Member since" — formatted in the active language, guarded so a bad/absent
  // timestamp simply drops the row instead of throwing.
  const memberSince = useMemo(() => {
    const raw = profile?.user.createdAt;
    if (!raw) return null;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return null;
    const opts: Intl.DateTimeFormatOptions = { year: "numeric", month: "long", day: "numeric" };
    try {
      return new Intl.DateTimeFormat(i18n.language, opts).format(date);
    } catch {
      return new Intl.DateTimeFormat("en", opts).format(date);
    }
  }, [profile?.user.createdAt, i18n.language]);

  const refreshProfile = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["profile", userId] });
  };

  const onSend = (): void => void sendRequest.mutate({ userId }, { onSuccess: refreshProfile });
  const onAccept = (): void => void acceptRequest.mutate(userId, { onSuccess: refreshProfile });
  const onRemoveRequest = (): void =>
    void removeRequest.mutate(userId, { onSuccess: refreshProfile });

  const friendship: ProfileFriendshipStatus = profile?.friendship ?? "none";
  // A BLOCKED refusal is localized against the action that hit it, so the user is
  // told what failed ("You can't message this user") — never who blocked whom,
  // which the API deliberately does not disclose (§28, ADR 0017).
  const actionErrorMessage = (sendRequest.error ?? acceptRequest.error)
    ? localizeBlockedError(sendRequest.error ?? acceptRequest.error, t, "friendRequest")
    : removeRequest.error
      ? localizeError(removeRequest.error, t)
      : null;

  if (isPending) {
    // Skeleton mirrors the loaded card's shape (banner + overhanging avatar +
    // name/handle + a sectioned panel + the action button) so the layout does
    // not jump when the real data arrives — founder rule: skeletons, not spinners.
    return (
      <div role="status" aria-label={t("desktop:profileCard.loading")}>
        <div className="h-[7.5rem] bg-raised/60" aria-hidden />
        <div className="px-4 pb-4">
          <div className="-mt-11 mb-3">
            <Skeleton shape="circle" width={80} className="ring-[5px] ring-overlay" />
          </div>
          <Skeleton shape="line" height={18} className="w-36" />
          <Skeleton shape="line" height={12} className="mt-2 w-24" />
          <div className="mt-3 space-y-2 rounded-lg border border-stroke bg-raised/60 p-3">
            <Skeleton shape="line" height={10} className="w-16" />
            <Skeleton shape="line" />
            <Skeleton shape="line" className="w-4/5" />
          </div>
          <Skeleton shape="rect" height={36} className="mt-3 w-full" />
        </div>
        <span className="sr-only">{t("desktop:profileCard.loading")}</span>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="flex flex-col items-center gap-2 p-6 text-center">
        <p className="text-xs text-fg-muted">{localizeError(error, t)}</p>
        <button
          type="button"
          onClick={() => void refetch()}
          className="cursor-pointer text-xs font-medium text-accent hover:underline"
        >
          {t("buttons.retry")}
        </button>
      </div>
    );
  }

  // Prefer the LIVE line from the presence stream over the (possibly minutes-old)
  // copy on the fetched profile — the card is often open while a status changes.
  const customStatus = liveCustomStatus ?? profile.user.customStatus ?? null;
  const bannerUrl = userBannerUrl(profile.user);

  // The ONE name resolution (ADR 0019 §2). `realName` is what they call
  // themselves, shown underneath whenever a nickname is overriding it — a
  // renamed person must stay identifiable.
  const serverNickname =
    details?.members.find((member) => member.userId === userId)?.nickname ?? null;
  const nameParts = {
    privateNickname: privateNicknames?.[userId] ?? null,
    serverNickname,
    displayName: profile.user.displayName,
    username: profile.user.username,
    fallback: userId,
  };
  const name = resolveUserName(nameParts);
  const realName = realNameBehindNickname(nameParts);

  const hasBio = Boolean(profile.user.bio);
  const hasRoles = Boolean(profile.roles && profile.roles.length > 0);
  const hasMutual = Boolean(profile.mutualServers && profile.mutualServers.length > 0);
  const hasSections = hasBio || Boolean(memberSince) || hasRoles || hasMutual;

  // The viewer's private note, shortened to sit in parentheses beside the name
  // (founder: "notu isminin yanına parantezle koyalım. kısa bişey olsun uzun
  // değil"). `note` is only ever fetched for SOMEONE ELSE's card — `useUserNote`
  // above is gated on `!isSelf` — and this card is the viewer's own render of
  // it; nothing here travels anywhere (ADR 0019 §1).
  const noteBadge = isSelf ? null : noteBadgeText(note?.body);

  // Own card only (founder): hovering the avatar / banner reveals a pencil that
  // jumps to the unified Account settings panel to add or change either image.
  const goEditProfile = (): void => {
    onClose();
    openSettings("profile");
  };

  /**
   * The relationship controls, pinned to the banner's top-right (founder's
   * reference). Icon-only, but never bare: each carries a tooltip AND an
   * aria-label, and each sits on its own translucent dark backdrop so it stays
   * legible over a light banner photo.
   *
   * Exactly ONE friendship control at a time — "Add friend" and "Remove friend"
   * are the same slot in two states, never both. Both destructive ones
   * (unfriend, block) open the SAME confirmations the context menu uses rather
   * than firing on click: these are small targets and a misclick on "remove
   * friend" costs a request the other person has to accept again.
   *
   * None of them render on your own card — you cannot friend or block yourself,
   * and the API rejects both (§35).
   */
  const relationshipActions = ((): ReactNode => {
    if (isSelf) return null;

    const blockControl = (
      <BannerAction
        label={profile.blocked ? t("desktop:block.unblock") : t("desktop:block.block")}
        tone={profile.blocked ? "default" : "danger"}
        onClick={() =>
          setBlockDialog({ userId, displayName: name, blocked: profile.blocked === true })
        }
      >
        {profile.blocked ? <ShieldOff className="size-4" /> : <ShieldBan className="size-4" />}
      </BannerAction>
    );

    // While a block holds, friending is refused server-side — offering it would
    // be a dead control. Unblocking is the way forward and stays.
    if (profile.blocked) return blockControl;

    const friendControl = ((): ReactNode => {
      switch (friendship) {
        case "friends":
          return (
            <BannerAction
              label={t("desktop:profileCard.removeFriend")}
              tone="danger"
              onClick={() => setMemberDialog({ kind: "unfriend", userId, displayName: name })}
            >
              <UserMinus className="size-4" />
            </BannerAction>
          );
        case "none":
          return (
            <BannerAction
              label={t("desktop:profileCard.addFriend")}
              busy={sendRequest.isPending}
              disabled={busy}
              onClick={onSend}
            >
              <UserPlus className="size-4" />
            </BannerAction>
          );
        case "outgoing":
          return (
            <BannerAction
              label={t("desktop:profileCard.cancelRequest")}
              busy={removeRequest.isPending}
              disabled={busy}
              onClick={onRemoveRequest}
            >
              <UserRoundX className="size-4" />
            </BannerAction>
          );
        case "incoming":
          // Two controls here: declining must not be buried in a menu.
          return (
            <>
              <BannerAction
                label={t("desktop:profileCard.accept")}
                busy={acceptRequest.isPending}
                disabled={busy}
                onClick={onAccept}
              >
                <Check className="size-4" />
              </BannerAction>
              <BannerAction
                label={t("desktop:profileCard.decline")}
                busy={removeRequest.isPending}
                disabled={busy}
                onClick={onRemoveRequest}
              >
                <X className="size-4" />
              </BannerAction>
            </>
          );
        default:
          return null;
      }
    })();

    return (
      <>
        {friendControl}
        {blockControl}
      </>
    );
  })();

  return (
    <div>
      <AvatarLightbox
        open={avatarOpen}
        onOpenChange={setAvatarOpen}
        url={profile.user.avatarUrl}
        name={name}
        colorSeed={profile.user.id}
      />

      {/* Banner — the user's uploaded image (photo/GIF) when present, otherwise a
          warm, per-user diagonal wash. Glass sheen up top + a grounding fade at
          the bottom so the overhanging avatar reads clearly. Top-right carries
          the relationship action and the ⋯ menu (founder's reference); on the
          viewer's OWN card, a pencil to settings instead. */}
      <div className="relative h-[7.5rem] overflow-hidden">
        {bannerUrl ? (
          <img src={bannerUrl} alt="" className="absolute inset-0 size-full object-cover" draggable={false} />
        ) : (
          <div className="absolute inset-0" style={bannerGradient(profile.user.id)} aria-hidden />
        )}
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/10 to-transparent"
        />
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-black/25 to-transparent"
        />
        <div className="absolute right-2 top-2 flex items-center gap-1">
          {relationshipActions}
          {isSelf && (
            <BannerAction label={t("desktop:profileCard.editImages")} onClick={goEditProfile}>
              <Pencil className="size-3.5" />
            </BannerAction>
          )}
          {/* EXACTLY the right-click menu — one component, one set of rules, so
              the ⋯ button can never drift from what right-click offers. */}
          <MemberContextMenu
            target={{
              userId,
              displayName: profile.user.displayName,
              username: profile.user.username,
            }}
            groupId={groupId ?? null}
            insideProfileCard
          >
            <button
              type="button"
              aria-label={t("a11y.moreActions")}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                event.currentTarget.dispatchEvent(
                  new MouseEvent("contextmenu", {
                    bubbles: true,
                    clientX: rect.left,
                    clientY: rect.bottom,
                  }),
                );
              }}
              className="flex size-7 cursor-pointer items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm transition-colors motion-instant hover:bg-black/65 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
            >
              <MoreVertical className="size-3.5" />
            </button>
          </MemberContextMenu>
        </div>
      </div>

      {/* Content settles in as a gentle sequence over the popover's own pop-in
          (app-ui stagger presets; reduced-motion is handled globally). */}
      <m.div
        className="px-4 pb-4"
        variants={staggerContainer}
        initial="initial"
        animate="animate"
      >
        {/* Identity: overhanging avatar (with a presence dot) + name / handle */}
        <m.div variants={staggerItem}>
          <div className="relative -mt-11 mb-3 w-fit">
            {/* Founder: pressing the avatar opens it big, and you can move around
                inside it. Always a button, even without a photo, so the gesture
                is consistent across the roster. */}
            <button
              type="button"
              onClick={() => setAvatarOpen(true)}
              aria-label={t("desktop:profileCard.viewAvatar", { name })}
              className="block cursor-zoom-in rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
            >
              <UserAvatar
                name={profile.user.displayName}
                colorSeed={profile.user.id}
                src={profile.user.avatarUrl}
                size="lg"
                className="ring-[5px] ring-overlay"
              />
            </button>
            {presence && (
              <PresenceBadge
                status={presence}
                className="pointer-events-none absolute bottom-1 right-1 size-4 ring-[3.5px] ring-overlay"
              />
            )}
          </div>
          {/* Name + the viewer's private note in parentheses. The note is a
              quiet, smaller aside so the NAME still reads as the heading, is
              clipped to one short line, and carries the full text plus its
              privacy label in a tooltip — the long-note case must not push the
              card's identity block around. */}
          <div className="flex min-w-0 items-baseline space-x-1.5">
            <p className="min-w-0 truncate text-lg font-bold leading-tight text-fg">{name}</p>
            {noteBadge && (
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* Capped at 45% so the NAME always keeps the majority of the
                      row — the note is an aside, never the headline. */}
                  <span className="max-w-[45%] shrink-0 truncate text-[13px] font-medium text-fg-faint">
                    ({noteBadge})
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-64">
                  <span className="block whitespace-pre-wrap break-words">{note?.body}</span>
                  <span className="mt-1 block text-2xs text-fg-faint">
                    {t("desktop:userMenu.onlyVisibleToYou")}
                  </span>
                </TooltipContent>
              </Tooltip>
            )}
          </div>
          {/* When a nickname is in force, the real name sits under it — a renamed
              person must stay identifiable (ADR 0019 §2). */}
          {realName && realName !== name && (
            <p className="truncate text-[13px] text-fg-muted">{realName}</p>
          )}
          <p className="truncate text-[13px] text-fg-muted">@{profile.user.username}</p>
          {/* Custom status (M18). PLAIN TEXT as a JSX child — React escapes it —
              and deliberately NOT run through the markdown renderer: a status line
              must not be able to inject formatting or links (§28). */}
          {customStatus && (
            <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-snug text-fg/80">
              {customStatus}
            </p>
          )}
          {/* Blocked state is stated plainly on the card, because every action
              below behaves differently while it holds. Only the viewer→target
              direction is ever known here; the reverse is unknowable by design. */}
          {profile.blocked && (
            <p className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-danger/10 px-2 py-1 text-2xs font-medium text-danger">
              <ShieldBan className="size-3" aria-hidden />
              {t("desktop:block.blockedNote")}
            </p>
          )}
        </m.div>

        {/* Sectioned body — one inset, glass-edged panel with hairline dividers */}
        {hasSections && (
          <m.div
            variants={staggerItem}
            className="mt-3 divide-y divide-stroke overflow-hidden rounded-lg border border-stroke bg-raised/60 glass-edge"
          >
            {hasBio && (
              <ProfileSection heading={t("desktop:profileCard.aboutHeading")}>
                <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-fg/90">
                  {profile.user.bio}
                </p>
              </ProfileSection>
            )}

            {/* NB: the viewer's private note is NOT a section here — it renders
                inline beside the name above (founder's call). One place only, so
                a long note cannot be shown in full on a card a screen-share is
                pointed at (ADR 0019 §1). */}
            {memberSince && (
              <ProfileSection heading={t("desktop:profileCard.memberSinceHeading")}>
                <p className="text-[13px] text-fg/90">{memberSince}</p>
              </ProfileSection>
            )}

            {hasRoles && (
              <ProfileSection heading={t("desktop:profileCard.rolesHeading")}>
                <div className="flex flex-wrap gap-1.5">
                  {profile.roles?.map((role) => (
                    <RoleChip key={role.id} name={role.name} color={role.color} />
                  ))}
                </div>
              </ProfileSection>
            )}

            {hasMutual && (
              <ProfileSection heading={t("desktop:profileCard.mutualServersHeading")}>
                <ul className="space-y-1.5">
                  {profile.mutualServers?.map((srv) => (
                    <li key={srv.id} className="flex items-center gap-2">
                      <UserAvatar name={srv.name} colorSeed={srv.id} src={srv.iconUrl} size="xs" />
                      <span className="min-w-0 flex-1 truncate text-xs text-fg/90">{srv.name}</span>
                    </li>
                  ))}
                </ul>
              </ProfileSection>
            )}
          </m.div>
        )}

        {actionErrorMessage && (
          <p role="alert" className="mt-3 text-xs text-danger">
            {actionErrorMessage}
          </p>
        )}

        {/* Footer: your own card offers "Edit profile"; anyone else's offers a
            message box that sends straight into the DM without navigating. */}
        <m.div variants={staggerItem}>
          {isSelf ? (
            <Button variant="secondary" className="mt-4 w-full" onClick={goEditProfile}>
              {t("desktop:profileCard.editProfile")}
            </Button>
          ) : profile.blocked ? (
            // A block refuses sends server-side, so no composer here — the way
            // back is the ⋯ menu's "Unblock" (§35).
            <p className="mt-4 text-center text-xs text-fg-faint">
              {t("desktop:profileCard.blockedNoMessage")}
            </p>
          ) : (
            <ProfileCardComposer
              userId={userId}
              name={name}
              groupId={groupId ?? null}
              onSent={onClose}
            />
          )}
        </m.div>
      </m.div>
    </div>
  );
}

/**
 * A round, glassy control on the banner. Shared by the relationship icons, the
 * block icon, the self-card pencil and the ⋯ menu.
 *
 * The translucent dark disc + backdrop-blur is not decoration: these sit on a
 * user-uploaded banner that can be any colour, and a bare white icon on a pale
 * photo is invisible. The disc guarantees contrast on every banner. Icon-only
 * controls always carry BOTH a tooltip (mouse) and an aria-label (screen
 * reader / touch, where there is no hover).
 */
function BannerAction({
  label,
  onClick,
  busy = false,
  disabled = false,
  tone = "default",
  children,
}: {
  label: string;
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
  /** `danger` tints the glyph red for the destructive controls (block). */
  tone?: "default" | "danger";
  children: ReactNode;
}): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          disabled={disabled || busy}
          onClick={onClick}
          className={cn(
            "flex size-7 cursor-pointer items-center justify-center rounded-full",
            "bg-black/45 backdrop-blur-sm transition-colors motion-instant hover:bg-black/65",
            "disabled:cursor-default disabled:opacity-60",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
            tone === "danger" ? "text-danger hover:text-danger" : "text-white",
          )}
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The card's message box (founder's reference): type a line to someone straight
 * from their profile, with the SAME emoji picker the composer uses — never a
 * second, hand-rolled one.
 *
 * Sending does NOT navigate to the DM. That is the whole point of having it
 * here: fire off a reply without leaving the channel you are reading. The DM is
 * created (idempotently) and seeded into the sidebar on the way through, so the
 * conversation is there when you do go looking for it.
 */
function ProfileCardComposer({
  userId,
  name,
  groupId,
  onSent,
}: {
  userId: UserId;
  name: string;
  groupId: GroupId | null;
  onSent: () => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const [value, setValue] = useState("");
  const sendDm = useSendDmMessage();

  const submit = (): void => {
    const content = value.trim();
    if (content.length === 0 || content.length > MESSAGE_MAX_LENGTH || sendDm.isPending) return;
    sendDm.mutate(
      { userId, content },
      {
        onSuccess: () => {
          setValue("");
          onSent();
        },
      },
    );
  };

  return (
    <div className="mt-4">
      {sendDm.error != null && (
        <p role="alert" className="mb-2 text-xs text-danger">
          {localizeBlockedError(sendDm.error, t, "message")}
        </p>
      )}
      <div className="flex items-end gap-1 rounded-lg border border-stroke bg-raised/60 px-2 py-1.5 focus-within:border-accent/60">
        <Textarea
          rows={1}
          value={value}
          maxLength={MESSAGE_MAX_LENGTH}
          placeholder={t("desktop:profileCard.messagePlaceholder", { name })}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          className="max-h-24 min-h-0 flex-1 resize-none border-0 bg-transparent p-0 text-[13px] focus-visible:ring-0"
          aria-label={t("desktop:profileCard.messagePlaceholder", { name })}
        />
        <EmojiPicker
          groupId={groupId}
          side="top"
          align="end"
          onSelect={(emoji) => setValue((prev) => prev + emoji)}
        >
          <button
            type="button"
            aria-label={t("desktop:composer.addEmoji")}
            className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-faint transition-colors motion-instant hover:bg-white/[0.06] hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
          >
            <SmilePlus className="size-4" />
          </button>
        </EmojiPicker>
        <button
          type="button"
          aria-label={t("desktop:profileCard.sendMessage")}
          disabled={value.trim().length === 0 || sendDm.isPending}
          onClick={submit}
          className={cn(
            "grid size-7 shrink-0 cursor-pointer place-items-center rounded-md transition-colors motion-instant",
            "text-accent hover:bg-accent/10 disabled:cursor-default disabled:text-fg-faint disabled:hover:bg-transparent",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
          )}
        >
          {sendDm.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <SendHorizontal className="size-4" />
          )}
        </button>
      </div>
    </div>
  );
}

/**
 * Profile popover (ADR 0010 §3/§5) opened from a member-sidebar row, a message
 * avatar, a friends-list row, a voice participant tile or the user footer's own
 * avatar (founder: "sol-alt avatar → profil kartı"). The card is: a
 * per-user colour banner with the relationship action and the ⋯ user menu in its
 * top-right, a large tap-to-zoom avatar with a presence dot, then a sectioned
 * body — About, your private Note, Member since, Roles and Mutual servers — and
 * a footer that is a DM message box on someone else's card and "Edit profile" on
 * your own.
 *
 * The shell is intentionally hook-light: the data hooks live in
 * {@link ProfileCardBody}, mounted only while the card is open, so a chat full
 * of avatars never fires a request per row.
 */
export function ProfileCard({ userId, groupId, children }: ProfileCardProps): JSX.Element {
  const [open, setOpen] = useState(false);
  // Tag the trigger so the user context menu's "Profile" entry can find and
  // click THIS card's trigger (scoped to the menu's own trigger element — see
  // MemberContextMenu). Marking it here keeps the marker in one place rather
  // than on every call site.
  const trigger = isValidElement(children)
    ? cloneElement(children as ReactElement, { "data-profile-trigger": userId })
    : children;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="start" className="w-[20rem] p-0">
        {open && (
          <ProfileCardBody userId={userId} groupId={groupId} onClose={() => setOpen(false)} />
        )}
      </PopoverContent>
    </Popover>
  );
}
