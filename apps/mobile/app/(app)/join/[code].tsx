import { useEffect, useRef } from "react";
import { ActivityIndicator, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { LinkIcon, Unlink } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/Button";
import { Text } from "@/components/ui/Text";
import { localizeError } from "@/lib/errors";
import { useRedeemInvite } from "@/queries/chat-queries";
import { colors, radius, space } from "@/theme/theme";

/**
 * Deep-link join target. `demli://join/<code>` routes here; the auth guard in
 * (app)/_layout redirects to sign-in first if the
 * session is not active. On mount we redeem the code exactly once, then replace
 * into the joined group so Back doesn't return to this transient screen.
 *
 * Koyu Masa: one centred state at a time — joining (the code shown, so you
 * know which invite is being used), a broken link, or a failed join with retry
 * and a way out to your servers.
 */
export default function JoinByLink() {
  const { t } = useAppTranslation();
  const params = useLocalSearchParams<{ code: string }>();
  const code = (params.code ?? "").trim();

  const redeemInvite = useRedeemInvite();
  const { mutate } = redeemInvite;
  const attempted = useRef(false);

  const join = () =>
    mutate(code, {
      onSuccess: ({ group }) => {
        router.replace({
          pathname: "/group/[groupId]",
          params: { groupId: group.id, name: group.name },
        });
      },
    });

  useEffect(() => {
    if (attempted.current || code.length === 0) return;
    attempted.current = true;
    join();
  }, [code, mutate]);

  const invalidCode = code.length === 0;
  const goToServers = (
    <Button label={t("mobile:join.goToServers")} variant="ghost" onPress={() => router.replace("/groups")} />
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.app, padding: space.lg, justifyContent: "center" }}>
      <Stack.Screen options={{ title: t("mobile:join.title") }} />

      {invalidCode ? (
        <EmptyState
          icon={<Unlink size={22} color={colors.fgMuted} />}
          title={t("mobile:join.invalidTitle")}
          subtitle={t("mobile:join.invalidBody")}
          action={goToServers}
        />
      ) : redeemInvite.isError ? (
        <EmptyState
          tone="error"
          icon={<Unlink size={22} color={colors.danger} />}
          title={t("mobile:join.failedTitle")}
          subtitle={localizeError(redeemInvite.error, t)}
          action={
            <View style={{ gap: space.sm, alignItems: "center" }}>
              <Button
                label={t("common:buttons.retry")}
                variant="accent"
                onPress={() => {
                  attempted.current = false;
                  redeemInvite.reset();
                  join();
                }}
              />
              {goToServers}
            </View>
          }
        />
      ) : (
        <View accessible accessibilityRole="progressbar" accessibilityLabel={t("mobile:join.joining")} style={{ alignItems: "center", gap: space.lg }}>
          <View style={{ width: 64, height: 64, borderRadius: radius.pill, backgroundColor: colors.accentSurface, alignItems: "center", justifyContent: "center" }}>
            <LinkIcon size={26} color={colors.accent} strokeWidth={2} />
          </View>
          <View style={{ alignItems: "center", gap: space.xs }}>
            <Text type="heading" tone="display">
              {t("mobile:join.joining")}
            </Text>
            <View style={{ paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.pill, backgroundColor: colors.surface }}>
              <Text type="meta" tone="muted" style={{ letterSpacing: 1, fontVariant: ["tabular-nums"] }}>
                {code}
              </Text>
            </View>
          </View>
          <ActivityIndicator color={colors.accent} />
        </View>
      )}
    </View>
  );
}
