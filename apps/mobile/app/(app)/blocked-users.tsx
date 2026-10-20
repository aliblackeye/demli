import { useCallback, useState } from "react";
import { FlatList, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CloudOff, ShieldOff } from "lucide-react-native";
import type { UserId } from "@demli/types";
import { Avatar } from "@/components/Avatar";
import { EmptyState } from "@/components/EmptyState";
import { Screen } from "@/components/Screen";
import { SkeletonList } from "@/components/Skeleton";
import { ConfirmSheet } from "@/components/settings/ConfirmSheet";
import { SectionEyebrow } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/Button";
import { Text } from "@/components/ui/Text";
import { localizeError } from "@/lib/errors";
import { useAppTranslation } from "@/lib/i18n";
import { useBlocks, useUnblockUser } from "@/queries/member-queries";
import { colors, radius, space } from "@/theme/theme";

/**
 * "Blocked users" (M18 / ADR 0017) — the mobile mirror of the desktop's
 * BlockedUsersSettings section: everyone the signed-in user has blocked, with a
 * confirmed unblock.
 *
 * Deliberately one-directional: the API exposes only "who I blocked", never "who
 * blocked me", and this screen must not imply the latter exists. Nothing here
 * reveals whether the listed user has also blocked back (§28).
 *
 * The list refreshes itself after an unblock because `useUnblockUser`
 * invalidates `queryKeys.blocks` (see lib/block-sync.ts) — no local splice, so
 * an unblock performed on the desktop lands here identically through
 * `user.blocks_updated`.
 *
 * States: skeleton rows while loading, an error block with retry, an empty
 * state that explains what blocking does, then the list.
 */
export default function BlockedUsersScreen() {
  const { t, i18n } = useAppTranslation();
  const insets = useSafeAreaInsets();
  const { data: blocks, isPending, isError, error, refetch, isRefetching } = useBlocks();
  const unblock = useUnblockUser();
  const [target, setTarget] = useState<{ userId: UserId; name: string } | null>(null);
  const [unblockError, setUnblockError] = useState<string | null>(null);

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
  const confirmUnblock = () => {
    if (!target) return;
    setUnblockError(null);
    unblock.mutate(target.userId, {
      onSuccess: () => setTarget(null),
      onError: (err) => setUnblockError(localizeError(err, t)),
    });
  };

  let body: JSX.Element;
  if (isPending) {
    body = (
      <View style={{ padding: space.lg }}>
        <SkeletonList count={5} lines={2} leadingSize={40} />
      </View>
    );
  } else if (isError) {
    body = (
      <View style={{ flex: 1, justifyContent: "center" }}>
        <EmptyState
          tone="error"
          icon={<CloudOff size={22} color={colors.danger} />}
          title={t("mobile:block.loadErrorTitle")}
          subtitle={localizeError(error, t)}
          action={
            <Button
              label={t("common:buttons.retry")}
              variant="secondary"
              size="sm"
              onPress={() => void refetch()}
              loading={isRefetching}
            />
          }
        />
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
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.lg + insets.bottom, gap: space.sm }}
        ListHeaderComponent={
          <View style={{ gap: space.md, paddingBottom: space.sm }}>
            <Text type="ui" tone="muted" style={{ fontWeight: "400", lineHeight: 20 }}>
              {t("mobile:block.settingsDescription")}
            </Text>
            <SectionEyebrow style={{ paddingBottom: 0 }}>
              {t("mobile:block.settingsCount", { count: blocks.length })}
            </SectionEyebrow>
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
                borderRadius: radius.xl,
                borderCurve: "continuous",
                backgroundColor: colors.surface,
              }}
            >
              <Avatar name={name} size={40} uri={item.user.avatarUrl} ringColor={colors.surface} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text type="body" tone="default" numberOfLines={1} style={{ fontWeight: "600" }}>
                  {name}
                </Text>
                <Text type="meta" tone="faint" numberOfLines={1} style={{ fontWeight: "400" }}>
                  @{item.user.username} · {t("mobile:block.blockedSince", { date: formatDate(item.createdAt) })}
                </Text>
              </View>
              <Button
                label={t("mobile:block.unblock")}
                variant="secondary"
                size="sm"
                accessibilityLabel={t("mobile:block.unblockA11y", { name })}
                onPress={() => {
                  setUnblockError(null);
                  setTarget({ userId: item.user.id, name });
                }}
                disabled={unblock.isPending}
              />
            </View>
          );
        }}
      />
    );
  }

  return (
    <Screen>
      {body}
      <ConfirmSheet
        visible={target !== null}
        title={t("mobile:block.unblockConfirmTitle", { name: target?.name ?? "" })}
        body={t("mobile:block.unblockConfirmBody")}
        confirmLabel={t("mobile:block.unblockConfirmAction")}
        confirmIcon={ShieldOff}
        confirmVariant="primary"
        onConfirm={confirmUnblock}
        cancelLabel={t("common:buttons.cancel")}
        onCancel={() => setTarget(null)}
        busy={unblock.isPending}
        error={unblockError}
        errorTitle={t("mobile:block.settingsTitle")}
      />
    </Screen>
  );
}
