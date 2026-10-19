import { useMemo, useState } from "react";
import { FlatList, View } from "react-native";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";
import { Text } from "../ui/Text";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AlertCircle, MessageCircle, MessageSquarePlus, PenSquare, Search, UserPlus, Users } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import type { Dm, Group } from "@demli/types";
import { Avatar } from "@/components/Avatar";
import { BrandMark } from "@/components/BrandMark";
import { EmptyState } from "@/components/EmptyState";
import { SkeletonList } from "@/components/Skeleton";
import { DmActionsSheet } from "@/components/home/DmActionsSheet";
import { DmRow } from "@/components/social/DmRow";
import { FriendStoryStrip } from "@/components/social/FriendStoryStrip";
import { Button } from "@/components/ui/Button";
import { Dot } from "@/components/ui/Badge";
import { IconButton } from "@/components/ui/IconButton";
import { SectionHeading } from "@/components/ui/SectionHeading";
import type { DmWithPreview } from "@/lib/dm-preview";
import { localizeError } from "@/lib/errors";
import { TAB_BAR_CONTENT_HEIGHT } from "@/lib/tab-bar";
import { useGroupChats } from "@/queries/group-chat-queries";
import { useDms, useFriendRequests } from "@/queries/social-queries";
import { useAuthStore } from "@/stores/auth-store";
import { useChatStore } from "@/stores/chat-store";
import { PRESS } from "@/theme/motion-presets";
import { colors, motion, radius, space } from "@/theme/theme";
import { Touchable } from "../ui/Touchable";
import { ShellRow, shellRowIconInk, shellRowInk } from "./ShellRow";

/** Best-known activity time for ordering a DM: its last message, else its open time. */
function dmSortKey(dm: DmWithPreview): number {
  return Date.parse(dm.lastMessagePreview?.createdAt ?? dm.createdAt) || 0;
}

/** One flattened Home row: a DM, the group-chats section header, or a group chat. */
type HomeRow =
  | { key: string; kind: "dm"; dm: DmWithPreview }
  | { key: string; kind: "groupHeader" }
  | { key: string; kind: "group"; group: Group };

/** The new-message button: 56px coral, dark ink, the tile's give on press. */
const FAB = 56;

/**
 * The Home-entry panel of the shell: the DM-first conversations hub — a friends
 * strip, rich DM rows, group chats under a labelled section, and a new-DM
 * button — under a panel header (the Demli mark + title, the command palette,
 * and a friends shortcut that wears a coral dot while requests wait).
 *
 * Every state is drawn: a skeleton on first load, an honest error with a retry
 * when the DM list cannot load, a welcoming empty state that points at the one
 * thing to do (find a friend), and the ideal list. The list is a virtualized
 * FlatList; rows are memoized so a presence tick or one row's unread change
 * repaints that row only (§27).
 *
 * Shown when the rail's Home entry is selected (`selectedServerId === null`).
 */
export function DmListPanel() {
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();
  const meId = useAuthStore((s) => s.user?.id ?? null);

  // Long-pressed DM whose action menu is open (mobile's hover-✕ equivalent).
  const [menuDm, setMenuDm] = useState<Dm | null>(null);

  const dms = useDms();
  const groupChats = useGroupChats();
  const incoming = useFriendRequests("incoming");
  const hasIncoming = (incoming.data?.length ?? 0) > 0;
  // Unread is tracked per stream id; a DM's stream is its `streamId`. Subscribing
  // here re-runs renderItem on an unread change, but each DmRow is memoized so
  // only the row whose flag flips actually re-renders (§27).
  const unreadChannelIds = useChatStore((s) => s.unreadChannelIds);
  const unreadCounts = useChatStore((s) => s.unreadCounts);

  const rows = useMemo<HomeRow[]>(() => {
    const dmRows: HomeRow[] = (dms.data ?? [])
      .slice()
      .sort((a, b) => dmSortKey(b) - dmSortKey(a))
      .map((dm) => ({ key: `dm:${dm.id}`, kind: "dm", dm }));

    const groups = groupChats.data ?? [];
    if (groups.length === 0) return dmRows;
    return [
      ...dmRows,
      { key: "groupHeader", kind: "groupHeader" },
      ...groups.map((group) => ({ key: `group:${group.id}`, kind: "group", group }) as HomeRow),
    ];
  }, [dms.data, groupChats.data]);

  const isLoading = dms.isLoading && groupChats.isLoading;
  const bottomClearance = insets.bottom + TAB_BAR_CONTENT_HEIGHT;

  const renderItem = ({ item }: { item: HomeRow }) => {
    if (item.kind === "dm") {
      return (
        <DmRow
          user={item.dm.participant}
          preview={item.dm.lastMessagePreview}
          meId={meId}
          unread={!!unreadChannelIds[item.dm.streamId]}
          unreadCount={unreadCounts[item.dm.streamId] ?? 0}
          onPress={() =>
            router.push({
              pathname: "/dm/[dmId]",
              params: {
                dmId: item.dm.id,
                streamId: item.dm.streamId,
                name: item.dm.participant.displayName,
                userId: item.dm.participant.id,
              },
            })
          }
          onLongPress={() => setMenuDm(item.dm)}
        />
      );
    }
    if (item.kind === "groupHeader") {
      return (
        <SectionHeading
          style={{ paddingLeft: space.md }}
          trailing={
            <IconButton
              icon={MessageSquarePlus}
              size="sm"
              label={t("mobile:home.newGroupChatA11y")}
              onPress={() => router.push("/new-group-chat")}
            />
          }
        >
          {t("mobile:home.groupsSection")}
        </SectionHeading>
      );
    }
    return (
      <ShellRow
        minHeight={56}
        onPress={() =>
          router.push({
            pathname: "/group-chat/[groupChatId]",
            params: { groupChatId: item.group.id, name: item.group.name },
          })
        }
        style={{ paddingVertical: space.sm }}
      >
        <Avatar name={item.group.name} size={40} uri={item.group.iconUrl} />
        <Text numberOfLines={1} style={{ flex: 1, color: shellRowInk({}), fontSize: 15, lineHeight: 20, fontWeight: "500" }}>
          {item.group.name}
        </Text>
        <Users size={16} color={shellRowIconInk({})} />
      </ShellRow>
    );
  };

  return (
    <View style={{ flex: 1 }}>
      {/* Panel header — the app's mark + title, the command palette, and the
          friends shortcut. The mark anchors the panel's top-left (founder P0:
          "the icon isn't even there on the Messages screen"). */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: space.xs,
          paddingLeft: space.lg,
          paddingRight: space.sm,
          paddingTop: space.md,
          paddingBottom: space.xs,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flex: 1 }}>
          <BrandMark size="sm" />
          <Text
            variant="display"
            accessibilityRole="header"
            numberOfLines={1}
            style={{ color: colors.fgDisplay, fontSize: 20, lineHeight: 26, fontWeight: "600", letterSpacing: -0.2, flexShrink: 1 }}
          >
            {t("mobile:home.directTitle")}
          </Text>
        </View>
        {/* Command palette (M20/W5) — mobile's Ctrl+K, in the panel header on
            BOTH surfaces (see ServerPanel), so it is reachable wherever the rail is. */}
        <IconButton
          icon={Search}
          label={t("mobile:commandMenu.openA11y")}
          onPress={() => router.push("/command-palette")}
        />
        <IconButton
          icon={UserPlus}
          label={hasIncoming ? t("mobile:home.friendsWithRequestsA11y") : t("mobile:home.friends")}
          onPress={() => router.push("/friends")}
          badge={hasIncoming ? <Dot color={colors.accent} size={10} ringColor={colors.app} /> : undefined}
        />
      </View>

      <FlatList<HomeRow>
        data={rows}
        keyExtractor={(r) => r.key}
        contentContainerStyle={{
          paddingHorizontal: space.md,
          paddingTop: space.xs,
          paddingBottom: bottomClearance + FAB + space.xl,
          gap: 2,
        }}
        refreshing={dms.isRefetching || groupChats.isRefetching}
        onRefresh={() => {
          void dms.refetch();
          void groupChats.refetch();
        }}
        ListHeaderComponent={<FriendStoryStrip />}
        renderItem={renderItem}
        ListEmptyComponent={
          isLoading ? (
            <View style={{ paddingTop: space.sm }}>
              <SkeletonList count={8} />
            </View>
          ) : dms.isError ? (
            <View style={{ paddingTop: space.xl }}>
              <EmptyState
                tone="error"
                icon={<AlertCircle size={22} color={colors.danger} />}
                title={t("mobile:home.dmLoadErrorTitle")}
                subtitle={localizeError(dms.error, t)}
                action={
                  <Button
                    variant="secondary"
                    size="sm"
                    label={t("buttons.retry")}
                    loading={dms.isRefetching}
                    onPress={() => void dms.refetch()}
                  />
                }
              />
            </View>
          ) : (
            <View style={{ paddingTop: space.xl }}>
              <EmptyState
                icon={<MessageCircle size={22} color={colors.fgMuted} />}
                title={t("mobile:direct.emptyTitle")}
                subtitle={t("mobile:direct.emptySubtitle")}
                action={
                  <Button
                    variant="accent"
                    size="sm"
                    icon={UserPlus}
                    label={t("mobile:direct.emptyAction")}
                    onPress={() => router.push("/friends")}
                  />
                }
              />
            </View>
          )
        }
      />

      {/* New-DM button — picks a friend to message. Sits just above the
          floating tab bar. */}
      <Animated.View
        entering={FadeIn.duration(motion.duration.standard).reduceMotion(ReduceMotion.System)}
        style={{ position: "absolute", right: space.lg, bottom: bottomClearance + space.md }}
      >
        <Touchable
          accessibilityRole="button"
          accessibilityLabel={t("mobile:home.newDm")}
          onPress={() => router.push("/friends")}
          tone={colors.accent}
          pressedTone={colors.accentDeep}
          pressScale={PRESS.scale.icon}
          haptic="light"
          style={{
            width: FAB,
            height: FAB,
            borderRadius: radius.cta,
            borderCurve: "continuous",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <PenSquare size={24} color={colors.onAccent} strokeWidth={2} />
        </Touchable>
      </Animated.View>

      {/* Row overflow menu: view profile / hide conversation. */}
      <DmActionsSheet dm={menuDm} onClose={() => setMenuDm(null)} />
    </View>
  );
}
