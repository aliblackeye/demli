import { useMemo, useState } from "react";
import { FlatList, Pressable, View } from "react-native";
import { Text } from "../ui/Text";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MessageCircle, MessageSquarePlus, Plus, Search, UserPlus } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import type { Dm, Group } from "@demli/types";
import { Avatar } from "@/components/Avatar";
import { BrandMark } from "@/components/BrandMark";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { Row } from "@/components/Row";
import { SkeletonList } from "@/components/Skeleton";
import { DmActionsSheet } from "@/components/home/DmActionsSheet";
import { DmRow } from "@/components/social/DmRow";
import { FriendStoryStrip } from "@/components/social/FriendStoryStrip";
import type { DmWithPreview } from "@/lib/dm-preview";
import { localizeError } from "@/lib/errors";
import { TAB_BAR_CONTENT_HEIGHT } from "@/lib/tab-bar";
import { useGroupChats } from "@/queries/group-chat-queries";
import { useDms, useFriendRequests } from "@/queries/social-queries";
import { useAuthStore } from "@/stores/auth-store";
import { useChatStore } from "@/stores/chat-store";
import { colors, elevation, radius, space } from "@/theme/theme";

/** Best-known activity time for ordering a DM: its last message, else its open time. */
function dmSortKey(dm: DmWithPreview): number {
  return Date.parse(dm.lastMessagePreview?.createdAt ?? dm.createdAt) || 0;
}

/** One flattened Home row: a DM, the group-chats section header, or a group chat. */
type HomeRow =
  | { key: string; kind: "dm"; dm: DmWithPreview }
  | { key: string; kind: "groupHeader" }
  | { key: string; kind: "group"; group: Group };

function ErrorRetry({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useAppTranslation();
  return (
    <View
      style={{
        paddingTop: space.xl,
        paddingHorizontal: space.xl,
        alignItems: "center",
        gap: space.md,
      }}
    >
      <Text selectable style={{ color: colors.fgMuted, fontSize: 14, textAlign: "center" }}>
        {message}
      </Text>
      <Pressable onPress={onRetry} hitSlop={8}>
        <Text style={{ color: colors.accent, fontSize: 14, fontWeight: "600" }}>
          {t("buttons.retry")}
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * The Home-entry panel of the shell: the DM-first conversations hub. Moved out
 * of the old `(tabs)/groups` screen unchanged — a
 * friends strip, rich DM rows, flat group chats under a labelled section, and a
 * new-DM FAB — plus a lightweight panel header (title + a friends shortcut that
 * jumps to the Friends tab, dotted when requests wait).
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
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: space.sm,
            paddingTop: space.lg,
            paddingBottom: space.xs,
          }}
        >
          <Text
            style={{
              color: colors.fgMuted,
              fontSize: 12,
              fontWeight: "700",
              letterSpacing: 0.6,
              textTransform: "uppercase",
            }}
          >
            {t("mobile:home.groupsSection")}
          </Text>
          <Pressable
            onPress={() => router.push("/new-group-chat")}
            hitSlop={10}
            accessibilityLabel={t("mobile:home.newGroupChatA11y")}
          >
            <MessageSquarePlus size={18} color={colors.fgMuted} />
          </Pressable>
        </View>
      );
    }
    return (
      <Row
        title={item.group.name}
        leading={<Avatar name={item.group.name} size={44} uri={item.group.iconUrl} />}
        onPress={() =>
          router.push({
            pathname: "/group-chat/[groupChatId]",
            params: { groupChatId: item.group.id, name: item.group.name },
          })
        }
      />
    );
  };

  return (
    <View style={{ flex: 1 }}>
      {/* Panel header — title + a friends shortcut (jumps to the Friends tab). */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: space.md,
          paddingTop: space.sm,
          paddingBottom: space.sm,
        }}
      >
        {/* The app's mark anchors the panel's top-left (founder P0: "the icon
            isn't even there on the Messages screen") — this header is the first
            thing an opened app shows, so the brand lives here. */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flex: 1 }}>
          <BrandMark size="sm" />
          <Text
            variant="display"
            numberOfLines={1}
            style={{ color: colors.fg, fontSize: 20, fontWeight: "800", flexShrink: 1 }}
          >
            {t("mobile:home.directTitle")}
          </Text>
        </View>
        {/* Command palette (M20/W5) — mobile's Ctrl+K. Lives in the panel header
            on BOTH surfaces (see ServerPanel) so it is reachable wherever the
            rail is, without spending a navigation tab on it. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("mobile:commandMenu.openA11y")}
          onPress={() => router.push("/command-palette")}
          hitSlop={10}
          style={{ padding: space.xs }}
        >
          <Search size={22} color={colors.fgMuted} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("mobile:home.friends")}
          onPress={() => router.push("/friends")}
          hitSlop={10}
          style={{ padding: space.xs }}
        >
          <View>
            <UserPlus size={22} color={colors.fgMuted} />
            {hasIncoming ? (
              <View
                style={{
                  position: "absolute",
                  top: -3,
                  right: -3,
                  width: 9,
                  height: 9,
                  borderRadius: radius.pill,
                  backgroundColor: colors.accent,
                  borderWidth: 1.5,
                  borderColor: colors.app,
                }}
              />
            ) : null}
          </View>
        </Pressable>
      </View>

      <FlatList<HomeRow>
        data={rows}
        keyExtractor={(r) => r.key}
        contentContainerStyle={{
          padding: space.md,
          paddingTop: space.xs,
          paddingBottom: space.md + insets.bottom + TAB_BAR_CONTENT_HEIGHT + space.xl * 2,
          gap: space.sm,
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
            <ErrorRetry message={localizeError(dms.error, t)} onRetry={() => void dms.refetch()} />
          ) : (
            <View style={{ paddingTop: space.xl }}>
              <EmptyState
                icon={<MessageCircle size={22} color={colors.fgMuted} />}
                title={t("mobile:direct.emptyTitle")}
                subtitle={t("mobile:direct.emptySubtitle")}
                action={
                  // A real CTA button (desktop EmptyState pattern). The previous
                  // list Row collapsed its label inside this centered container,
                  // leaving a mystery icon-only pill.
                  <Button
                    variant="ghost"
                    label={t("mobile:direct.emptyAction")}
                    onPress={() => router.push("/friends")}
                  >
                    <UserPlus size={18} color={colors.fg} />
                  </Button>
                }
              />
            </View>
          )
        }
      />

      {/* New-DM FAB — picks a friend to message. Clears the bottom tab bar. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("mobile:home.newDm")}
        onPress={() => router.push("/friends")}
        style={({ pressed }) => ({
          position: "absolute",
          right: space.lg,
          bottom: insets.bottom + TAB_BAR_CONTENT_HEIGHT + space.md,
          width: 56,
          height: 56,
          borderRadius: radius.pill,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: pressed ? colors.accentPressed : colors.accent,
          ...elevation.panel,
        })}
      >
        <Plus size={26} color={colors.onAccent} />
      </Pressable>

      {/* Row overflow menu: view profile / hide conversation. */}
      <DmActionsSheet dm={menuDm} onClose={() => setMenuDm(null)} />
    </View>
  );
}
