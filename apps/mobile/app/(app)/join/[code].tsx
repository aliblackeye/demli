import { useEffect, useRef } from "react";
import { ActivityIndicator, View } from "react-native";
import { Text } from "@/components/ui/Text";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useAppTranslation } from "@/lib/i18n";
import { Button } from "@/components/Button";
import { localizeError } from "@/lib/errors";
import { useRedeemInvite } from "@/queries/chat-queries";
import { colors, radius, space } from "@/theme/theme";

/**
 * Deep-link join target. `demli://join/<code>` routes here; the auth guard in
 * (app)/_layout redirects to sign-in first if the
 * session is not active. On mount we redeem the code exactly once, then replace
 * into the joined group so Back doesn't return to this transient screen.
 */
export default function JoinByLink() {
  const { t } = useAppTranslation();
  const params = useLocalSearchParams<{ code: string }>();
  const code = (params.code ?? "").trim();

  const redeemInvite = useRedeemInvite();
  const { mutate } = redeemInvite;
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current || code.length === 0) return;
    attempted.current = true;
    mutate(code, {
      onSuccess: ({ group }) => {
        router.replace({
          pathname: "/group/[groupId]",
          params: { groupId: group.id, name: group.name },
        });
      },
    });
  }, [code, mutate]);

  const invalidCode = code.length === 0;

  return (
    <View style={{ flex: 1, backgroundColor: colors.app, padding: space.lg, justifyContent: "center", gap: space.lg }}>
      <Stack.Screen options={{ title: t("mobile:join.title") }} />

      {invalidCode ? (
        <View style={{ gap: space.md, alignItems: "center" }}>
          <Text variant="display" style={{ color: colors.fg, fontSize: 16, fontWeight: "700" }}>
            {t("mobile:join.invalidTitle")}
          </Text>
          <Text style={{ color: colors.fgMuted, fontSize: 14, textAlign: "center" }}>
            {t("mobile:join.invalidBody")}
          </Text>
          <Button label={t("mobile:join.goToServers")} variant="ghost" onPress={() => router.replace("/groups")} />
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
              mutate(code, {
                onSuccess: ({ group }) => {
                  router.replace({
                    pathname: "/group/[groupId]",
                    params: { groupId: group.id, name: group.name },
                  });
                },
              });
            }}
          />
          <Button label={t("mobile:join.goToServers")} variant="ghost" onPress={() => router.replace("/groups")} />
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
