import { useEffect, useRef } from "react";
import { ActivityIndicator, View } from "react-native";
import { Text } from "@/components/ui/Text";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useAppTranslation } from "@/lib/i18n";
import { Button } from "@/components/Button";
import { localizeError } from "@/lib/errors";
import { parseInviteCode } from "@/lib/deep-links";
import { usePendingDeepLinkStore } from "@/deeplinks/pending-link-store";
import { useRedeemInvite } from "@/queries/chat-queries";
import { useAuthStore } from "@/stores/auth-store";
import { colors, radius, space } from "@/theme/theme";

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
        padding: space.lg,
        justifyContent: "center",
        gap: space.lg,
      }}
    >
      <Stack.Screen options={{ title: t("mobile:join.title") }} />

      {invalidCode ? (
        <View style={{ gap: space.md, alignItems: "center" }}>
          <Text variant="display" style={{ color: colors.fg, fontSize: 16, fontWeight: "700" }}>
            {t("mobile:join.invalidTitle")}
          </Text>
          <Text style={{ color: colors.fgMuted, fontSize: 14, textAlign: "center" }}>
            {t("mobile:join.invalidBody")}
          </Text>
          <Button label={t("mobile:join.goHome")} variant="ghost" onPress={() => router.replace("/")} />
        </View>
      ) : redeemInvite.isError ? (
        <View style={{ gap: space.md }}>
          <View style={{ backgroundColor: colors.dangerSurface, borderRadius: radius.sm, padding: space.md }}>
            <Text selectable style={{ color: colors.danger, fontSize: 13, textAlign: "center" }}>
              {localizeError(redeemInvite.error, t)}
            </Text>
          </View>
          <Button
            label={t("buttons.retry")}
            onPress={() => {
              attempted.current = false;
              redeemInvite.reset();
              redeem();
            }}
          />
          <Button label={t("mobile:join.goHome")} variant="ghost" onPress={() => router.replace("/")} />
        </View>
      ) : (
        <View style={{ alignItems: "center", gap: space.md }}>
          <ActivityIndicator color={colors.fgFaint} />
          <Text style={{ color: colors.fgMuted, fontSize: 14 }}>{t("mobile:join.joining")}</Text>
        </View>
      )}
    </View>
  );
}
