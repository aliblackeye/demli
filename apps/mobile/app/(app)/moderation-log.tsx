import { useMemo } from "react";
import { ActivityIndicator, FlatList, RefreshControl, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CloudOff, Lock, ScrollText } from "lucide-react-native";
import type { GroupId, ModerationActionEntry, ModerationActionType } from "@demli/types";
import { Avatar } from "@/components/Avatar";
import { EmptyState } from "@/components/EmptyState";
import { Screen } from "@/components/Screen";
import { SkeletonList } from "@/components/Skeleton";
import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Text } from "@/components/ui/Text";
import { localizeError } from "@/lib/errors";
import { useAppTranslation } from "@/lib/i18n";
import { canSeeModerationLog, flattenModerationLog } from "@/lib/moderation-log";
import { useModerationLog, useServerPermissions } from "@/queries/chat-queries";
import { colors, radius, space } from "@/theme/theme";

/** One catalog key per action, so a new action type is a compile error here. */
const ACTION_KEY = {
  kick: "mobile:moderationLog.action.kick",
  ban: "mobile:moderationLog.action.ban",
  unban: "mobile:moderationLog.action.unban",
  voice_disconnect: "mobile:moderationLog.action.voice_disconnect",
  // Migration 0020 (ADR 0019): a timeout is a temporary, self-clearing mute —
  // logged like every other moderation action so the audit trail stays complete.
  timeout: "mobile:moderationLog.action.timeout",
  timeout_remove: "mobile:moderationLog.action.timeout_remove",
} as const satisfies Record<ModerationActionType, string>;

const ACTION_LABEL_KEY = {
  kick: "mobile:moderationLog.actionLabel.kick",
  ban: "mobile:moderationLog.actionLabel.ban",
  unban: "mobile:moderationLog.actionLabel.unban",
  voice_disconnect: "mobile:moderationLog.actionLabel.voice_disconnect",
  timeout: "mobile:moderationLog.actionLabel.timeout",
  timeout_remove: "mobile:moderationLog.actionLabel.timeout_remove",
} as const satisfies Record<ModerationActionType, string>;

/**
 * The badge tone carries the action's weight, and the label always says it in
 * words (colour only reinforces): removals pink, restrictions gold, lifts green.
 */
const ACTION_TONE = {
  kick: "danger",
  ban: "danger",
  unban: "success",
  voice_disconnect: "warning",
  timeout: "warning",
  timeout_remove: "success",
} as const satisfies Record<ModerationActionType, BadgeVariant>;

function LogRow({ entry }: { entry: ModerationActionEntry }) {
  const { t, i18n } = useAppTranslation();

  // `actor` is nullable by contract: purging a moderator's account nulls the FK
  // rather than destroying the record of what was done. Never render "undefined".
  const actorName = entry.actor?.displayName ?? t("mobile:moderationLog.unknownActor");
  const targetName = entry.target?.displayName ?? t("mobile:moderationLog.unknownTarget");

  const when = useMemo(() => {
    const date = new Date(entry.action.createdAt);
    if (Number.isNaN(date.getTime())) return "";
    const opts: Intl.DateTimeFormatOptions = {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    };
    try {
      return new Intl.DateTimeFormat(i18n.language, opts).format(date);
    } catch {
      return new Intl.DateTimeFormat("en", opts).format(date);
    }
  }, [entry.action.createdAt, i18n.language]);

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: space.md,
        paddingHorizontal: space.lg,
        paddingVertical: space.md,
        borderRadius: radius.xl,
        borderCurve: "continuous",
        backgroundColor: colors.surface,
      }}
    >
      <Avatar name={actorName} size={36} uri={entry.actor?.avatarUrl} ringColor={colors.surface} />
      <View style={{ flex: 1, gap: space.xs }}>
        <Badge variant={ACTION_TONE[entry.action.action]} label={t(ACTION_LABEL_KEY[entry.action.action])} />
        {/* One interpolated sentence, exactly like the desktop tab's — the
            catalog strings carry no markup, so the names are plain values and
            nothing here can be turned into formatting by a display name (§28). */}
        <Text type="ui" tone="default" style={{ fontWeight: "400", lineHeight: 20 }}>
          {t(ACTION_KEY[entry.action.action], { actor: actorName, target: targetName })}
        </Text>
        {entry.action.reason ? (
          <View style={{ paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.md, backgroundColor: colors.surfaceRaised }}>
            <Text type="meta" tone="muted" style={{ fontWeight: "400" }}>
              {t("mobile:moderationLog.reason")}: {entry.action.reason}
            </Text>
          </View>
        ) : null}
        <Text type="caption" tone="faint">
          {when}
        </Text>
      </View>
    </View>
  );
}

/**
 * "Audit log" (M18) — every kick / ban / unban / voice-disconnect / timeout
 * performed in this server, newest first, keyset-paged through the SAME infinite
 * list pattern as Recent Calls (`onEndReached` + a footer spinner).
 *
 * Authority is owner ∨ KICK_MEMBERS — the SAME gate as the desktop tab and as
 * the endpoint itself. The server-settings screen hides the entry for anyone
 * else, so this screen is normally only reached by a permitted viewer; it
 * re-checks anyway, because a deep link is not an authorization (the API is the
 * real boundary — this is just about never rendering a list that would 403).
 *
 * States: skeleton rows, an error block with retry, an explained empty state,
 * pull-to-refresh, and a footer spinner while the next page loads.
 */
export default function ModerationLogScreen() {
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ groupId: string }>();
  const groupId = (params.groupId ?? null) as GroupId | null;

  const { isOwner, can } = useServerPermissions(groupId);
  const allowed = canSeeModerationLog(isOwner, can);

  const { data, isPending, isError, error, refetch, isRefetching, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useModerationLog(groupId, allowed);

  const entries = useMemo(() => flattenModerationLog(data?.pages), [data]);

  let body: JSX.Element;
  if (!allowed) {
    body = (
      <View style={{ flex: 1, justifyContent: "center" }}>
        <EmptyState icon={<Lock size={22} color={colors.fgMuted} />} title={t("errors.forbidden")} />
      </View>
    );
  } else if (isPending) {
    body = (
      <View style={{ padding: space.lg }}>
        <SkeletonList count={6} lines={2} leadingSize={36} />
      </View>
    );
  } else if (isError) {
    body = (
      <View style={{ flex: 1, justifyContent: "center" }}>
        <EmptyState
          tone="error"
          icon={<CloudOff size={22} color={colors.danger} />}
          title={t("mobile:moderationLog.loadErrorTitle")}
          subtitle={localizeError(error, t)}
          action={<Button label={t("common:buttons.retry")} variant="secondary" size="sm" onPress={() => void refetch()} loading={isRefetching} />}
        />
      </View>
    );
  } else if (entries.length === 0) {
    body = (
      <View style={{ flex: 1, justifyContent: "center" }}>
        <EmptyState
          icon={<ScrollText size={22} color={colors.fgMuted} />}
          title={t("mobile:moderationLog.empty")}
          subtitle={t("mobile:moderationLog.description")}
        />
      </View>
    );
  } else {
    body = (
      <FlatList
        data={entries}
        keyExtractor={(entry) => entry.action.id}
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.lg + insets.bottom, gap: space.sm }}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching && !isFetchingNextPage}
            onRefresh={() => void refetch()}
            tintColor={colors.fgMuted}
            colors={[colors.accent]}
            progressBackgroundColor={colors.surfaceRaised}
          />
        }
        ListHeaderComponent={
          <Text type="ui" tone="muted" style={{ fontWeight: "400", lineHeight: 20, paddingBottom: space.sm }}>
            {t("mobile:moderationLog.description")}
          </Text>
        }
        renderItem={({ item }) => <LogRow entry={item} />}
        onEndReachedThreshold={0.5}
        onEndReached={() => {
          if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
        }}
        ListFooterComponent={
          isFetchingNextPage ? (
            <View style={{ paddingVertical: space.lg }}>
              <ActivityIndicator color={colors.fgFaint} />
            </View>
          ) : null
        }
      />
    );
  }

  return <Screen>{body}</Screen>;
}
