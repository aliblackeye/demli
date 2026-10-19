import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import {
  CalendarDays,
  Check,
  CloudOff,
  EllipsisVertical,
  MessageSquare,
  Pencil,
  Phone,
  SendHorizontal,
  ShieldBan,
  ShieldOff,
  Smile,
  UserMinus,
  UserPlus,
  UserRoundX,
  Video,
  X,
  type LucideIcon,
} from "lucide-react-native";
import { isCallLive, noteBadgeText, visibleCustomStatus } from "@demli/client-core";
import { MESSAGE_MAX_LENGTH } from "@demli/config";
import type { DmId, GroupId, ProfileFriendshipStatus, Role, UserId } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { Avatar } from "@/components/Avatar";
import { EmojiPicker } from "@/components/EmojiPicker";
import { EmptyState } from "@/components/EmptyState";
import { AvatarLightbox } from "@/components/member/AvatarLightbox";
import { MemberActionSheet, type MemberSheetTarget } from "@/components/member/MemberActionSheet";
import { ProfileBannerImage } from "@/components/ProfileBannerImage";
import { Screen } from "@/components/Screen";
import { Skeleton } from "@/components/Skeleton";
import { ConfirmSheet } from "@/components/settings/ConfirmSheet";
import { SectionEyebrow } from "@/components/settings/SettingsSection";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Text, TextInput } from "@/components/ui/Text";
import { Touchable } from "@/components/ui/Touchable";
import { localizeError } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { useKeyboardHeight } from "@/lib/use-keyboard-height";
import {
  useAcceptFriendRequest,
  useOpenDm,
  useProfile,
  useRemoveFriendRequest,
  useSendDmMessage,
  useSendFriendRequest,
  useUnfriend,
} from "@/queries/social-queries";
import { useBlockUser, useUnblockUser, useUserNote } from "@/queries/member-queries";
import { getCallController, useCallState } from "@/stores/call-store";
import { useAuthStore } from "@/stores/auth-store";
import { useChatStore } from "@/stores/chat-store";
import { colors, motion, radius, space } from "@/theme/theme";

const AVATAR_SIZE = 88;

/** A server-role pill, tinted by the role's colour dot (ADR 0007). */
function RoleChip({ role }: { role: Role }) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.xs + 2,
        paddingHorizontal: space.md,
        paddingVertical: space.xs + 1,
        borderRadius: radius.pill,
        backgroundColor: colors.surfaceRaised,
      }}
    >
      <View style={{ width: 8, height: 8, borderRadius: radius.pill, backgroundColor: role.color ?? colors.fgMuted }} />
      <Text type="meta" tone="default" style={{ fontWeight: "500" }}>
        {role.name}
      </Text>
    </View>
  );
}

/**
 * One tile of the comms strip (Message / Voice / Video): icon over a label on
 * the surface tone. A tile that is not available stays visible at 40% and the
 * strip says why underneath (calls are friends-only, ADR 0012) — never a dead
 * control without a reason.
 */
function CommsTile({
  icon: Icon,
  label,
  onPress,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Touchable
      onPress={onPress}
      disabled={disabled}
      haptic="light"
      accessibilityRole="button"
      accessibilityLabel={label}
      tone={colors.surface}
      pressedTone={colors.surfaceRaised}
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        gap: space.xs + 2,
        minHeight: 68,
        paddingVertical: space.md,
        borderRadius: radius.xl,
        borderCurve: "continuous",
      }}
    >
      <Icon size={20} color={disabled ? colors.fgMuted : colors.accent} strokeWidth={2} />
      <Text type="meta" tone="default" numberOfLines={1} style={{ fontWeight: "600" }}>
        {label}
      </Text>
    </Touchable>
  );
}

/** A labelled card section (About, Member since, Roles). */
function InfoCard({ title, icon: Icon, children }: { title: string; icon?: LucideIcon; children: ReactNode }) {
  return (
    <View style={{ backgroundColor: colors.surface, borderRadius: radius.xl, borderCurve: "continuous", padding: space.lg, gap: space.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs + 2 }}>
        {Icon ? <Icon size={14} color={colors.fgFaint} strokeWidth={2} /> : null}
        <SectionEyebrow style={{ paddingHorizontal: 0, paddingBottom: 0 }}>{title}</SectionEyebrow>
      </View>
      {children}
    </View>
  );
}

/** The identity block while the profile is still loading: shape, not a spinner. */
function IdentitySkeleton() {
  return (
    <View style={{ gap: space.sm, paddingTop: space.sm }}>
      <Skeleton width="56%" height={24} radius={radius.sm} />
      <Skeleton width="34%" height={14} radius={radius.sm} />
      <View style={{ flexDirection: "row", gap: space.sm, paddingTop: space.lg }}>
        <Skeleton width="31%" height={68} radius={radius.xl} />
        <Skeleton width="31%" height={68} radius={radius.xl} />
        <Skeleton width="31%" height={68} radius={radius.xl} />
      </View>
      <Skeleton width="100%" height={52} radius={radius.cta} style={{ marginTop: space.sm }} />
    </View>
  );
}

type Pending = "unfriend" | "block" | "unblock" | null;

/**
 * Context-aware profile card (ADR 0010 §3), presented as a modal when a person
 * is tapped (friend row / message avatar / DM header / server member).
 *
 * Koyu Masa: the 8:3 banner (theirs, or their colour under the coral glow), a
 * large avatar overlapping it on a 4px ring of the page, glass controls on the
 * banner (one friendship slot, block, ⋯), the name in Onest with the viewer's
 * private note beside it, a Message / Voice / Video strip (calls gated to
 * mutual friends, ADR 0012), then About · Member since · Roles cards — roles
 * only when `groupId` names a server both users share. The self card links to
 * profile editing. Loading draws the shape (skeleton), a failed load says what
 * happened with a retry, a block replaces the comms with what changed.
 *
 * Destructive steps (unfriend, block, unblock) confirm in a sheet that states
 * the consequence and keeps the request's busy state and error in place.
 */
export default function UserProfileScreen() {
  const { t, i18n } = useAppTranslation();
  const params = useLocalSearchParams<{ userId: string; name?: string; groupId?: string }>();
  const userId = params.userId;
  const groupId = params.groupId;
  const me = useAuthStore((s) => s.user);
  const insets = useSafeAreaInsets();
  // The real IME height, not KeyboardAvoidingView: under Android edge-to-edge
  // mode KAV gets no keyboard inset and the box stays buried (lib/use-keyboard-
  // height documents that founder bug on the composer).
  const keyboardHeight = useKeyboardHeight();

  const isSelf = !!me && me.id === userId;
  const profile = useProfile(userId ?? null, groupId, !!userId && !isSelf);
  const presence = useChatStore((s) => (userId ? s.presence[userId] ?? "offline" : "offline"));
  // The viewer's private note about THIS person, for the short badge beside the
  // name. Gated on `!isSelf` — you cannot note yourself and the read must not
  // even be issued for your own card (ADR 0019 §1, desktop ProfileCard parity).
  const noteUserId = (userId ?? null) as UserId | null;
  const note = useUserNote(noteUserId, !isSelf);
  // One-user slice, same as `presence` above → a status change anywhere else in
  // the roster never re-renders this card (§27).
  const liveCustomStatus = useChatStore((s) => (userId ? s.customStatuses[userId] ?? null : null));

  const sendRequest = useSendFriendRequest();
  const accept = useAcceptFriendRequest();
  const removeRequest = useRemoveFriendRequest();
  const unfriend = useUnfriend();
  const openDm = useOpenDm();
  const sendDmMessage = useSendDmMessage();
  const blockUser = useBlockUser();
  const unblockUser = useUnblockUser();
  const callState = useCallState();

  const [avatarOpen, setAvatarOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Self card falls back to the auth-store record (useProfile is disabled for self).
  const user = isSelf ? me : profile.data?.user;
  const displayName = user?.displayName ?? params.name ?? t("mobile:userProfile.title");
  // Short, one-line form of the private note, rendered in parentheses after the
  // name (founder: "notu isminin yanına parantezle koyalım. kısa bişey olsun").
  // NEVER on your own card — `isSelf` short-circuits before the text is even
  // shaped, so a self-render cannot leak a stale cache entry.
  const noteBadge = isSelf ? null : noteBadgeText(note.data?.body);
  const bio = user?.bio?.trim() || null;
  // Custom status (M18). Prefer the LIVE line from the presence stream over the
  // (possibly minutes-old) copy on the fetched profile — the card is often open
  // while a status changes. The fetched copy is expiry-checked; the live one is
  // fresh by definition and carries no expiry.
  const customStatus = liveCustomStatus ?? visibleCustomStatus(user);
  // Roles render ONLY when the profile carries them — i.e. `groupId` named a
  // server both users share (ADR 0010 §3). No groupId (DM / friends list) → no
  // roles from the API → the section stays hidden. Bound to the route's groupId.
  const roles = profile.data?.roles ?? [];
  const status: ProfileFriendshipStatus = profile.data?.friendship ?? "none";
  const loadFailed = !isSelf && profile.isError;
  const loading = !isSelf && profile.isPending;
  // A block refuses messaging and calling server-side, so the whole comms strip
  // and the message box go away rather than sitting there as dead controls
  // (§35). Unblocking stays reachable on the banner and in the menu.
  const blocked = profile.data?.blocked === true;

  // "Member since" (ref #5) from the durable createdAt, localized to the app
  // language. Intl.DateTimeFormat is already used by the i18n package (Hermes).
  const memberSince = useMemo(() => {
    const createdAt = user?.createdAt;
    if (!createdAt) return null;
    const date = new Date(createdAt);
    if (Number.isNaN(date.getTime())) return null;
    try {
      return new Intl.DateTimeFormat(i18n.language, { year: "numeric", month: "long", day: "numeric" }).format(date);
    } catch {
      return date.toLocaleDateString();
    }
  }, [user?.createdAt, i18n.language]);

  // Call gate (ADR 0012 §3): only a mutual friend can be called, and never while
  // another call is live. The server re-checks; this just disables the buttons.
  const canCall = status === "friends" && !isCallLive(callState);

  /** A failed action says so in place, above the actions it came from. */
  const onError = (err: unknown) => {
    haptics.error();
    setActionError(localizeError(err, t));
  };

  const busy =
    sendRequest.isPending || accept.isPending || removeRequest.isPending || unfriend.isPending || openDm.isPending;

  const onMessage = () => {
    if (!userId) return;
    setActionError(null);
    openDm.mutate(userId, {
      onSuccess: ({ dm }) =>
        router.push({
          pathname: "/dm/[dmId]",
          params: {
            dmId: dm.id,
            streamId: dm.streamId,
            name: dm.participant.displayName,
            userId: dm.participant.id,
          },
        }),
      onError,
    });
  };

  // Start a call from the profile (ADR 0012): open/seed the DM, then hand the
  // fresh dmId to the shared call controller and route to the call surface —
  // exactly what the DM header does, minus the pre-existing dmId.
  const startCall = (media: "audio" | "video") => {
    if (!userId || !canCall) return;
    setActionError(null);
    openDm.mutate(userId, {
      onSuccess: ({ dm }) => {
        void getCallController()
          .startCall({ dmId: dm.id as DmId, media })
          .catch(() => {
            // The controller lands on a friendly terminal + logs the cause.
          });
        router.push({
          pathname: "/call",
          params: { name: displayName, ...(media === "video" ? { withVideo: "1" } : {}) },
        });
      },
      onError,
    });
  };

  const ask = (what: Pending) => {
    haptics.medium();
    setPendingError(null);
    setPending(what);
  };

  /** Run the confirmed destructive step; the sheet keeps its busy/error state. */
  const confirmPending = () => {
    if (!userId) return;
    const done = { onSuccess: () => setPending(null), onError: (err: unknown) => setPendingError(localizeError(err, t)) };
    if (pending === "unfriend") unfriend.mutate(userId, done);
    else if (pending === "block") blockUser.mutate(userId as UserId, done);
    else if (pending === "unblock") unblockUser.mutate(userId as UserId, done);
  };

  /**
   * Send one line without leaving this screen (founder's reference). The DM is
   * opened/seeded and the text goes through the normal outbox, so an offline
   * send queues and retries exactly like one typed in the thread — it is never
   * a second, weaker send path.
   */
  const onSendDraft = () => {
    const content = draft.trim();
    if (!userId || content.length === 0 || content.length > MESSAGE_MAX_LENGTH) return;
    sendDmMessage.mutate(
      { userId, content },
      {
        onSuccess: () => {
          setDraft("");
          haptics.light();
          // Confirm in place: the message is in the DM, not on this screen, so
          // without a receipt the box would just silently empty.
          setSent(true);
          setTimeout(() => setSent(false), 2200);
        },
        onError,
      },
    );
  };

  /**
   * What the ⋯ menu acts on. Memoized so opening the menu does not hand it a
   * fresh object on every keystroke in the message box below (the sheet remounts
   * on target identity change, §27).
   */
  const menuTarget = useMemo<MemberSheetTarget | null>(
    () =>
      userId
        ? {
            userId: userId as UserId,
            displayName: user?.displayName,
            username: user?.username,
          }
        : null,
    [userId, user?.displayName, user?.username],
  );

  /**
   * The single friendship control on the banner — one slot, four states. It
   * shares its handlers with the big button lower down (the thumb-sized target
   * on a phone), so the compact icon and the CTA can never behave differently.
   * `null` while the friendship is still loading: offering "Add friend" to
   * someone who is already a friend is worse than offering nothing for a beat.
   */
  const relationshipAction: ReactNode = ((): ReactNode => {
    if (!userId || profile.isPending) return null;
    switch (status) {
      case "friends":
        return (
          <IconButton
            icon={UserMinus}
            variant="veil"
            size="md"
            label={t("mobile:userProfile.removeFriendA11y", { name: displayName })}
            disabled={busy}
            onPress={() => ask("unfriend")}
          />
        );
      case "none":
        return (
          <IconButton
            icon={UserPlus}
            variant="veil"
            size="md"
            label={t("mobile:userProfile.addFriendA11y", { name: displayName })}
            disabled={busy}
            onPress={() => sendRequest.mutate({ userId }, { onError })}
          />
        );
      case "outgoing":
        return (
          <IconButton
            icon={UserRoundX}
            variant="veil"
            size="md"
            label={t("mobile:userProfile.cancelRequestA11y", { name: displayName })}
            disabled={busy}
            onPress={() => removeRequest.mutate(userId, { onError })}
          />
        );
      case "incoming":
        return (
          <IconButton
            icon={Check}
            variant="veil"
            size="md"
            active
            label={t("mobile:userProfile.acceptRequestA11y", { name: displayName })}
            disabled={busy}
            onPress={() => accept.mutate(userId, { onError })}
          />
        );
      default:
        return null;
    }
  })();

  const pendingBusy = unfriend.isPending || blockUser.isPending || unblockUser.isPending;
  const draftEmpty = draft.trim().length === 0;

  return (
    <Screen>
      <Stack.Screen options={{ title: displayName }} />
      <ScrollView
        contentContainerStyle={{ paddingBottom: space.xl + insets.bottom }}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          isSelf ? undefined : (
            <RefreshControl
              refreshing={profile.isRefetching}
              onRefresh={() => void profile.refetch()}
              tintColor={colors.fgMuted}
              colors={[colors.accent]}
              progressBackgroundColor={colors.surfaceRaised}
            />
          )
        }
      >
        {userId ? (
          <View>
            <View accessibilityLabel={t("mobile:userProfile.bannerA11y")}>
              <ProfileBannerImage bannerUrl={user?.bannerUrl} seedId={userId} />
            </View>
            {/* Controls pinned to the banner's top-right, on the veil so they
                read over a light photo. Exactly ONE friendship control at a
                time, plus block and ⋯. None on your own card: you cannot friend
                or block yourself and the API rejects both (§35). */}
            <View
              style={{ position: "absolute", top: space.sm, right: space.sm, flexDirection: "row", alignItems: "center", gap: space.xs }}
            >
              {!isSelf && !blocked ? relationshipAction : null}
              {!isSelf ? (
                <IconButton
                  icon={blocked ? ShieldOff : ShieldBan}
                  variant="veil"
                  size="md"
                  label={
                    blocked
                      ? t("mobile:block.unblockA11y", { name: displayName })
                      : t("mobile:block.blockA11y", { name: displayName })
                  }
                  disabled={pendingBusy}
                  onPress={() => ask(blocked ? "unblock" : "block")}
                />
              ) : null}
              <IconButton
                icon={EllipsisVertical}
                variant="veil"
                size="md"
                label={t("mobile:userProfile.moreActionsA11y", { name: displayName })}
                onPress={() => setMenuOpen(true)}
              />
            </View>
          </View>
        ) : null}

        {/* Identity — the avatar overlapping the banner, on a ring of the page. */}
        <View style={{ paddingHorizontal: space.lg, marginTop: -(AVATAR_SIZE / 2) - 4 }}>
          <Touchable
            // Founder: pressing the avatar opens it big and you can move around
            // inside it. Always pressable, even without a photo, so the gesture
            // is the same for everyone in the roster.
            onPress={() => setAvatarOpen(true)}
            pressScale={0.96}
            // The ring IS the fill: keep the page tone through the press (the
            // press answers with scale) instead of the default clear → wash.
            tone={colors.app}
            pressedTone={colors.app}
            accessibilityRole="button"
            accessibilityLabel={t("mobile:userProfile.viewAvatar", { name: displayName })}
            style={{ alignSelf: "flex-start", borderRadius: radius.pill, backgroundColor: colors.app, padding: 4 }}
          >
            <Avatar
              name={displayName}
              size={AVATAR_SIZE}
              uri={user?.avatarUrl}
              presence={isSelf ? "online" : presence}
              ringColor={colors.app}
            />
          </Touchable>

          {loading && !user ? (
            <IdentitySkeleton />
          ) : (
            <Animated.View
              entering={FadeIn.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
              style={{ marginTop: space.sm, gap: 2 }}
            >
              {/* Name + the viewer's private note in parentheses — a quieter aside
                  so the NAME stays the heading; one line, capped. */}
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
                <Text type="title" tone="display" numberOfLines={1} style={{ flexShrink: 1 }}>
                  {displayName}
                </Text>
                {noteBadge ? (
                  <Text
                    numberOfLines={1}
                    accessibilityLabel={`(${noteBadge}) ${t("mobile:userMenu.onlyVisibleToYou")}`}
                    style={{ flexShrink: 0, maxWidth: "45%", color: colors.fgFaint, fontSize: 14, fontWeight: "500" }}
                  >
                    ({noteBadge})
                  </Text>
                ) : null}
              </View>
              {user?.username ? (
                <Text type="ui" tone="muted" style={{ fontWeight: "400" }}>
                  @{user.username}
                </Text>
              ) : null}
              {/* Custom status (M18). PLAIN TEXT as a JSX child — RN escapes it —
                  and deliberately NOT run through the markdown renderer: a status
                  line must not be able to inject formatting or links (§28). */}
              {customStatus ? (
                <View
                  style={{
                    alignSelf: "flex-start",
                    marginTop: space.sm,
                    paddingHorizontal: space.md,
                    paddingVertical: space.xs + 2,
                    borderRadius: radius.lg,
                    borderTopLeftRadius: radius.sm / 2,
                    backgroundColor: colors.surface,
                    maxWidth: "100%",
                  }}
                >
                  <Text type="ui" tone="default" style={{ fontWeight: "400" }}>
                    {customStatus}
                  </Text>
                </View>
              ) : null}
            </Animated.View>
          )}
        </View>

        <View style={{ paddingHorizontal: space.lg, paddingTop: space.lg, gap: space.md }}>
          {/* Action area — adapts to the viewer→target relationship. */}
          {isSelf ? (
            <Button
              label={t("mobile:userProfile.editProfile")}
              icon={Pencil}
              variant="secondary"
              size="lg"
              block
              onPress={() => router.push("/profile")}
            />
          ) : loadFailed ? (
            <View style={{ backgroundColor: colors.surface, borderRadius: radius.xl }}>
              <EmptyState
                tone="error"
                compact
                icon={<CloudOff size={22} color={colors.danger} />}
                title={t("mobile:userProfile.loadErrorTitle")}
                subtitle={t("mobile:userProfile.loadErrorBody")}
                action={
                  <Button
                    label={t("common:buttons.retry")}
                    variant="secondary"
                    size="sm"
                    onPress={() => void profile.refetch()}
                    loading={profile.isFetching}
                  />
                }
              />
            </View>
          ) : loading ? null : (
            <>
              {actionError ? (
                <Banner
                  variant="danger"
                  title={t("mobile:userProfile.actionErrorTitle")}
                  description={actionError}
                  onDismiss={() => setActionError(null)}
                />
              ) : null}

              {/* Comms strip (ref #5). Message needs friendship; calls also need
                  no live call. A block hides the strip entirely: every one of
                  these is refused server-side while it holds (§35). */}
              {blocked ? null : (
                <View style={{ gap: space.sm }}>
                  <View style={{ flexDirection: "row", gap: space.sm }}>
                    <CommsTile
                      icon={MessageSquare}
                      label={t("mobile:friends.message")}
                      onPress={onMessage}
                      disabled={status !== "friends" || busy}
                    />
                    <CommsTile
                      icon={Phone}
                      label={t("mobile:call.voiceCall")}
                      onPress={() => startCall("audio")}
                      disabled={!canCall || busy}
                    />
                    <CommsTile
                      icon={Video}
                      label={t("mobile:call.videoCall")}
                      onPress={() => startCall("video")}
                      disabled={!canCall || busy}
                    />
                  </View>
                  {status !== "friends" ? (
                    <Text type="meta" tone="faint" style={{ textAlign: "center", fontWeight: "400" }}>
                      {t("mobile:userProfile.callNotFriend")}
                    </Text>
                  ) : null}
                </View>
              )}

              {/* Blocked: say what changed, in the neutral wording the API's own
                  one-sided model requires — never who blocked whom (§28). */}
              {blocked ? <Banner variant="danger" title={t("mobile:block.blocked")} description={t("mobile:block.blockedNote")} /> : null}

              {/* Relationship CTA for this friendship state. Hidden while a block
                  holds: friending is refused server-side; unblocking is on the
                  banner and in the menu. */}
              {blocked ? null : status === "friends" ? (
                <Button
                  label={t("mobile:userProfile.removeFriend")}
                  icon={UserMinus}
                  variant="danger"
                  size="lg"
                  block
                  onPress={() => ask("unfriend")}
                  disabled={busy}
                />
              ) : status === "incoming" ? (
                <View style={{ flexDirection: "row", gap: space.sm }}>
                  <Button
                    label={t("mobile:friends.accept")}
                    icon={Check}
                    variant="accent"
                    size="lg"
                    onPress={() => userId && accept.mutate(userId, { onError })}
                    loading={accept.isPending}
                    disabled={busy}
                    style={{ flex: 1 }}
                  />
                  <Button
                    label={t("mobile:friends.decline")}
                    icon={X}
                    variant="danger"
                    size="lg"
                    onPress={() => userId && removeRequest.mutate(userId, { onError })}
                    loading={removeRequest.isPending}
                    disabled={busy}
                    style={{ flex: 1 }}
                  />
                </View>
              ) : status === "outgoing" ? (
                <Button
                  label={t("mobile:friends.cancelRequest")}
                  icon={X}
                  variant="secondary"
                  size="lg"
                  block
                  onPress={() => userId && removeRequest.mutate(userId, { onError })}
                  loading={removeRequest.isPending}
                  disabled={busy}
                />
              ) : (
                <Button
                  label={t("mobile:friends.addFriend")}
                  icon={UserPlus}
                  variant="accent"
                  size="lg"
                  block
                  onPress={() => userId && sendRequest.mutate({ userId }, { onError })}
                  loading={sendRequest.isPending}
                  disabled={busy}
                />
              )}
            </>
          )}

          {bio ? (
            <InfoCard title={t("mobile:userProfile.aboutLabel")}>
              <Text selectable type="body" tone="default">
                {bio}
              </Text>
            </InfoCard>
          ) : null}

          {/* Member since (ref #5) — whenever we have the durable record. */}
          {memberSince ? (
            <InfoCard title={t("mobile:userProfile.memberSince")} icon={CalendarDays}>
              <Text type="body" tone="default" style={{ fontWeight: "500" }}>
                {memberSince}
              </Text>
            </InfoCard>
          ) : null}

          {roles.length > 0 ? (
            <InfoCard title={t("mobile:userProfile.rolesLabel")}>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                {roles.map((role) => (
                  <RoleChip key={role.id} role={role} />
                ))}
              </View>
            </InfoCard>
          ) : null}
        </View>
      </ScrollView>

      {/* Message box (founder's reference) — someone else's profile only. It
          exists so you can fire off one line and STAY here, so it is pinned
          under the scroll area rather than living inside it. Hidden while a
          block holds, with the reason stated in the neutral wording (§28). */}
      {!isSelf && !loadFailed ? (
        <View
          style={{
            backgroundColor: colors.sidebar,
            paddingHorizontal: space.md,
            paddingTop: space.sm,
            // With the keyboard up the bar rides on the IME, so adding the
            // bottom inset too would leave a nav-bar-sized gap under it.
            paddingBottom: keyboardHeight > 0 ? space.sm + keyboardHeight : space.sm + insets.bottom,
            gap: space.xs,
          }}
        >
          {blocked ? (
            <Text type="meta" tone="muted" style={{ paddingVertical: space.sm, paddingHorizontal: space.xs, fontWeight: "400" }}>
              {t("mobile:userProfile.blockedNoMessage")}
            </Text>
          ) : (
            <>
              <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space.sm }}>
                <View
                  style={{
                    flex: 1,
                    flexDirection: "row",
                    alignItems: "flex-end",
                    backgroundColor: colors.surface,
                    borderRadius: radius.cta,
                    borderCurve: "continuous",
                    paddingLeft: space.md + 2,
                    paddingRight: space.xs,
                    minHeight: 44,
                  }}
                >
                  <TextInput
                    value={draft}
                    onChangeText={setDraft}
                    placeholder={t("mobile:userProfile.messagePlaceholder", { name: user?.username ?? displayName })}
                    placeholderTextColor={colors.fgFaint}
                    maxLength={MESSAGE_MAX_LENGTH}
                    multiline
                    accessibilityLabel={t("mobile:userProfile.messagePlaceholder", { name: user?.username ?? displayName })}
                    style={{ flex: 1, color: colors.fg, fontSize: 15, lineHeight: 20, paddingVertical: space.md - 1, maxHeight: 120 }}
                  />
                  {/* The same EmojiPicker the composer opens (DRY) — it stays
                      open for consecutive picks and appends at the end. */}
                  <IconButton
                    icon={Smile}
                    size="sm"
                    label={t("mobile:userProfile.emojiA11y")}
                    onPress={() => setEmojiOpen(true)}
                    style={{ marginBottom: 6 }}
                  />
                </View>
                <IconButton
                  icon={SendHorizontal}
                  variant="accent"
                  size="md"
                  label={t("mobile:userProfile.sendMessage")}
                  onPress={onSendDraft}
                  disabled={draftEmpty || sendDmMessage.isPending}
                  style={{ marginBottom: 2 }}
                />
              </View>
              {sent ? (
                <Animated.View
                  entering={FadeIn.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
                  exiting={FadeOut.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
                >
                  <Text type="caption" tone="faint" accessibilityLiveRegion="polite" style={{ paddingHorizontal: space.sm }}>
                    {t("mobile:userProfile.messageSent")}
                  </Text>
                </Animated.View>
              ) : null}
            </>
          )}
        </View>
      ) : null}

      <AvatarLightbox visible={avatarOpen} url={user?.avatarUrl} name={displayName} onClose={() => setAvatarOpen(false)} />

      <EmojiPicker
        visible={emojiOpen}
        onSelect={(emoji) => setDraft((prev) => prev + emoji)}
        onClose={() => setEmojiOpen(false)}
      />

      {/* Unfriend / block / unblock — the consequence stated before it happens,
          the same copy the user menu shows so the two can never disagree. */}
      <ConfirmSheet
        visible={pending !== null}
        title={
          pending === "unfriend"
            ? t("mobile:userProfile.removeConfirmTitle")
            : pending === "unblock"
              ? t("mobile:block.unblockConfirmTitle", { name: displayName })
              : t("mobile:block.confirmTitle", { name: displayName })
        }
        body={
          pending === "unfriend"
            ? t("mobile:userProfile.removeConfirmBody", { name: displayName })
            : pending === "unblock"
              ? t("mobile:block.unblockConfirmBody")
              : t("mobile:block.confirmBody")
        }
        confirmLabel={
          pending === "unfriend"
            ? t("mobile:userProfile.removeFriend")
            : pending === "unblock"
              ? t("mobile:block.unblockConfirmAction")
              : t("mobile:block.confirmAction")
        }
        confirmIcon={pending === "unfriend" ? UserMinus : pending === "unblock" ? ShieldOff : ShieldBan}
        confirmVariant={pending === "unblock" ? "primary" : "danger"}
        onConfirm={confirmPending}
        cancelLabel={t("common:buttons.cancel")}
        onCancel={() => setPending(null)}
        busy={pendingBusy}
        error={pendingError}
        errorTitle={t("mobile:userProfile.actionErrorTitle")}
      >
        {pending === "block" ? (
          <Text type="meta" tone="faint" style={{ fontWeight: "400", marginTop: space.sm }}>
            {t("mobile:block.confirmNote")}
          </Text>
        ) : null}
      </ConfirmSheet>

      {/* The ⋯ menu IS the shared user menu — one component, one set of rules, so
          this button can never drift from what a long press elsewhere offers.
          `insideProfile` drops its "Profile" row: this screen is already open. */}
      <MemberActionSheet
        target={menuOpen ? menuTarget : null}
        groupId={(groupId as GroupId | undefined) ?? null}
        insideProfile
        onClose={() => setMenuOpen(false)}
      />
    </Screen>
  );
}
