import { View } from "react-native";
import { Text } from "@/components/ui/Text";
import { router, Stack } from "expo-router";
import { useAppTranslation } from "@/lib/i18n";
import { Button } from "@/components/Button";
import { colors, space } from "@/theme/theme";

/**
 * Retired friend-code deep-link target (#111).
 *
 * Friend codes were removed in favour of add-by-username, but the
 * /arkadas/<code> route is KEPT so links already shared in chats / QR codes
 * degrade gracefully instead of 404ing: we explain the change and send the user
 * to the add-by-username surface. There is no code lookup or request send here
 * any more, so the screen no longer needs auth state — it lives ABOVE the (app)
 * auth guard, so the CTA below simply routes through sign-in first when opened
 * while signed out (the auth guard handles that transparently).
 */
export default function RetiredFriendCodeLink() {
  const { t } = useAppTranslation();

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
      <Stack.Screen options={{ title: t("mobile:addFriend.title") }} />

      <View style={{ gap: space.md, alignItems: "center" }}>
        <Text variant="display" style={{ color: colors.fg, fontSize: 16, fontWeight: "700", textAlign: "center" }}>
          {t("mobile:addFriend.removedTitle")}
        </Text>
        <Text style={{ color: colors.fgMuted, fontSize: 14, textAlign: "center" }}>
          {t("mobile:addFriend.removedBody")}
        </Text>
        <Button
          label={t("mobile:addFriend.removedCta")}
          onPress={() => router.replace("/friends?tab=add")}
        />
      </View>
    </View>
  );
}
