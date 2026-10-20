import { View } from "react-native";
import { router, Stack } from "expo-router";
import { AtSign } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/Button";
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
    <View style={{ flex: 1, backgroundColor: colors.app, paddingHorizontal: space.lg, justifyContent: "center" }}>
      <Stack.Screen options={{ title: t("mobile:addFriend.title") }} />
      <EmptyState
        icon={<AtSign size={22} color={colors.fgMuted} />}
        title={t("mobile:addFriend.removedTitle")}
        subtitle={t("mobile:addFriend.removedBody")}
        action={
          <Button
            variant="accent"
            label={t("mobile:addFriend.removedCta")}
            onPress={() => router.replace("/friends?tab=add")}
          />
        }
      />
    </View>
  );
}
