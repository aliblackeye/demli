import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from "react-native";
import { Text, TextInput } from "@/components/ui/Text";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Check,
  EllipsisVertical,
  MessageSquare,
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
} from "lucide-react-native";
import { isCallLive, noteBadgeText, visibleCustomStatus } from "@demli/client-core";
import { MESSAGE_MAX_LENGTH } from "@demli/config";
import type { DmId, GroupId, ProfileFriendshipStatus, Role, UserId } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { Avatar } from "@/components/Avatar";
import { Button } from "@/components/Button";
import { EmojiPicker } from "@/components/EmojiPicker";
import { AvatarLightbox } from "@/components/member/AvatarLightbox";
import { MemberActionSheet, type MemberSheetTarget } from "@/components/member/MemberActionSheet";
import { ProfileBannerImage } from "@/components/ProfileBannerImage";
import { Screen } from "@/components/Screen";
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
import { colors, radius, space, typography } from "@/theme/theme";

const BANNER_HEIGHT = 140;
const AVATAR_SIZE = 92;

/** A section eyebrow label (uppercase, faint) shared by the info sections. */
function SectionLabel({ children }: { children: string }) {
  return (
    <Text
      style={{
        color: colors.fgFaint,
        fontSize: typography.size["2xs"],
        fontWeight: "700",
        letterSpacing: 0.6,
        textTransform: "uppercase",
      }}
    >
      {children}
    </Text>
  );
}

/** A single server-role pill, tinted by the role's color (ADR 0007). */
function RoleChip({ role }: { role: Role }) {
  const tint = role.color ?? colors.fgMuted;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.xs,
        paddingHorizontal: space.md,
        paddingVertical: space.xs,
        borderRadius: radius.pill,
        backgroundColor: colors.surfaceRaised,
        borderWidth: 1,
        borderColor: colors.stroke,
      }}
    >
      <View style={{ width: 8, height: 8, borderRadius: radius.pill, backgroundColor: tint }} />
      <Text style={{ color: colors.fg, fontSize: 13, fontWeight: "600" }}>{role.name}</Text>
    </View>
  );
}

/**
 * One icon control pinned to the banner's top-right (founder's reference).
 *
 * Icon-only, but never bare: each carries an `accessibilityLabel` naming the
 * person AND sits on its own translucent dark backdrop, because a banner can be
 * a light photo and a bare white glyph on it is unreadable. The backdrop is the
 * whole reason this is a component rather than a plain Pressable.
 */
function BannerAction({
  label,
  tone = "default",
  busy = false,
  disabled = false,
  onPress,
  children,
}: {
  label: string;
  tone?: "default" | "danger";
  busy?: boolean;
  disabled?: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || busy }}
      style={({ pressed }) => ({
        width: 34,
        height: 34,
        borderRadius: radius.pill,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: tone === "danger" ? "rgba(120,20,14,0.72)" : "rgba(0,0,0,0.5)",
        borderWidth: 1,
        borderColor: "rgba(255,255,255,0.14)",
        opacity: disabled || busy ? 0.5 : pressed ? 0.75 : 1,
      })}
    >
      {busy ? <ActivityIndicator size="small" color="#ffffff" /> : children}
    </Pressable>
  );
}

/**
 * The profile card banner (ref #5 / M15). Renders the user's uploaded banner
 * (GIF-capable) when present, otherwise the per-user deterministic gradient — the
 * SAME hue that colors their cameraless voice tile, so a person's color is
 * consistent across the app. Full-bleed at the top of the card.
 */
function ProfileBanner({ userId, bannerUrl }: { userId: string; bannerUrl?: string | null }) {
  const { t } = useAppTranslation();
  return (
    <View accessibilityLabel={t("mobile:userProfile.bannerA11y")}>
      <ProfileBannerImage bannerUrl={bannerUrl} seedId={userId} height={BANNER_HEIGHT} />
    </View>
  );
}

/**
 * One action in the top comms bar (Message / Voice / Video). Icon over a compact
 * label; dims to a clearly-disabled state when the target is not a friend
 * (matching the DM header's call-gate, ADR 0012 §3) so no button is a dead end.
 */
function ProfileAction({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => ({
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        gap: space.xs,
        paddingVertical: space.md,
        borderRadius: radius.md,
        borderCurve: "continuous",
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: colors.stroke,
        opacity: disabled ? 0.4 : pressed ? 0.8 : 1,
      })}
    >
      {icon}
      <Text numberOfLines={1} style={{ color: colors.fg, fontSize: 12, fontWeight: "600" }}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Context-aware profile screen (ADR 0010 §3), presented as a modal when a person
 * is tapped (friend row / message avatar / DM header / server member). Rich
 * layout (ref #5): a per-user gradient banner, a large overlapping avatar, a
 * Message / Voice Call / Video Call action bar (calls gated to mutual friends,
 * ADR 0012), a "Member since" card, bio, and — only when `groupId` names a server
 * both users share — that server's roles. Actions adapt to the viewer→target
 * friendship; the self card links to profile editing.
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
      return new Intl.DateTimeFormat(i18n.language, {
        year: "numeric",
        month: "long",
        day: "numeric",
      }).format(date);
    } catch {
      return date.toLocaleDateString();
    }
  }, [user?.createdAt, i18n.language]);

  // Call gate (ADR 0012 §3): only a mutual friend can be called, and never while
  // another call is live. The server re-checks; this just disables the buttons.
  const canCall = status === "friends" && !isCallLive(callState);

  const onError = (err: unknown) =>
    Alert.alert(t("mobile:userProfile.actionErrorTitle"), localizeError(err, t));

  const busy =
    sendRequest.isPending ||
    accept.isPending ||
    removeRequest.isPending ||
    unfriend.isPending ||
    openDm.isPending;

  const onMessage = () => {
    if (!userId) return;
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

  const onUnfriend = () => {
    if (!user) return;
    haptics.medium();
    Alert.alert(
      t("mobile:userProfile.removeConfirmTitle"),
      t("mobile:userProfile.removeConfirmBody", { name: user.displayName }),
      [
        { text: t("buttons.cancel"), style: "cancel" },
        {
          text: t("mobile:userProfile.removeFriend"),
          style: "destructive",
          onPress: () => unfriend.mutate(user.id, { onError }),
        },
      ],
    );
  };

  /**
   * Block / unblock from the banner icon. Confirmed rather than fired on tap:
   * this is a 34px target and a block severs the friendship and every pending
   * request — recoverable only by asking again. Same copy the user menu shows,
   * so the two entry points can never describe the action differently.
   */
  const onToggleBlock = () => {
    if (!userId) return;
    haptics.medium();
    const name = displayName;
    if (blocked) {
      Alert.alert(
        t("mobile:block.unblockConfirmTitle", { name }),
        t("mobile:block.unblockConfirmBody"),
        [
          { text: t("common:buttons.cancel"), style: "cancel" },
          {
            text: t("mobile:block.unblockConfirmAction"),
            onPress: () => unblockUser.mutate(userId as UserId, { onError }),
          },
        ],
      );
      return;
    }
    Alert.alert(
      t("mobile:block.confirmTitle", { name }),
      `${t("mobile:block.confirmBody")}

${t("mobile:block.confirmNote")}`,
      [
        { text: t("common:buttons.cancel"), style: "cancel" },
        {
          text: t("mobile:block.confirmAction"),
          style: "destructive",
          onPress: () => blockUser.mutate(userId as UserId, { onError }),
        },
      ],
    );
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
   * shares its handlers with the big button lower down (which stays the primary,
   * thumb-sized target on a phone), so the compact icon and the CTA can never
   * behave differently. `null` while the friendship is still loading: offering
   * "Add friend" to someone who is already a friend is worse than offering
   * nothing for a beat.
   */
  const relationshipAction: ReactNode = ((): ReactNode => {
    if (!userId || profile.isPending) return null;
    switch (status) {
      case "friends":
        return (
          <BannerAction
            label={t("mobile:userProfile.removeFriendA11y", { name: displayName })}
            tone="danger"
            busy={unfriend.isPending}
            disabled={busy}
            onPress={onUnfriend}
          >
            <UserMinus size={17} color="#ffffff" />
          </BannerAction>
        );
      case "none":
        return (
          <BannerAction
            label={t("mobile:userProfile.addFriendA11y", { name: displayName })}
            busy={sendRequest.isPending}
            disabled={busy}
            onPress={() => sendRequest.mutate({ userId }, { onError })}
          >
            <UserPlus size={17} color="#ffffff" />
          </BannerAction>
        );
      case "outgoing":
        return (
          <BannerAction
            label={t("mobile:userProfile.cancelRequestA11y", { name: displayName })}
            busy={removeRequest.isPending}
            disabled={busy}
            onPress={() => removeRequest.mutate(userId, { onError })}
          >
            <UserRoundX size={17} color="#ffffff" />
          </BannerAction>
        );
      case "incoming":
        return (
          <BannerAction
            label={t("mobile:userProfile.acceptRequestA11y", { name: displayName })}
            busy={accept.isPending}
            disabled={busy}
            onPress={() => accept.mutate(userId, { onError })}
          >
            <Check size={17} color="#ffffff" />
          </BannerAction>
        );
      default:
        return null;
    }
  })();

  return (
    <Screen>
      <Stack.Screen options={{ title: displayName }} />
      <ScrollView
        contentContainerStyle={{ paddingBottom: space.xl + insets.bottom }}
        refreshControl={
          isSelf ? undefined : (
            <RefreshControl
              refreshing={profile.isRefetching}
              onRefresh={() => void profile.refetch()}
              tintColor={colors.fgMuted}
              colors={[colors.accent]}
            />
          )
        }
      >
        {userId ? (
          <View>
            <ProfileBanner userId={userId} bannerUrl={user?.bannerUrl} />
            {/* Relationship controls, pinned to the banner's top-right. Exactly
                ONE friendship control at a time — "add friend" and "remove
                friend" are the same slot in two states, never both — plus the
                block toggle and the ⋯ menu. None render on your own card: you
                cannot friend or block yourself and the API rejects both (§35). */}
            <View
              style={{
                position: "absolute",
                top: space.sm,
                right: space.md,
                flexDirection: "row",
                alignItems: "center",
                gap: space.xs,
              }}
            >
              {!isSelf && !blocked ? relationshipAction : null}
              {!isSelf ? (
                <BannerAction
                  label={
                    blocked
                      ? t("mobile:block.unblockA11y", { name: displayName })
                      : t("mobile:block.blockA11y", { name: displayName })
                  }
                  tone={blocked ? "default" : "danger"}
                  busy={blockUser.isPending || unblockUser.isPending}
                  onPress={onToggleBlock}
                >
                  {blocked ? (
                    <ShieldOff size={17} color="#ffffff" />
                  ) : (
                    <ShieldBan size={17} color="#ffffff" />
                  )}
                </BannerAction>
              ) : null}
              <BannerAction
                label={t("mobile:userProfile.moreActionsA11y", { name: displayName })}
                onPress={() => setMenuOpen(true)}
              >
                <EllipsisVertical size={17} color="#ffffff" />
              </BannerAction>
            </View>
          </View>
        ) : null}

        {/* Identity — large avatar overlapping the banner, name + @username. */}
        <View style={{ paddingHorizontal: space.lg, marginTop: -(AVATAR_SIZE / 2) }}>
          <Pressable
            // Founder: pressing the avatar opens it big and you can move around
            // inside it. Always pressable, even without a photo, so the gesture
            // is the same for everyone in the roster.
            onPress={() => setAvatarOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={t("mobile:userProfile.viewAvatar", { name: displayName })}
            style={({ pressed }) => ({
              alignSelf: "flex-start",
              borderRadius: radius.pill,
              backgroundColor: colors.app,
              padding: 4,
              opacity: pressed ? 0.85 : 1,
            })}
          >
            <Avatar
              name={displayName}
              size={AVATAR_SIZE}
              uri={user?.avatarUrl}
              presence={isSelf ? "online" : presence}
            />
          </Pressable>
          <View style={{ marginTop: space.sm, gap: 2 }}>
            {/* Name + the viewer's private note in parentheses. The note is a
                quieter, smaller aside so the NAME still reads as the heading;
                it is clipped to one line and capped so a long note can never
                push the identity block around. */}
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
              <Text
                variant="display"
                numberOfLines={1}
                style={{ flexShrink: 1, color: colors.fg, fontSize: 22, fontWeight: "800" }}
              >
                {displayName}
              </Text>
              {noteBadge ? (
                <Text
                  numberOfLines={1}
                  accessibilityLabel={`(${noteBadge}) ${t("mobile:userMenu.onlyVisibleToYou")}`}
                  style={{
                    flexShrink: 0,
                    maxWidth: "45%",
                    color: colors.fgFaint,
                    fontSize: 14,
                    fontWeight: "600",
                  }}
                >
                  ({noteBadge})
                </Text>
              ) : null}
            </View>
            {user?.username ? (
              <Text style={{ color: colors.fgMuted, fontSize: 14 }}>@{user.username}</Text>
            ) : null}
            {/* Custom status (M18). PLAIN TEXT as a JSX child — RN escapes it —
                and deliberately NOT run through the markdown renderer: a status
                line must not be able to inject formatting or links (§28). */}
            {customStatus ? (
              <Text style={{ color: colors.fg, fontSize: 13, lineHeight: 18, opacity: 0.8, marginTop: 2 }}>
                {customStatus}
              </Text>
            ) : null}
          </View>
        </View>

        <View style={{ paddingHorizontal: space.lg, paddingTop: space.lg, gap: space.lg }}>
          {/* Action area — adapts to the viewer→target relationship. */}
          {isSelf ? (
            <Button label={t("mobile:userProfile.editProfile")} onPress={() => router.push("/profile")} />
          ) : loadFailed ? (
            <View
              style={{
                gap: space.sm,
                padding: space.lg,
                borderRadius: radius.md,
                borderCurve: "continuous",
                backgroundColor: colors.surface,
                borderWidth: 1,
                borderColor: colors.stroke,
              }}
            >
              <Text style={{ color: colors.fg, fontSize: 15, fontWeight: "700" }}>
                {t("mobile:userProfile.loadErrorTitle")}
              </Text>
              <Text style={{ color: colors.fgMuted, fontSize: 13, lineHeight: 19 }}>
                {t("mobile:userProfile.loadErrorBody")}
              </Text>
              <Button
                label={t("buttons.retry")}
                variant="ghost"
                onPress={() => void profile.refetch()}
                loading={profile.isFetching}
              />
            </View>
          ) : (
            <>
              {profile.isPending ? <ActivityIndicator color={colors.fgFaint} /> : null}

              {/* Comms bar (ref #5). Message needs friendship; calls also need no
                  live call. Disabled buttons are visibly dimmed, never dead.
                  A block hides the strip entirely: every one of these is refused
                  server-side while it holds, so dimming them would just be three
                  dead controls (§35). */}
              {blocked ? null : (
              <View style={{ flexDirection: "row", gap: space.sm }}>
                <ProfileAction
                  icon={
                    <MessageSquare
                      size={20}
                      color={status === "friends" ? colors.accent : colors.fgMuted}
                    />
                  }
                  label={t("mobile:friends.message")}
                  onPress={onMessage}
                  disabled={status !== "friends" || busy}
                />
                <ProfileAction
                  icon={<Phone size={20} color={canCall ? colors.accent : colors.fgMuted} />}
                  label={t("mobile:call.voiceCall")}
                  onPress={() => startCall("audio")}
                  disabled={!canCall || busy}
                />
                <ProfileAction
                  icon={<Video size={20} color={canCall ? colors.accent : colors.fgMuted} />}
                  label={t("mobile:call.videoCall")}
                  onPress={() => startCall("video")}
                  disabled={!canCall || busy}
                />
              </View>
              )}

              {/* Blocked: say what changed, in the neutral wording the API's own
                  one-sided model requires — never who blocked whom (§28). */}
              {blocked ? (
                <View
                  style={{
                    gap: space.xs,
                    padding: space.lg,
                    borderRadius: radius.md,
                    borderCurve: "continuous",
                    backgroundColor: colors.dangerSurface,
                  }}
                >
                  <Text style={{ color: colors.danger, fontSize: 14, fontWeight: "700" }}>
                    {t("mobile:block.blocked")}
                  </Text>
                  <Text style={{ color: colors.fgMuted, fontSize: 13, lineHeight: 18 }}>
                    {t("mobile:block.blockedNote")}
                  </Text>
                </View>
              ) : null}

              {/* Relationship action — the primary CTA for this friendship state.
                  Hidden while a block holds: friending is refused server-side, and
                  unblocking (banner icon / menu) is the way forward. */}
              {blocked ? null : status === "friends" ? (
                <Button
                  label={t("mobile:userProfile.removeFriend")}
                  variant="danger"
                  onPress={onUnfriend}
                  disabled={busy}
                >
                  <UserMinus size={17} color={colors.danger} />
                </Button>
              ) : status === "incoming" ? (
                <View style={{ flexDirection: "row", gap: space.sm }}>
                  <View style={{ flex: 1 }}>
                    <Button
                      label={t("mobile:friends.accept")}
                      onPress={() => userId && accept.mutate(userId, { onError })}
                      loading={accept.isPending}
                      disabled={busy}
                    >
                      <Check size={17} color={colors.onAccent} />
                    </Button>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Button
                      label={t("mobile:friends.decline")}
                      variant="danger"
                      onPress={() => userId && removeRequest.mutate(userId, { onError })}
                      disabled={busy}
                    >
                      <X size={17} color={colors.danger} />
                    </Button>
                  </View>
                </View>
              ) : status === "outgoing" ? (
                <Button
                  label={t("mobile:friends.cancelRequest")}
                  variant="ghost"
                  onPress={() => userId && removeRequest.mutate(userId, { onError })}
                  disabled={busy}
                >
                  <X size={17} color={colors.fg} />
                </Button>
              ) : (
                <Button
                  label={t("mobile:friends.addFriend")}
                  onPress={() => userId && sendRequest.mutate({ userId }, { onError })}
                  loading={sendRequest.isPending}
                  disabled={busy}
                >
                  <UserPlus size={17} color={colors.onAccent} />
                </Button>
              )}
            </>
          )}

          {/* Member since (ref #5) — shown whenever we have the durable record. */}
          {memberSince ? (
            <View
              style={{
                gap: space.xs,
                padding: space.lg,
                borderRadius: radius.md,
                borderCurve: "continuous",
                backgroundColor: colors.surface,
                borderWidth: 1,
                borderColor: colors.stroke,
              }}
            >
              <SectionLabel>{t("mobile:userProfile.memberSince")}</SectionLabel>
              <Text style={{ color: colors.fg, fontSize: 15, fontWeight: "600" }}>{memberSince}</Text>
            </View>
          ) : null}

          {bio ? (
            <View style={{ gap: space.xs }}>
              <SectionLabel>{t("mobile:userProfile.aboutLabel")}</SectionLabel>
              <Text selectable style={{ color: colors.fg, fontSize: 15, lineHeight: 21 }}>
                {bio}
              </Text>
            </View>
          ) : null}

          {roles.length > 0 ? (
            <View style={{ gap: space.sm }}>
              <SectionLabel>{t("mobile:userProfile.rolesLabel")}</SectionLabel>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                {roles.map((role) => (
                  <RoleChip key={role.id} role={role} />
                ))}
              </View>
            </View>
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
            borderTopWidth: 1,
            borderTopColor: colors.stroke,
            backgroundColor: colors.surface,
            paddingHorizontal: space.lg,
            paddingTop: space.md,
            // With the keyboard up the bar rides on the IME, so adding the
            // bottom inset too would leave a nav-bar-sized gap under it.
            paddingBottom: keyboardHeight > 0 ? space.md + keyboardHeight : space.md + insets.bottom,
            gap: space.xs,
          }}
        >
            {blocked ? (
              <Text style={{ color: colors.fgMuted, fontSize: 13, lineHeight: 18 }}>
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
                      gap: space.xs,
                      backgroundColor: colors.surfaceRaised,
                      borderColor: colors.stroke,
                      borderWidth: 1,
                      borderRadius: radius.md,
                      borderCurve: "continuous",
                      paddingHorizontal: space.md,
                    }}
                  >
                    <TextInput
                      value={draft}
                      onChangeText={setDraft}
                      placeholder={t("mobile:userProfile.messagePlaceholder", {
                        name: user?.username ?? displayName,
                      })}
                      placeholderTextColor={colors.fgFaint}
                      maxLength={MESSAGE_MAX_LENGTH}
                      multiline
                      style={{
                        flex: 1,
                        color: colors.fg,
                        fontSize: 15,
                        paddingVertical: space.md,
                        maxHeight: 120,
                      }}
                    />
                    {/* The same EmojiPicker the composer opens (DRY) — it stays
                        open for consecutive picks and appends at the end. */}
                    <Pressable
                      onPress={() => setEmojiOpen(true)}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={t("mobile:userProfile.emojiA11y")}
                      style={({ pressed }) => ({
                        paddingBottom: space.md,
                        opacity: pressed ? 0.6 : 1,
                      })}
                    >
                      <Smile size={20} color={colors.fgMuted} />
                    </Pressable>
                  </View>
                  <Pressable
                    onPress={onSendDraft}
                    disabled={draft.trim().length === 0 || sendDmMessage.isPending}
                    accessibilityRole="button"
                    accessibilityLabel={t("mobile:userProfile.sendMessage")}
                    accessibilityState={{
                      disabled: draft.trim().length === 0 || sendDmMessage.isPending,
                    }}
                    style={({ pressed }) => ({
                      width: 46,
                      height: 46,
                      borderRadius: radius.md,
                      borderCurve: "continuous",
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: colors.accent,
                      opacity:
                        draft.trim().length === 0 || sendDmMessage.isPending
                          ? 0.4
                          : pressed
                            ? 0.85
                            : 1,
                    })}
                  >
                    {sendDmMessage.isPending ? (
                      <ActivityIndicator size="small" color={colors.onAccent} />
                    ) : (
                      <SendHorizontal size={20} color={colors.onAccent} />
                    )}
                  </Pressable>
                </View>
                {sent ? (
                  <Text style={{ color: colors.fgFaint, fontSize: typography.size["2xs"] }}>
                    {t("mobile:userProfile.messageSent")}
                  </Text>
                ) : null}
              </>
            )}
        </View>
      ) : null}

      <AvatarLightbox
        visible={avatarOpen}
        url={user?.avatarUrl}
        name={displayName}
        onClose={() => setAvatarOpen(false)}
      />

      <EmojiPicker
        visible={emojiOpen}
        onSelect={(emoji) => setDraft((prev) => prev + emoji)}
        onClose={() => setEmojiOpen(false)}
      />

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
