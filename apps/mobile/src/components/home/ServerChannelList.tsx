import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { Text } from "../ui/Text";
import { router } from "expo-router";
import {
  BellOff,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  Hash,
  MessageSquare,
  MoreVertical,
  Pencil,
  Plus,
  Volume2,
} from "lucide-react-native";
import {
  buildSidebarBuckets,
  canNudgeCategory,
  canNudgeChannel,
  channelMoveDestinations,
  moveChannel,
  nudgeCategory,
  nudgeChannel,
  toReorderPayload,
  unreadBadgeText,
  visibleCustomStatus,
  type SidebarBucket,
} from "@demli/client-core";
import { useAppTranslation } from "@/lib/i18n";
import {
  PERMISSIONS,
  type CategoryId,
  type Channel,
  type ChannelId,
  type GroupId,
} from "@demli/types";
import { UnreadCountBadge } from "@/components/home/UnreadCountBadge";
import { Avatar } from "@/components/Avatar";
import {
  CategoryActionSheet,
  type CategorySheetTarget,
} from "@/components/home/CategoryActionSheet";
import {
  ChannelMoveSheet,
  type ChannelMoveTarget,
} from "@/components/home/ChannelMoveSheet";
import {
  ChannelActionSheet,
  type ChannelSheetTarget,
} from "@/components/home/ChannelActionSheet";
import { MemberActionSheet, type MemberSheetTarget } from "@/components/member/MemberActionSheet";
import { EmptyState } from "@/components/EmptyState";
import { localizeError } from "@/lib/errors";
import { NotificationMuteSheet, type MuteTarget } from "@/components/NotificationMuteSheet";
import { Row } from "@/components/Row";
import { SkeletonChannelRows } from "@/components/Skeleton";
import {
  VOICE_READ_INTENT,
  voiceRowTapIntent,
  type VoiceScreenIntent,
} from "@/components/voice/voice-channel-nav";
import { VoiceChannelOccupants } from "@/components/voice/VoiceChannelOccupants";
import { buildMemberColorMap } from "@/lib/permissions";
import {
  useCategories,
  useDeleteCategory,
  useGroupDetails,
  useReorderChannels,
  useRoles,
  useServerPermissions,
} from "@/queries/chat-queries";
import { useAuthStore } from "@/stores/auth-store";
import {
  useCollapsedCategoryIds,
  useCollapsedCategoriesStore,
} from "@/stores/collapsed-categories-store";
import { effectiveChannelMuteMode, useChatStore } from "@/stores/chat-store";
import { hasDraft } from "@/stores/draft-model";
import { useDraftStore } from "@/stores/draft-store";
import { useVoiceStore } from "@/stores/voice-store";
import { colors, radius, space } from "@/theme/theme";

/* Layout constants — one compact rhythm for every row in this list.
   A channel is ONE line (icon + name + indicators) at a 44px tap
   target, so text and voice channels share the exact same height and the voice
   occupants read as a tight cluster under their channel (founder finding,
   2026-07-21). */

/** Outer gutter of the list body. */
const LIST_GUTTER = space.md;
/** Inner horizontal padding of a row card. Must stay in lockstep with
 *  `OCCUPANT_INDENT` in VoiceChannelOccupants so occupants line up under the
 *  channel title. */
const ROW_INSET = space.lg;
/** Section labels + member rows start where the row CONTENT starts, not where
 *  the card starts — otherwise every heading sits 16px left of its own list. */
const CONTENT_INSET = LIST_GUTTER + ROW_INSET;
/** Minimum row height — the a11y tap target and the list's visual rhythm. */
const ROW_HEIGHT = 44;

function SectionLabel({ children }: { children: string }) {
  return (
    <Text
      style={{
        color: colors.fgMuted,
        fontSize: 12,
        fontWeight: "700",
        letterSpacing: 0.6,
        textTransform: "uppercase",
        paddingHorizontal: CONTENT_INSET,
        paddingTop: space.lg,
        paddingBottom: space.xs,
      }}
    >
      {children}
    </Text>
  );
}

/**
 * Channel row with independent trailing targets (each its own Pressable): the
 * M20 "read this voice channel without joining" control and the owner-only edit
 * target. Single-line by design: no description/subtitle, so text and voice
 * channels are the same {@link ROW_HEIGHT}, so the list scans as one column.
 */
function ChannelRow({
  leading,
  title,
  nsfw,
  unread,
  unreadCount = 0,
  muted,
  hasDraft: hasDraftIndicator,
  onOpen,
  onLongPress,
  onOpenChat,
  onEdit,
}: {
  leading: ReactNode;
  title: string;
  /** Age-restricted (18+) text channel — shows an "18+" pill (M15). */
  nsfw?: boolean;
  unread?: boolean;
  /** Counted unread total (#110); 0/absent with `unread` falls back to "1+". */
  unreadCount?: number;
  muted?: boolean;
  hasDraft?: boolean;
  onOpen: () => void;
  onLongPress?: () => void;
  /**
   * VOICE rows only: open this channel's chat WITHOUT connecting. Its own
   * always-visible ≥44pt target, because the row's tap CONNECTS you and there
   * is no hover on a phone — a control revealed by hover, as
   * on desktop's fine pointer, would simply not exist here.
   */
  onOpenChat?: () => void;
  onEdit?: () => void;
}) {
  const { t } = useAppTranslation();
  const badgeText = unread ? unreadBadgeText(unreadCount, true) : null;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        minHeight: ROW_HEIGHT,
        backgroundColor: colors.surface,
        borderRadius: radius.md,
        borderCurve: "continuous",
        opacity: muted ? 0.55 : 1,
      }}
    >
      <Pressable
        onPress={onOpen}
        onLongPress={onLongPress}
        style={({ pressed }) => ({
          flex: 1,
          flexDirection: "row",
          alignItems: "center",
          minHeight: ROW_HEIGHT,
          gap: space.md,
          paddingHorizontal: ROW_INSET,
          paddingVertical: space.sm,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        {leading}
        <Text
          numberOfLines={1}
          style={{ flex: 1, color: colors.fg, fontSize: 15, fontWeight: unread ? "800" : "600" }}
        >
          {title}
        </Text>
        {nsfw ? (
          <View
            accessibilityLabel={t("mobile:channel.nsfw")}
            style={{
              paddingHorizontal: space.xs,
              paddingVertical: 1,
              borderRadius: radius.sm,
              backgroundColor: colors.dangerSurface,
            }}
          >
            <Text style={{ color: colors.danger, fontSize: 10, fontWeight: "800" }}>18+</Text>
          </View>
        ) : null}
        {hasDraftIndicator ? (
          <Pencil size={13} color={colors.fgFaint} accessibilityLabel={t("mobile:group.hasDraftA11y")} />
        ) : null}
        {muted ? (
          <BellOff size={15} color={colors.fgFaint} accessibilityLabel={t("mobile:mute.muted")} />
        ) : null}
        {badgeText ? (
          <UnreadCountBadge text={badgeText} a11yLabel={t("mobile:group.unreadA11y")} />
        ) : null}
      </Pressable>
      {onOpenChat ? (
        <Pressable
          onPress={onOpenChat}
          hitSlop={4}
          accessibilityRole="button"
          accessibilityLabel={t("mobile:channel.openChatWithoutJoining")}
          style={({ pressed }) => ({
            minWidth: 44,
            minHeight: ROW_HEIGHT,
            alignItems: "center",
            justifyContent: "center",
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <MessageSquare size={18} color={colors.fgMuted} />
        </Pressable>
      ) : null}
      {onEdit ? (
        <Pressable
          onPress={onEdit}
          hitSlop={8}
          accessibilityLabel={t("mobile:group.editChannel", { name: title })}
          style={{ paddingHorizontal: space.md, paddingVertical: space.md }}
        >
          <Pencil size={18} color={colors.fgMuted} />
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * The channels + members body for ONE server — extracted from the
 * `group/[groupId]` route so the Home shell's server PANEL and the full-screen
 * group route render the SAME list (no copy-paste divergence, CLAUDE.md §23).
 *
 * It renders only the scrollable body; the header (server name + invite / the
 * overflow menu) belongs to the caller — a native Stack header on the
 * full-screen route, an in-panel header inside the shell. Membership actions
 * (leaving) live in {@link ServerActionsSheet} behind that header, never inline
 * in this body. Navigation targets (a text channel, the voice join sheet, a
 * member profile) are unchanged, so every notification deep link into
 * `channel/[channelId]` / `voice/[channelId]` still lands the same way.
 */
export function ServerChannelList({
  groupId,
  contentBottomPadding,
}: {
  groupId: string;
  /** Bottom padding for the scroll content (caller adds tab-bar/safe-area clearance). */
  contentBottomPadding: number;
}) {
  const { t } = useAppTranslation();
  const { data, isLoading, refetch, isRefetching } = useGroupDetails(groupId);
  const { data: roles } = useRoles(groupId);
  const presence = useChatStore((s) => s.presence);
  // Custom status lines (M18), live off the presence stream. Same whole-map slice
  // as `presence` right above — the roster already re-renders on a presence tick,
  // so this adds no new render trigger.
  const customStatuses = useChatStore((s) => s.customStatuses);
  const unreadChannelIds = useChatStore((s) => s.unreadChannelIds);
  const unreadCounts = useChatStore((s) => s.unreadCounts);
  const mentionUnreadChannelIds = useChatStore((s) => s.mentionUnreadChannelIds);
  const notificationMutes = useChatStore((s) => s.notificationMutes);
  const drafts = useDraftStore((s) => s.drafts);
  const me = useAuthStore((s) => s.user);

  /** The channel row whose long-press menu is open, or null. */
  const [channelTarget, setChannelTarget] = useState<ChannelSheetTarget | null>(null);
  const [muteTarget, setMuteTarget] = useState<MuteTarget | null>(null);
  /** The roster row whose USER menu is open (long press), or null. */
  const [memberTarget, setMemberTarget] = useState<MemberSheetTarget | null>(null);
  /** The category header whose manage menu is open, or null (M18). */
  const [categoryTarget, setCategoryTarget] = useState<CategorySheetTarget | null>(null);
  /** The channel whose "move to category" picker is open, or null (M18). */
  const [moveTarget, setMoveTarget] = useState<ChannelMoveTarget | null>(null);
  /**
   * A reorder the server refused. Shown above the list and cleared on the next
   * attempt — the list itself already snapped back to server truth (the mutation
   * re-reads on settle), so without this line the tap would look like a no-op.
   */
  const [reorderFailed, setReorderFailed] = useState(false);

  const channels: Channel[] = [...(data?.channels ?? [])].sort((a, b) => a.position - b.position);
  const members = data?.members ?? [];
  const isOwner = !!data?.group && !!me && data.group.ownerId === me.id;

  const { can } = useServerPermissions(groupId);
  const canManageChannels = isOwner || can(PERMISSIONS.MANAGE_CHANNELS);

  // --- M18 categories -------------------------------------------------------
  const { data: categories } = useCategories(groupId as GroupId);
  const deleteCategory = useDeleteCategory(groupId as GroupId);
  const reorderChannels = useReorderChannels(groupId as GroupId);
  const collapsedIds = useCollapsedCategoryIds(groupId);
  const toggleCollapsed = useCollapsedCategoriesStore((s) => s.toggle);

  /**
   * The sidebar model, from the SHARED rule: the uncategorized bucket is always
   * first, categories follow in server order, and a channel whose category went
   * missing falls back to the top instead of vanishing. Desktop, web and this
   * list all read the one implementation (@demli/client-core), so the three
   * cannot disagree about where a channel belongs.
   */
  // Derived every render rather than memoized, exactly like the channel sort
  // above it: bucketing a server's handful of channels costs the same as that
  // sort, and a memo keyed on a freshly-built array would never hit anyway.
  const buckets = buildSidebarBuckets(channels, categories ?? []);
  const categoryIds = buckets.flatMap((b) => (b.category ? [b.category.id] : []));
  const uncategorized = buckets.find((b) => b.category === null);
  const textChannels = (uncategorized?.channels ?? []).filter((c) => c.kind === "text");
  const voiceChannels = (uncategorized?.channels ?? []).filter((c) => c.kind === "voice");

  const memberColors = useMemo(() => buildMemberColorMap(members, roles), [members, roles]);

  const openChannelSettings = (channel: Channel) =>
    router.push({
      pathname: "/channel-settings",
      params: { channelId: channel.id, groupId: channel.groupId },
    });

  const openTextChannel = (channel: Channel) =>
    router.push({
      pathname: "/channel/[channelId]",
      params: { channelId: channel.id, groupId: channel.groupId, name: channel.name },
    });

  /**
   * Open a voice channel's screen with an explicit intent — connect me to the
   * room, or just show me its chat. One navigation for both, because a voice
   * channel is ONE place with two views (see components/voice/voice-channel-nav).
   */
  const openVoiceChannel = (channel: Channel, intent: VoiceScreenIntent) =>
    router.push({
      pathname: "/voice/[channelId]",
      params: {
        channelId: channel.id,
        groupId: channel.groupId,
        name: channel.name,
        intent,
      },
    });

  /**
   * The PRIMARY gesture on a voice row: a tap CONNECTS you and lands you in the
   * room — the founder's most-used voice gesture. The one
   * exception is the room you are already in, where it only opens that room's
   * chat: no rejoin, no room switch, no voice FSM transition.
   *
   * The decision belongs to the shared rule (`voiceRowTapIntent` →
   * `voiceRowClickAction` in @demli/client-core), read imperatively against
   * the engine at tap time — so desktop and mobile cannot drift, and the row does
   * not subscribe to voice state just to know what its own tap means (§27).
   */
  const activateVoiceChannel = (channel: Channel) => {
    const voice = useVoiceStore.getState();
    openVoiceChannel(
      channel,
      // The engine's `roomId` is the media FSM's opaque room string (§11); it is
      // a channel id here, which is exactly what makes the comparison meaningful.
      voiceRowTapIntent(channel.id, {
        voiceRoomId: voice.roomId as ChannelId | null,
        voiceStatus: voice.status,
      }),
    );
  };

  /** Open a channel's conversation, touching no media state. Either kind. */
  const openChannelChat = (channel: Channel) =>
    channel.kind === "voice"
      ? openVoiceChannel(channel, VOICE_READ_INTENT)
      : openTextChannel(channel);

  const openChannelMenu = (channel: Channel) =>
    setChannelTarget({
      channelId: channel.id,
      name: channel.name,
      kind: channel.kind,
      // Snapshot the placement facts at open time — the shared rule turns these
      // into the entries the menu may show.
      placement: {
        canManageChannels,
        canMoveUp: canNudgeChannel(buckets, channel.id, "up"),
        canMoveDown: canNudgeChannel(buckets, channel.id, "down"),
        hasOtherBuckets: channelMoveDestinations(buckets, channel.id).length > 0,
      },
    });

  // --- M18 placement --------------------------------------------------------

  /**
   * Post a reorder built by the SHARED payload builder.
   *
   * `toReorderPayload` returns null when nothing actually moved, which is how a
   * no-op gesture avoids a pointless request; and when something did move it
   * lists every touched bucket IN FULL, because the server renumbers positions
   * densely from 0 over exactly the ids it was given — a partial bucket would
   * collide the moved channel with neighbours nobody touched.
   */
  const commitReorder = (next: readonly SidebarBucket[], nextCategoryIds: readonly CategoryId[]) => {
    const payload = toReorderPayload({
      previousBuckets: buckets,
      nextBuckets: next,
      previousCategoryIds: categoryIds,
      nextCategoryIds,
    });
    if (!payload) return;
    setReorderFailed(false);
    reorderChannels.mutate(payload, {
      // The mutation re-reads server truth on settle either way, so a failure
      // needs no manual rollback — only an admission that it failed.
      onError: () => setReorderFailed(true),
    });
  };

  const moveChannelSlot = (channelId: ChannelId, direction: "up" | "down") =>
    commitReorder(nudgeChannel(buckets, channelId, direction), categoryIds);

  const moveChannelToCategory = (channelId: ChannelId, categoryId: CategoryId | null) =>
    commitReorder(
      // Append to the destination: a phone picker chooses a category, not a slot
      // within it, so the channel lands at the end and can be nudged from there.
      moveChannel(buckets, channelId, { categoryId, beforeChannelId: null }),
      categoryIds,
    );

  const moveCategorySlot = (categoryId: CategoryId, direction: "up" | "down") =>
    commitReorder(buckets, nudgeCategory(categoryIds, categoryId, direction));

  const openCategoryMenu = (bucket: SidebarBucket) => {
    const category = bucket.category;
    if (!category) return;
    setCategoryTarget({
      categoryId: category.id,
      name: category.name,
      canMoveUp: canNudgeCategory(categoryIds, category.id, "up"),
      canMoveDown: canNudgeCategory(categoryIds, category.id, "down"),
    });
  };

  const openCategoryEditor = (category?: { id: CategoryId; name: string }) =>
    router.push({
      pathname: "/category-editor",
      params: category
        ? { groupId, categoryId: category.id, name: category.name }
        : { groupId },
    });

  const openNewChannel = (categoryId?: CategoryId) =>
    router.push({
      pathname: "/new-channel",
      params: categoryId ? { groupId, categoryId } : { groupId },
    });

  /**
   * Deleting a category is a yes/no question, so it is an Alert at the point of
   * action rather than a form screen — the same shape the group chat's delete
   * uses. The body states the part users fear: the CHANNELS survive.
   */
  const confirmDeleteCategory = (target: CategorySheetTarget) =>
    Alert.alert(
      t("mobile:category.deleteTitle", { name: target.name }),
      t("mobile:category.deleteBody"),
      [
        { text: t("buttons.cancel"), style: "cancel" },
        {
          text: t("mobile:category.deleteConfirm"),
          style: "destructive",
          onPress: () =>
            deleteCategory.mutate(target.categoryId, {
              onError: (err) =>
                Alert.alert(t("mobile:category.deleteFailed"), localizeError(err, t)),
            }),
        },
      ],
    );

  /** Resolve a sheet target back to its channel record (for navigation). */
  const channelById = (channelId: ChannelId): Channel | null =>
    channels.find((c) => c.id === channelId) ?? null;

  /**
   * ONE renderer for every channel row, whatever bucket it sits in.
   *
   * Categories (M18) mean a channel can now appear under the uncategorized
   * heading or under a category, and a second copy of this JSX is how the two
   * would drift — a voice row inside a category quietly losing its unread pip or
   * its read-without-joining target. Both kinds are handled here so a text and a
   * voice row stay the same height and carry the same signals (M20).
   */
  const renderChannelRow = (channel: Channel): ReactNode => {
    // Identical unread treatment for both kinds (M20): a voice channel has a real
    // conversation, so it earns a real pip/count and the same mute precedence.
    const muteMode = effectiveChannelMuteMode(notificationMutes, channel.id, groupId);
    const rawUnread = !!unreadChannelIds[channel.id];
    const showUnread =
      muteMode === null
        ? rawUnread
        : muteMode === "mentions"
          ? !!mentionUnreadChannelIds[channel.id]
          : false;
    const isVoice = channel.kind === "voice";

    return (
      <View key={channel.id} style={{ gap: space.xs }}>
        <ChannelRow
          leading={
            isVoice ? (
              <Volume2 size={20} color={colors.fgMuted} />
            ) : (
              <Hash size={20} color={colors.fgMuted} />
            )
          }
          title={channel.name}
          nsfw={channel.nsfw}
          unread={showUnread}
          unreadCount={unreadCounts[channel.id] ?? 0}
          muted={muteMode !== null}
          hasDraft={hasDraft(drafts, channel.id)}
          onOpen={
            isVoice ? () => activateVoiceChannel(channel) : () => openTextChannel(channel)
          }
          onLongPress={() => openChannelMenu(channel)}
          onOpenChat={
            isVoice ? () => openVoiceChannel(channel, VOICE_READ_INTENT) : undefined
          }
          onEdit={canManageChannels ? () => openChannelSettings(channel) : undefined}
        />
        {isVoice ? <VoiceChannelOccupants channelId={channel.id} /> : null}
      </View>
    );
  };

  /**
   * A category heading: the collapse toggle takes the whole width so the easiest
   * thing to hit is the harmless one, and the manage menu is its own ≥44pt target
   * beside it — rendered only for someone who may actually manage channels, so a
   * plain member sees a heading and nothing else (§35).
   */
  const renderCategoryHeader = (bucket: SidebarBucket): ReactNode => {
    const category = bucket.category;
    if (!category) return null;
    const collapsed = collapsedIds.includes(category.id);

    return (
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: LIST_GUTTER,
          paddingTop: space.lg,
        }}
      >
        <Pressable
          onPress={() => toggleCollapsed(groupId, category.id)}
          accessibilityRole="button"
          accessibilityState={{ expanded: !collapsed }}
          accessibilityLabel={
            collapsed
              ? t("mobile:category.expandA11y", { name: category.name })
              : t("mobile:category.collapseA11y", { name: category.name })
          }
          style={({ pressed }) => ({
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            gap: space.xs,
            minHeight: 44,
            paddingRight: space.sm,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          {collapsed ? (
            <ChevronRight size={14} color={colors.fgFaint} />
          ) : (
            <ChevronDown size={14} color={colors.fgFaint} />
          )}
          <Text
            numberOfLines={1}
            style={{
              flex: 1,
              color: colors.fgMuted,
              fontSize: 12,
              fontWeight: "700",
              letterSpacing: 0.6,
              textTransform: "uppercase",
            }}
          >
            {category.name}
          </Text>
        </Pressable>

        {canManageChannels ? (
          <Pressable
            onPress={() => openCategoryMenu(bucket)}
            accessibilityRole="button"
            accessibilityLabel={t("mobile:category.manageA11y", { name: category.name })}
            hitSlop={4}
            style={({ pressed }) => ({
              minWidth: 44,
              minHeight: 44,
              alignItems: "center",
              justifyContent: "center",
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <MoreVertical size={18} color={colors.fgMuted} />
          </Pressable>
        ) : null}
      </View>
    );
  };

  if (isLoading && !data) {
    return (
      <View style={{ paddingTop: space.md }}>
        <SkeletonChannelRows count={6} />
      </View>
    );
  }

  return (
    <>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: contentBottomPadding, gap: space.xs }}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={() => void refetch()}
            tintColor={colors.fgMuted}
            colors={[colors.accent]}
          />
        }
      >
        {/* A reorder the server refused. The list already snapped back, so this
            is the only thing telling the user the tap did not take. */}
        {reorderFailed ? (
          <Text
            accessibilityRole="alert"
            style={{
              color: colors.danger,
              fontSize: 12,
              lineHeight: 16,
              paddingHorizontal: CONTENT_INSET,
              paddingTop: space.sm,
            }}
          >
            {t("mobile:category.reorderFailed")}
          </Text>
        ) : null}

        {/* The UNCATEGORIZED bucket, always first — a pre-M18 server is entirely
            this, and it keeps its Text/Voice split so nothing about the familiar
            list changed for servers that never make a category. */}
        <SectionLabel>{t("mobile:group.textChannels")}</SectionLabel>
        {textChannels.length === 0 ? (
          <EmptyState
            icon={<Hash size={22} color={colors.fgMuted} />}
            title={t("mobile:group.noTextChannelsTitle")}
            subtitle={t("mobile:group.noTextChannelsSubtitle")}
          />
        ) : (
          <View style={{ paddingHorizontal: LIST_GUTTER, gap: space.xs }}>
            {textChannels.map((channel) => renderChannelRow(channel))}
          </View>
        )}

        {voiceChannels.length > 0 ? (
          <>
            <SectionLabel>{t("mobile:group.voiceChannels")}</SectionLabel>
            <View style={{ paddingHorizontal: LIST_GUTTER, gap: space.xs }}>
              {voiceChannels.map((channel) => renderChannelRow(channel))}
            </View>
          </>
        ) : null}

        {/* Then one collapsible section per category, in the server's order. A
            category mixes text and voice: its ORDER is the thing the owner
            arranged, so re-splitting it by kind would throw that away. */}
        {buckets
          .filter((bucket) => bucket.category !== null)
          .map((bucket) => {
            const category = bucket.category;
            if (!category) return null;
            const collapsed = collapsedIds.includes(category.id);
            return (
              <View key={category.id}>
                {renderCategoryHeader(bucket)}
                {collapsed ? null : bucket.channels.length > 0 ? (
                  <View
                    style={{
                      paddingHorizontal: LIST_GUTTER,
                      paddingTop: space.xs,
                      gap: space.xs,
                    }}
                  >
                    {bucket.channels.map((channel) => renderChannelRow(channel))}
                  </View>
                ) : (
                  <Text
                    style={{
                      color: colors.fgFaint,
                      fontSize: 12,
                      paddingHorizontal: CONTENT_INSET,
                      paddingTop: space.xs,
                    }}
                  >
                    {t("mobile:category.empty")}
                  </Text>
                )}
              </View>
            );
          })}

        {canManageChannels ? (
          <View style={{ paddingHorizontal: LIST_GUTTER, paddingTop: space.sm, gap: space.xs }}>
            <Row
              title={t("mobile:group.newChannel")}
              accent
              leading={<Plus size={20} color={colors.accent} />}
              showChevron={false}
              onPress={() => openNewChannel()}
            />
            <Row
              title={t("mobile:category.createCategory")}
              leading={<FolderPlus size={20} color={colors.fgMuted} />}
              showChevron={false}
              onPress={() => openCategoryEditor()}
            />
          </View>
        ) : null}

        <SectionLabel>{t("mobile:group.membersCount", { n: members.length })}</SectionLabel>
        <View style={{ paddingHorizontal: CONTENT_INSET, paddingTop: space.xs }}>
          {members.map((member) => (
            <Pressable
              key={member.userId}
              onPress={() =>
                router.push({
                  pathname: "/user/[userId]",
                  params: {
                    userId: member.userId,
                    name: member.user.displayName || member.user.username,
                    groupId,
                  },
                })
              }
              // Long press = the desktop right-click menu. The roster is the one
              // surface that already knows whether this member owns the server
              // and whether they are a guest, so it passes both — the rules
              // module needs owner-immunity to hide moderation (§35).
              onLongPress={() =>
                setMemberTarget({
                  userId: member.userId,
                  displayName: member.user.displayName,
                  username: member.user.username,
                  isOwner: member.role === "owner",
                  isGuest: member.role === "guest",
                })
              }
              accessibilityRole="button"
              accessibilityLabel={t("mobile:userProfile.openA11y")}
              accessibilityHint={t("mobile:userMenu.moreActions")}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: space.md,
                paddingVertical: space.xs,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Avatar
                name={member.user.displayName || member.user.username}
                size={36}
                uri={member.user.avatarUrl}
                presence={presence[member.userId] ?? "offline"}
              />
              <View style={{ flex: 1 }}>
                <Text
                  numberOfLines={1}
                  style={{
                    color: memberColors.get(member.userId) ?? colors.fg,
                    fontSize: 14,
                    fontWeight: "600",
                  }}
                >
                  {member.user.displayName || member.user.username}
                </Text>
                {/* Custom status (M18) takes the second line when there is one,
                    exactly as on the desktop roster — PLAIN TEXT, one line, so
                    the row height never changes. The role label falls back to
                    it only when there is no status. */}
                <Text numberOfLines={1} style={{ color: colors.fgFaint, fontSize: 12 }}>
                  {customStatuses[member.userId] ??
                    visibleCustomStatus(member.user) ??
                    (member.role === "owner"
                      ? t("mobile:role.owner")
                      : member.role === "guest"
                        ? t("mobile:role.guest")
                        : t("mobile:role.member"))}
                </Text>
              </View>
            </Pressable>
          ))}
        </View>
      </ScrollView>

      {/* Long-press menu — mobile's parity of the desktop channel context menu.
          Both kinds get "mark as read" + the mute entry; a voice channel also
          gets its two room gestures spelled out, so reading without joining and
          disconnecting each have a deliberate surface. */}
      <ChannelActionSheet
        target={channelTarget}
        onOpenChat={(target) => {
          const channel = channelById(target.channelId);
          if (channel) openChannelChat(channel);
        }}
        onJoinVoice={(target) => {
          const channel = channelById(target.channelId);
          if (channel) openVoiceChannel(channel, "join");
        }}
        onMute={(target) =>
          setMuteTarget({ scope: "channel", targetId: target.channelId, name: target.name })
        }
        onMove={(target, direction) => moveChannelSlot(target.channelId, direction)}
        onMoveToCategory={(target) =>
          setMoveTarget({ channelId: target.channelId, name: target.name })
        }
        onClose={() => setChannelTarget(null)}
      />
      {/* Category management (M18) — which entries this sheet shows is the
          shared rule's call, so a member without MANAGE_CHANNELS opens nothing. */}
      <CategoryActionSheet
        target={categoryTarget}
        canManageChannels={canManageChannels}
        onCreateChannel={(target) => openNewChannel(target.categoryId)}
        onRename={(target) =>
          openCategoryEditor({ id: target.categoryId, name: target.name })
        }
        onMove={(target, direction) => moveCategorySlot(target.categoryId, direction)}
        onDelete={confirmDeleteCategory}
        onClose={() => setCategoryTarget(null)}
      />
      <ChannelMoveSheet
        target={moveTarget}
        buckets={buckets}
        onPick={(target, categoryId) => moveChannelToCategory(target.channelId, categoryId)}
        onClose={() => setMoveTarget(null)}
      />
      <NotificationMuteSheet
        visible={muteTarget !== null}
        target={muteTarget}
        onClose={() => setMuteTarget(null)}
      />
      {/* No channel is passed: this panel is the server's channel list, not a
          thread, so there is no composer for "Mention" to type into and the
          rules module drops that entry rather than offering a dead one (§35). */}
      <MemberActionSheet
        target={memberTarget}
        groupId={groupId as GroupId}
        onClose={() => setMemberTarget(null)}
      />
    </>
  );
}
