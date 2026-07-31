import { useCallback } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ShieldOff } from "lucide-react-native";
import type { UserId } from "@demli/types";
import { Text } from "@/components/ui/Text";
import { Avatar } from "@/components/Avatar";
import { EmptyState } from "@/components/EmptyState";
import { Screen } from "@/components/Screen";
import { localizeError } from "@/lib/errors";
import { useAppTranslation } from "@/lib/i18n";
import { useBlocks, useUnblockUser } from "@/queries/member-queries";
import { colors, radius, space, typography } from "@/theme/theme";

/**
 * "Blocked users" (M18 / ADR 0017) — the mobile mirror of the desktop's
 * BlockedUsersSettings section: everyone the signed-in user has blocked, with a
 * confirmed one-tap unblock.
 *
 * Deliberately one-directional: the API exposes only "who I blocked", never "who
 * blocked me", and this screen must not imply the latter exists. Nothing here
 * reveals whether the listed user has also blocked back (§28).
 *
 * The list refreshes itself after an unblock because `useUnblockUser`
 * invalidates `queryKeys.blocks` (see lib/block-sync.ts) — no local splice, so
 * an unblock performed on the desktop lands here identically through
 * `user.blocks_updated`.
 */
export default function BlockedUsersScreen() {
  const { t, i18n } = useAppTranslation();
  const insets = useSafeAreaInsets();
  const { data: blocks, isPending, isError, error, refetch } = useBlocks();
  const unblock = useUnblockUser();

  const formatDate = useCallback(
    (iso: string): string => {
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return "";
      const opts: Intl.DateTimeFormatOptions = { year: "numeric", month: "long", day: "numeric" };
      try {
        return new Intl.DateTimeFormat(i18n.language, opts).format(date);
      } catch {
        return new Intl.DateTimeFormat("en", opts).format(date);
      }
    },
    [i18n.language],
  );

  // Same confirmation copy as the member sheet's unblock — one wording for the
  // one action, so removing a block never reads differently by entry point.
  const confirmUnblock = useCallback(
    (userId: UserId, name: string) => {
      Alert.alert(
        t("mobile:block.unblockConfirmTitle", { name }),
        t("mobile:block.unblockConfirmBody"),
        [
          { text: t("buttons.cancel"), style: "cancel" },
          {
            text: t("mobile:block.unblockConfirmAction"),
            onPress: () =>
              unblock.mutate(userId, {
                onError: (err) =>
                  Alert.alert(t("mobile:block.settingsTitle"), localizeError(err, t)),
              }),
          },
        ],
      );
    },
    [t, unblock],
  );

  let body: JSX.Element;
  if (isPending) {
    body = (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={colors.fgFaint} />
      </View>
    );
  } else if (isError) {
    body = (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          padding: space.xl,
          gap: space.md,
        }}
      >
        <Text selectable style={{ color: colors.fgMuted, fontSize: 14, textAlign: "center" }}>
          {localizeError(error, t)}
        </Text>
        <Pressable onPress={() => void refetch()} hitSlop={8}>
          <Text style={{ color: colors.accent, fontSize: 14, fontWeight: "600" }}>
            {t("buttons.retry")}
          </Text>
        </Pressable>
      </View>
    );
  } else if (!blocks || blocks.length === 0) {
    body = (
      <View style={{ flex: 1, justifyContent: "center" }}>
        <EmptyState
          icon={<ShieldOff size={22} color={colors.fgMuted} />}
          title={t("mobile:block.settingsEmpty")}
          subtitle={t("mobile:block.settingsDescription")}
        />
      </View>
    );
  } else {
    body = (
      <FlatList
        data={blocks}
        keyExtractor={(entry) => entry.user.id}
        contentContainerStyle={{
          padding: space.md,
          paddingBottom: space.md + insets.bottom,
          gap: space.sm,
        }}
        ListHeaderComponent={
          <View style={{ paddingHorizontal: space.sm, paddingBottom: space.sm, gap: space.xs }}>
            <Text style={{ color: colors.fgMuted, fontSize: 13, lineHeight: 19 }}>
              {t("mobile:block.settingsDescription")}
            </Text>
            <Text
              style={{
                color: colors.fgFaint,
                fontSize: typography.size["2xs"],
                fontWeight: "700",
                letterSpacing: 0.6,
                textTransform: "uppercase",
                paddingTop: space.xs,
              }}
            >
              {t("mobile:block.settingsCount", { count: blocks.length })}
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          const name = item.user.displayName || item.user.username;
          return (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: space.md,
                paddingHorizontal: space.lg,
                paddingVertical: space.md,
                borderRadius: radius.md,
                borderCurve: "continuous",
                backgroundColor: colors.surface,
              }}
            >
              <Avatar name={name} size={40} uri={item.user.avatarUrl} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text
                  numberOfLines={1}
                  style={{ color: colors.fg, fontSize: 15, fontWeight: "600" }}
                >
                  {name}
                </Text>
                <Text numberOfLines={1} style={{ color: colors.fgFaint, fontSize: 12 }}>
                  @{item.user.username} ·{" "}
                  {t("mobile:block.blockedSince", { date: formatDate(item.createdAt) })}
                </Text>
              </View>
              {/* 44pt tap target — the row's only action, so it must not be a
                  thumb-sized gamble. */}
              <Pressable
                onPress={() => confirmUnblock(item.user.id, name)}
                disabled={unblock.isPending}
                accessibilityRole="button"
                accessibilityLabel={t("mobile:block.unblockA11y", { name })}
                style={({ pressed }) => ({
                  minHeight: 44,
                  minWidth: 44,
                  paddingHorizontal: space.md,
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: radius.sm,
                  borderCurve: "continuous",
                  borderWidth: 1,
                  borderColor: colors.stroke,
                  backgroundColor: pressed ? colors.surfaceRaised : "transparent",
                  opacity: unblock.isPending ? 0.5 : 1,
                })}
              >
                <Text style={{ color: colors.fg, fontSize: 13, fontWeight: "600" }}>
                  {t("mobile:block.unblock")}
                </Text>
              </Pressable>
            </View>
          );
        }}
      />
    );
  }

  return <Screen>{body}</Screen>;
}
