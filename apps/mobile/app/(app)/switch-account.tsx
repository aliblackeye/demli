import { Alert, ScrollView, View } from "react-native";
import { Text } from "@/components/ui/Text";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Check, UserPlus } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { Avatar } from "@/components/Avatar";
import { Row } from "@/components/Row";
import { Screen } from "@/components/Screen";
import { useAccountsStore } from "@/stores/accounts-store";
import { removeAccount, switchAccount } from "@/lib/account-manager";
import type { StoredAccount } from "@demli/client-core";
import { colors, space } from "@/theme/theme";

/**
 * Multi-account switcher (M15 / ADR 0013). Lists every stored account (active one
 * checkmarked), switches on tap via the ordered `runAccountSwitch`, removes on
 * long-press (confirm), and links to "Add account". The mobile mirror of the
 * desktop profile-menu AccountSwitcher.
 */
export default function SwitchAccountScreen() {
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();
  const accounts = useAccountsStore((s) => s.accounts);
  const activeAccountId = useAccountsStore((s) => s.activeAccountId);

  const onSelect = async (account: StoredAccount): Promise<void> => {
    if (account.accountId === activeAccountId) return;
    // On success, land on Home via the `onSwitched` hook — it runs WHILE the switch
    // overlay is up and app/(app)/_layout has the whole Stack unmounted, so the app
    // remounts fresh at Home. Doing `router.back()` here instead (the old code)
    // popped this screen and reparented the live Home/You `removeClippedSubviews`
    // list at the exact moment the switch's queryCache/store reset re-rendered it —
    // the Fabric "view already has a parent" crash that permanently black-screened
    // the app until it was force-killed (P0 fix/switch-black-2).
    const outcome = await switchAccount(account.accountId, {
      onSwitched: () => router.replace("/groups"),
    });
    if (outcome.status === "reauth") {
      // The stored session is dead — the current one stays live. Re-authenticate
      // this account: open add-account prefilled + a "signed out" notice (#100).
      router.push({
        pathname: "/add-account",
        params: { username: outcome.account.username, reauth: "1" },
      });
      return;
    }
    if (outcome.status === "offline") {
      Alert.alert(
        t("mobile:accounts.switchOfflineTitle"),
        t("mobile:accounts.switchOfflineBody"),
      );
      return;
    }
    // status "switched": onSwitched already navigated. "noop": stay put.
  };

  const onRemove = (account: StoredAccount): void => {
    Alert.alert(
      t("mobile:accounts.removeTitle", { name: account.displayName }),
      account.accountId === activeAccountId
        ? t("mobile:accounts.removeActiveBody")
        : t("mobile:accounts.removeBody"),
      [
        { text: t("mobile:accounts.cancel"), style: "cancel" },
        {
          text: t("mobile:accounts.remove"),
          style: "destructive",
          onPress: () => void removeAccount(account.accountId),
        },
      ],
    );
  };

  return (
    <Screen>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          padding: space.md,
          paddingBottom: space.md + insets.bottom,
          gap: space.sm,
        }}
      >
        <Text style={{ color: colors.fgMuted, fontSize: 13, paddingHorizontal: space.sm, paddingBottom: space.xs }}>
          {t("mobile:accounts.switchHint")}
        </Text>

        {accounts.map((account) => {
          const isActive = account.accountId === activeAccountId;
          return (
            <Row
              key={account.accountId}
              title={account.displayName}
              subtitle={`@${account.username}`}
              leading={<Avatar name={account.displayName || "?"} size={40} uri={account.avatarUrl} />}
              trailing={isActive ? <Check size={20} color={colors.accent} /> : undefined}
              showChevron={false}
              onPress={() => void onSelect(account)}
              onLongPress={() => onRemove(account)}
            />
          );
        })}

        <View style={{ height: space.xs }} />
        <Row
          title={t("mobile:accounts.add")}
          leading={<UserPlus size={20} color={colors.accent} />}
          accent
          showChevron
          onPress={() => router.push("/add-account")}
        />

        <Text style={{ color: colors.fgFaint, fontSize: 12, paddingHorizontal: space.sm, paddingTop: space.sm }}>
          {t("mobile:accounts.removeHint")}
        </Text>
      </ScrollView>
    </Screen>
  );
}
