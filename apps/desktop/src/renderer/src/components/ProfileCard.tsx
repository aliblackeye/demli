import {
  cloneElement,
  isValidElement,
  useMemo,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { m } from "framer-motion";
import {
  Check,
  CloudOff,
  Loader2,
  MoreHorizontal,
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
import type {
  GroupId,
  PresencePlatform,
  PresenceStatus,
  ProfileFriendshipStatus,
  UserId,
} from "@demli/types";
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

type T = ReturnType<typeof useAppTranslation>["t"];

/**
 * The card sits on the `surface` tone (a popover opens over the base-toned
 * conversation column — see PopoverContent). Every avatar ring and presence
 * cut-out inside it follows that tone through `--avatar-ring`, so the 2px ring
 * and the dot's cut-out read as holes in THIS card, not in the sidebar behind.
 */
const CARD_RING_STYLE = { "--avatar-ring": "var(--color-surface)" } as CSSProperties;

/** Translated accessible name for a presence dot ("Çevrimiçi", "Boşta, telefonda"). */
export function presenceLabel(
  t: T,
  status: PresenceStatus,
  platform?: PresencePlatform,
): string {
  const base =
    status === "offline"
      ? t("desktop:presence.offline")
      : t(`desktop:presence.${status}` as const);
  return platform === "mobile" && status !== "offline"
    ? t("desktop:profileCard.presenceOnMobile", { status: base })
    : base;
}

/**
 * The banner strip — the user's uploaded image (photo or animated GIF) when
 * there is one, otherwise their seeded wash (lib/banner). ONE component behind
 * the real card, the settings preview and the crop editor preview, at the
 * same 8:3 shape the editor crops to, so what the editor frames is exactly
 * what the card shows.
 */
export function ProfileBanner({
  url,
  seed,
  className,
  children,
}: {
  url: string | null | undefined;
  seed: string;
  className?: string;
  /** Overlaid controls (top-right action cluster). */
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className={cn("relative aspect-[8/3] w-full overflow-hidden bg-app", className)}>
      {url ? (
        <img
          src={url}
          alt=""
          draggable={false}
          className="absolute inset-0 size-full select-none object-cover"
        />
      ) : (
        <div className="absolute inset-0" style={bannerGradient(seed)} aria-hidden />
      )}
      {/* Grounding fade into the card tone, so the overhanging avatar and the
          name below sit on one continuous surface rather than a hard edge. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-surface/45 to-transparent"
      />
      {children}
    </div>
  );
}

/**
 * The identity block as the card draws it — banner, overhanging avatar, name,
 * handle and (optionally) the status line and bio — WITHOUT any data hook. The
 * account settings preview and the crop editor render THIS, fed with the
 * unsaved draft, so "how it will look" is drawn by the same markup as "how it
 * looks" (founder: live preview before Save).
 */
export function ProfileIdentityPreview({
  name,
  username,
  seed,
  avatarUrl,
  bannerUrl,
  customStatus,
  bio,
  className,
  avatarSlot,
  bannerSlot,
}: {
  name: string;
  username: string;
  seed: string;
  avatarUrl: string | null | undefined;
  bannerUrl: string | null | undefined;
  customStatus?: string | null;
  bio?: string | null;
  className?: string;
  /** Replaces the plain avatar (e.g. a "change avatar" button around it). */
  avatarSlot?: ReactNode;
  /** Overlay inside the banner (e.g. a "change banner" control). */
  bannerSlot?: ReactNode;
}): JSX.Element {
  const { t } = useAppTranslation();
  return (
    <div className={cn("overflow-hidden rounded-card bg-surface", className)} style={CARD_RING_STYLE}>
      <ProfileBanner url={bannerUrl} seed={seed}>
        {bannerSlot}
      </ProfileBanner>
      <div className="px-4 pb-4">
        <div className="relative -mt-10 mb-3 w-fit rounded-full shadow-[0_0_0_4px_var(--color-surface)]">
          {avatarSlot ?? <UserAvatar name={name} colorSeed={seed} src={avatarUrl} size="lg" />}
        </div>
        <p className="truncate font-display text-lg font-semibold leading-tight text-fg-display">
          {name}
        </p>
        <p className="truncate text-label text-fg-muted">@{username}</p>
        {customStatus && (
          <p className="mt-1.5 whitespace-pre-wrap break-words text-label text-fg">{customStatus}</p>
        )}
        {bio && (
          <div className="mt-3 rounded-xl bg-app px-3 py-2.5">
            <p className="pb-1 text-2xs font-semibold uppercase tracking-wider text-fg-faint">
              {t("desktop:profileCard.aboutHeading")}
            </p>
            <p className="whitespace-pre-wrap break-words text-label text-fg">{bio}</p>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One section inside the card's inset panel (About / Member since / Roles /
 * Mutual servers). The panel itself is the darker `app` tone on the surface
 * card — tone steps, not hairlines, separate the stack (Koyu Masa: borderless).
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
    <div>
      <div className="flex items-baseline justify-between gap-2 pb-1">
        <p className="text-2xs font-semibold uppercase tracking-wider text-fg-faint">{heading}</p>
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
  const presencePlatform = useChatStore((s) => s.presencePlatforms[userId]);
  // One-user slice, same as `presence` above → a status change anywhere else in
  // the roster never re-renders this card (§27).
  const liveCustomStatus = useChatStore((s) => s.customStatuses[userId] ?? null);
  const isSelf = meId === userId;
  const [avatarOpen, setAvatarOpen] = useState(false);

  const { data: profile, isPending, error, refetch, isRefetching } = useProfile(userId, groupId, true);
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
    // name/handle + the inset panel + the footer control) so the layout does
    // not jump when the real data arrives — founder rule: skeletons, not spinners.
    return (
      <div role="status" aria-label={t("desktop:profileCard.loading")}>
        <div className="aspect-[8/3] w-full bg-wash" aria-hidden />
        <div className="px-4 pb-4">
          <div className="-mt-10 mb-3 w-fit rounded-full shadow-[0_0_0_4px_var(--color-surface)]">
            <Skeleton shape="circle" width={80} />
          </div>
          <Skeleton shape="line" height={18} className="w-36" />
          <Skeleton shape="line" height={12} className="mt-2 w-24" />
          <div className="mt-3 space-y-2 rounded-xl bg-app p-3">
            <Skeleton shape="line" height={10} className="w-16" />
            <Skeleton shape="line" />
            <Skeleton shape="line" className="w-4/5" />
          </div>
          <Skeleton shape="rect" height={38} className="mt-3 w-full" />
        </div>
        <span className="sr-only">{t("desktop:profileCard.loading")}</span>
      </div>
    );
  }

  if (error || !profile) {
    // Error state keeps the card's footprint (banner strip + body) so a failed
    // fetch reads as "this card, not loaded" rather than a collapsed popover.
    return (
      <div>
        <div className="aspect-[8/3] w-full bg-wash" aria-hidden />
        <div role="alert" className="flex flex-col items-center gap-3 px-6 pb-6 pt-5 text-center">
          <span className="grid size-10 place-items-center rounded-full bg-raised text-fg-muted">
            <CloudOff className="size-5" aria-hidden />
          </span>
          <p className="text-label text-fg-muted">{localizeError(error, t)}</p>
          <Button variant="secondary" size="sm" loading={isRefetching} onClick={() => void refetch()}>
            {t("buttons.retry")}
          </Button>
        </div>
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

  // Own card only (founder): the pencil on the banner jumps to the unified
  // Account settings panel to add or change either image.
  const goEditProfile = (): void => {
    onClose();
    openSettings("profile");
  };

  /**
   * The relationship controls, pinned to the banner's top-right (founder's
   * reference). Icon-only, but never bare: each carries a tooltip AND an
   * aria-label, and each sits on its own glass disc so it stays legible over a
   * light banner photo.
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
        {profile.blocked ? <ShieldOff /> : <ShieldBan />}
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
              <UserMinus />
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
              <UserPlus />
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
              <UserRoundX />
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
                <Check />
              </BannerAction>
              <BannerAction
                label={t("desktop:profileCard.decline")}
                busy={removeRequest.isPending}
                disabled={busy}
                onClick={onRemoveRequest}
              >
                <X />
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
    // Column layout so the card can never outgrow the window (the popover caps
    // it at Radix's available height): banner and avatar stay put, the middle
    // scrolls, and the footer — the DM composer, the card's main action — is
    // pinned at the bottom where it is always reachable.
    <div style={CARD_RING_STYLE} className="flex min-h-0 flex-1 flex-col">
      <AvatarLightbox
        open={avatarOpen}
        onOpenChange={setAvatarOpen}
        url={profile.user.avatarUrl}
        name={name}
        colorSeed={profile.user.id}
      />

      {/* Banner — top-right carries the relationship action and the ⋯ menu
          (founder's reference); on the viewer's OWN card, a pencil to
          settings instead. */}
      <ProfileBanner url={bannerUrl} seed={profile.user.id} className="shrink-0">
        <div className="absolute right-2 top-2 flex items-center gap-1.5">
          {relationshipActions}
          {isSelf && (
            <BannerAction label={t("desktop:profileCard.editImages")} onClick={goEditProfile}>
              <Pencil />
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
              aria-haspopup="menu"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                event.currentTarget.dispatchEvent(
                  new MouseEvent("contextmenu", {
                    bubbles: true,
                    clientX: rect.left,
                    clientY: rect.bottom + 4,
                  }),
                );
              }}
              className={bannerActionClass("default")}
            >
              <MoreHorizontal />
            </button>
          </MemberContextMenu>
        </div>
      </ProfileBanner>

      {/* Content settles in as a short sequence over the popover's own pop-in
          (app-ui stagger presets; reduced motion is honoured by MotionConfig). */}
      <m.div
        className="flex min-h-0 flex-1 flex-col"
        variants={staggerContainer}
        initial="initial"
        animate="animate"
      >
        {/* Identity: overhanging avatar (with a presence dot). Outside the
            scroll region — a scroller clips, and the avatar overlaps the
            banner by half its height. */}
        <m.div variants={staggerItem} className="shrink-0 px-4">
          <div className="relative -mt-10 mb-3 w-fit rounded-full shadow-[0_0_0_4px_var(--color-surface)]">
            {/* Founder: pressing the avatar opens it big, and you can move around
                inside it. Always a button, even without a photo, so the gesture
                is consistent across the roster. */}
            <button
              type="button"
              onClick={() => setAvatarOpen(true)}
              aria-label={t("desktop:profileCard.viewAvatar", { name })}
              className="block cursor-zoom-in rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
            >
              <UserAvatar
                name={profile.user.displayName}
                colorSeed={profile.user.id}
                src={profile.user.avatarUrl}
                size="lg"
                presence={presence}
                presencePlatform={presencePlatform}
                presenceLabel={presence ? presenceLabel(t, presence, presencePlatform) : undefined}
              />
            </button>
          </div>
        </m.div>

        {/* The middle scrolls when the card is taller than the space it has
            (a low window, a long bio, many roles). overscroll-contain keeps a
            wheel at the end of it from scrolling the chat behind the card. The
            bottom edge fades out over the last 12px — which is the region's
            own bottom padding when nothing overflows, so the fade only ever
            shows on content that continues below. */}
        <div
          data-testid="profile-card-scroll"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-3 [mask-image:linear-gradient(to_bottom,black_calc(100%-0.75rem),transparent)]"
        >
          <m.div variants={staggerItem}>
            {/* Name + the viewer's private note in parentheses. The note is a
                quiet, smaller aside so the NAME still reads as the heading, is
                clipped to one short line, and carries the full text plus its
                privacy label in a tooltip — the long-note case must not push the
                card's identity block around. */}
            <div className="flex min-w-0 items-baseline space-x-1.5">
              <p className="min-w-0 truncate font-display text-lg font-semibold leading-tight text-fg-display">
                {name}
              </p>
              {noteBadge && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    {/* Capped at 45% so the NAME always keeps the majority of the
                        row — the note is an aside, never the headline. */}
                    <span className="max-w-[45%] shrink-0 truncate text-label font-medium text-fg-faint">
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
              <p className="truncate text-label text-fg-muted">{realName}</p>
            )}
            <p className="truncate text-label text-fg-muted">@{profile.user.username}</p>
            {/* Custom status (M18). PLAIN TEXT as a JSX child — React escapes it —
                and deliberately NOT run through the markdown renderer: a status line
                must not be able to inject formatting or links (§28). */}
            {customStatus && (
              <p className="mt-1.5 whitespace-pre-wrap break-words text-label leading-snug text-fg">
                {customStatus}
              </p>
            )}
            {/* Blocked state is stated plainly on the card, because every action
                below behaves differently while it holds. Only the viewer→target
                direction is ever known here; the reverse is unknowable by design. */}
            {profile.blocked && (
              <p className="mt-2 inline-flex items-center gap-1.5 rounded-pill bg-danger-surface px-2.5 py-1 text-2xs font-medium text-danger">
                <ShieldBan className="size-3" aria-hidden />
                {t("desktop:block.blockedNote")}
              </p>
            )}
          </m.div>

          {/* Inset panel — the darker base tone on the surface card. */}
          {hasSections && (
            <m.div variants={staggerItem} className="mt-3 space-y-3 rounded-xl bg-app p-3">
              {hasBio && (
                <ProfileSection heading={t("desktop:profileCard.aboutHeading")}>
                  <p className="whitespace-pre-wrap break-words text-label leading-relaxed text-fg">
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
                  <p className="text-label text-fg">{memberSince}</p>
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
                  <ul className="space-y-1.5" style={{ "--avatar-ring": "var(--color-app)" } as CSSProperties}>
                    {profile.mutualServers?.map((srv) => (
                      <li key={srv.id} className="flex items-center gap-2">
                        <UserAvatar name={srv.name} colorSeed={srv.id} src={srv.iconUrl} size="xs" />
                        <span className="min-w-0 flex-1 truncate text-label text-fg">{srv.name}</span>
                      </li>
                    ))}
                  </ul>
                </ProfileSection>
              )}
            </m.div>
          )}

          {actionErrorMessage && (
            <p role="alert" className="mt-3 text-label text-danger">
              {actionErrorMessage}
            </p>
          )}
        </div>

        {/* Footer: your own card offers "Edit profile"; anyone else's offers a
            message box that sends straight into the DM without navigating.
            Pinned below the scroll region. */}
        <m.div variants={staggerItem} className="shrink-0 px-4 pb-4">
          {isSelf ? (
            <Button variant="secondary" className="mt-1 w-full" onClick={goEditProfile}>
              <Pencil className="size-4" aria-hidden />
              {t("desktop:profileCard.editProfile")}
            </Button>
          ) : profile.blocked ? (
            // A block refuses sends server-side, so no composer here — the way
            // back is the ⋯ menu's "Unblock" (§35).
            <p className="mt-1 text-center text-label text-fg-faint">
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
 * Glass disc for a control that sits on a user-uploaded banner. The disc is
 * not decoration: the banner can be any colour, and a bare white icon on a pale
 * photo is invisible — the glass (72% neutral + blur) guarantees contrast on
 * every banner. Hover lifts the tone (200ms, no movement); the danger tone
 * carries the pink glyph AND a pink wash on hover so a destructive control is
 * recognisable before it is pressed.
 */
function bannerActionClass(tone: "default" | "danger"): string {
  return cn(
    "grid size-8 cursor-pointer place-items-center rounded-full surface-glass transition-colors motion-hover",
    "[&_svg]:size-4 [&_svg]:shrink-0",
    "disabled:cursor-default disabled:opacity-40",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
    tone === "danger"
      ? "text-danger hover:bg-danger/25 active:bg-danger/35"
      : "text-fg-display hover:bg-raised active:bg-raised-pressed",
  );
}

/**
 * A round control on the banner. Shared by the relationship icons, the block
 * icon and the self-card pencil (the ⋯ menu uses the same class). Icon-only
 * controls always carry BOTH a tooltip (mouse) and an aria-label (screen reader
 * / touch, where there is no hover).
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
  /** `danger` tints the glyph pink for the destructive controls (block, unfriend). */
  tone?: "default" | "danger";
  children: ReactNode;
}): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-busy={busy || undefined}
          disabled={disabled || busy}
          onClick={onClick}
          className={bannerActionClass(tone)}
        >
          {busy ? <Loader2 className="animate-spin" /> : children}
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
    <div className="mt-1">
      {sendDm.error != null && (
        <p role="alert" className="mb-2 text-label text-danger">
          {localizeBlockedError(sendDm.error, t, "message")}
        </p>
      )}
      {/* Input recipe: base tone at rest, raised tone while focused (no ring,
          no border — the tone change IS the focus state). */}
      <div className="flex items-end gap-1 rounded-lg bg-app py-1.5 pl-3 pr-1.5 transition-colors motion-hover focus-within:bg-raised">
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
          className="max-h-24 min-h-0 flex-1 rounded-none bg-transparent px-0 py-1 text-label hover:bg-transparent focus:bg-transparent focus:shadow-none"
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
            className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-faint transition-colors motion-hover hover:bg-wash hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
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
            "grid size-7 shrink-0 cursor-pointer place-items-center rounded-md transition-colors motion-hover",
            "text-accent hover:bg-accent-surface active:bg-accent/20",
            "disabled:cursor-default disabled:text-fg-subtle disabled:hover:bg-transparent",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
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
 * avatar (founder: "sol-alt avatar → profil kartı"). The card is: the banner
 * (uploaded image or seeded wash) with the relationship action and the ⋯ user
 * menu in its top-right, a large tap-to-zoom avatar with a presence dot, then an
 * inset panel — About, Member since, Roles and Mutual servers — and a footer
 * that is a DM message box on someone else's card and "Edit profile" on your
 * own.
 *
 * Opens/closes with the popover's pop (scale .98 + fade, standard step) and
 * the body settles in a short stagger; reduced motion collapses both.
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
      <PopoverContent
        align="start"
        collisionPadding={12}
        // Never taller than the space Radix measured on the chosen side (minus
        // the collision padding it already subtracts), and never absurdly tall
        // on a big monitor. The body scrolls inside; nothing is cut off.
        className="flex max-h-[min(var(--radix-popover-content-available-height),40rem)] w-[20rem] flex-col rounded-card p-0"
      >
        {open && (
          <ProfileCardBody userId={userId} groupId={groupId} onClose={() => setOpen(false)} />
        )}
      </PopoverContent>
    </Popover>
  );
}

interface ProfileCardProps {
  userId: UserId;
  /** Shared-server context: roles show only when both belong to this server. */
  groupId?: GroupId;
  /** The trigger (avatar / name button); rendered via `asChild`. */
  children: ReactNode;
}
