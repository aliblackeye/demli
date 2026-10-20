import { useEffect, useRef } from "react";
import { ActivityIndicator, View } from "react-native";
import { Text } from "@/components/ui/Text";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useAppTranslation } from "@/lib/i18n";
import { AlertCircle, Link2Off } from "lucide-react-native";
import { BrandMark } from "@/components/BrandMark";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/Button";
import { localizeError } from "@/lib/errors";
import { parseInviteCode } from "@/lib/deep-links";
import { usePendingDeepLinkStore } from "@/deeplinks/pending-link-store";
import { useRedeemInvite } from "@/queries/chat-queries";
import { useAuthStore } from "@/stores/auth-store";
import { colors, space } from "@/theme/theme";

/**
 * Deep-link target for a server-invite link:
 *   https://app.getdemli.com/kat/<code>          (App Link / Universal Link)
 *   demli://kat/<code>                             (custom-scheme fallback)
 *
 * Lives ABOVE the (app) auth guard (top-level route) so an unauthenticated open
 * isn't bounced with the code lost: we stash the intent and
 * PendingDeepLinkController replays it after login. Reuses the existing redeem
 * flow (useRedeemInvite) exactly like app/(app)/join/[code].tsx.
 */
export default function JoinDeepLink() {
  const { t } = useAppTranslation();
  const params = useLocalSearchParams<{ code: string }>();
  const code = parseInviteCode(params.code ?? "");
  const status = useAuthStore((s) => s.status);

  const redeemInvite = useRedeemInvite();
  const { mutate } = redeemInvite;
  const attempted = useRef(false);
  const invalidCode = code.length === 0;

  const redeem = () => {
    if (attempted.current || invalidCode) return;
    attempted.current = true;
    mutate(code, {
      onSuccess: ({ group }) => {
        router.replace({
          pathname: "/group/[groupId]",
          params: { groupId: group.id, name: group.name },
        });
      },
    });
  };

  useEffect(() => {
    if (invalidCode) return;
    if (status === "authenticated") {
      redeem();
    } else if (status === "unauthenticated") {
      // Defer across the sign-in redirect; replayed by PendingDeepLinkController.
      usePendingDeepLinkStore.getState().setPending({ kind: "invite", code });
      router.replace("/sign-in");
    }
    // redeem() is idempotent (guarded by `attempted`) and code is fixed for a
    // given mount, so the auth status transition is the only trigger we need.
  }, [status, invalidCode]);

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.app,
        paddingHorizontal: space.lg,
        justifyContent: "center",
      }}
    >
      <Stack.Screen options={{ title: t("mobile:join.title") }} />

      {invalidCode ? (
        <EmptyState
          icon={<Link2Off size={22} color={colors.fgMuted} />}
          title={t("mobile:join.invalidTitle")}
          subtitle={t("mobile:join.invalidBody")}
          action={
            <Button variant="secondary" label={t("mobile:join.goHome")} onPress={() => router.replace("/")} />
          }
        />
      ) : redeemInvite.isError ? (
        <EmptyState
          tone="error"
          icon={<AlertCircle size={22} color={colors.danger} />}
          title={t("mobile:join.errorTitle")}
          subtitle={localizeError(redeemInvite.error, t)}
          action={
            <View style={{ flexDirection: "row", gap: space.sm }}>
              <Button
                variant="primary"
                size="sm"
                label={t("buttons.retry")}
                onPress={() => {
                  attempted.current = false;
                  redeemInvite.reset();
                  redeem();
                }}
              />
              <Button variant="ghost" size="sm" label={t("mobile:join.goHome")} onPress={() => router.replace("/")} />
            </View>
          }
        />
      ) : (
        <View
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={t("mobile:join.joining")}
          accessibilityState={{ busy: true }}
          style={{ alignItems: "center", gap: space.lg }}
        >
          <BrandMark size="md" />
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <ActivityIndicator color={colors.accent} />
            <Text style={{ color: colors.fgMuted, fontSize: 15, lineHeight: 21 }}>{t("mobile:join.joining")}</Text>
          </View>
        </View>
      )}
    </View>
  );
}
