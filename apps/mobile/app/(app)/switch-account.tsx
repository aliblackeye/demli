import { useState } from "react";
import { ScrollView, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { EllipsisVertical, LogOut, UserPlus } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { Avatar } from "@/components/Avatar";
import { Screen } from "@/components/Screen";
import { ConfirmSheet } from "@/components/settings/ConfirmSheet";
import { RowIcon, SectionEyebrow } from "@/components/settings/SettingsSection";
import { ActionRow, ActionSheet } from "@/components/ui/ActionSheet";
import { Badge } from "@/components/ui/Badge";
import { Banner } from "@/components/ui/Banner";
import { IconButton } from "@/components/ui/IconButton";
import { Text } from "@/components/ui/Text";
import { Touchable } from "@/components/ui/Touchable";
import { useAccountsStore } from "@/stores/accounts-store";
import { removeAccount, switchAccount } from "@/lib/account-manager";
import type { StoredAccount } from "@demli/client-core";
import { colors, radius, space } from "@/theme/theme";

/**
 * Multi-account switcher (M15 / ADR 0013). Lists every stored account (the
 * active one on the coral wash with an "active" badge), switches on tap via the
 * ordered `runAccountSwitch`, and removes through each row's ⋯ menu (or a long
 * press) after a confirm that says what removal does. Links to "Add account".
 * The mobile mirror of the desktop profile-menu AccountSwitcher.
 */
export default function SwitchAccountScreen() {
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();
  const accounts = useAccountsStore((s) => s.accounts);
  const activeAccountId = useAccountsStore((s) => s.activeAccountId);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [menuFor, setMenuFor] = useState<StoredAccount | null>(null);
  const [removing, setRemoving] = useState<StoredAccount | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);

  const onSelect = async (account: StoredAccount): Promise<void> => {
    if (account.accountId === activeAccountId || switchingId) return;
    setOffline(false);
    setSwitchingId(account.accountId);
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
    setSwitchingId(null);
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
      setOffline(true);
      return;
    }
    // status "switched": onSwitched already navigated. "noop": stay put.
  };

  const confirmRemove = () => {
    if (!removing) return;
    setRemoveBusy(true);
    void removeAccount(removing.accountId).finally(() => {
      setRemoveBusy(false);
      setRemoving(null);
    });
  };

  return (
    <Screen>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xl + insets.bottom, gap: space.sm }}
      >
        <Text type="ui" tone="muted" style={{ fontWeight: "400", lineHeight: 20, paddingBottom: space.sm }}>
          {t("mobile:accounts.switchHint")}
        </Text>

        {offline ? (
          <Banner
            variant="danger"
            title={t("mobile:accounts.switchOfflineTitle")}
            description={t("mobile:accounts.switchOfflineBody")}
            onDismiss={() => setOffline(false)}
          />
        ) : null}

        <SectionEyebrow>{t("mobile:accounts.onDevice", { count: accounts.length })}</SectionEyebrow>
        {accounts.map((account) => {
          const isActive = account.accountId === activeAccountId;
          const name = account.displayName || account.username;
          return (
            <Touchable
              key={account.accountId}
              onPress={() => void onSelect(account)}
              onLongPress={() => setMenuFor(account)}
              disabled={switchingId !== null}
              dimmed={switchingId !== null && switchingId !== account.accountId}
              accessibilityRole="button"
              accessibilityLabel={`${name}, @${account.username}`}
              accessibilityHint={isActive ? undefined : t("mobile:accounts.switchA11yHint")}
              accessibilityState={{ selected: isActive, busy: switchingId === account.accountId }}
              tone={isActive ? colors.selected : colors.surface}
              pressedTone={isActive ? colors.accentSurfaceStrong : colors.surfaceRaised}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: space.md,
                minHeight: 64,
                paddingLeft: space.lg,
                paddingRight: space.xs,
                paddingVertical: space.md,
                borderRadius: radius.xl,
                borderCurve: "continuous",
              }}
            >
              <Avatar name={name || "?"} size={40} uri={account.avatarUrl} />
              <View style={{ flex: 1, gap: 2 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                  <Text
                    type="body"
                    numberOfLines={1}
                    style={{ flexShrink: 1, fontWeight: "600", color: isActive ? colors.accent : colors.fg }}
                  >
                    {name}
                  </Text>
                  {isActive ? <Badge variant="accent" label={t("mobile:accounts.activeBadge")} /> : null}
                </View>
                <Text type="meta" tone="faint" numberOfLines={1} style={{ fontWeight: "400" }}>
                  {switchingId === account.accountId ? t("mobile:accounts.switching") : `@${account.username}`}
                </Text>
              </View>
              <IconButton
                icon={EllipsisVertical}
                label={t("mobile:accounts.moreA11y", { name })}
                onPress={() => setMenuFor(account)}
                disabled={switchingId !== null}
              />
            </Touchable>
          );
        })}

        <Touchable
          onPress={() => router.push("/add-account")}
          accessibilityRole="button"
          accessibilityLabel={t("mobile:accounts.add")}
          tone={colors.surface}
          pressedTone={colors.surfaceRaised}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: space.md,
            minHeight: 56,
            marginTop: space.sm,
            paddingHorizontal: space.lg,
            borderRadius: radius.xl,
            borderCurve: "continuous",
          }}
        >
          <RowIcon icon={UserPlus} tone="accent" />
          <Text type="body" tone="accent" style={{ fontWeight: "600" }}>
            {t("mobile:accounts.add")}
          </Text>
        </Touchable>

        <Text type="meta" tone="faint" style={{ paddingHorizontal: space.xs, paddingTop: space.sm, fontWeight: "400" }}>
          {t("mobile:accounts.removeHint")}
        </Text>
      </ScrollView>

      <ActionSheet visible={menuFor !== null} title={menuFor?.displayName || menuFor?.username} onClose={() => setMenuFor(null)}>
        <ActionRow
          icon={<LogOut size={20} color={colors.danger} />}
          label={t("mobile:accounts.remove")}
          hint={t("mobile:accounts.removeHint")}
          labelColor={colors.danger}
          onPress={() => {
            const account = menuFor;
            setMenuFor(null);
            setRemoving(account);
          }}
        />
      </ActionSheet>

      <ConfirmSheet
        visible={removing !== null}
        title={t("mobile:accounts.removeTitle", { name: removing?.displayName ?? "" })}
        body={
          removing?.accountId === activeAccountId ? t("mobile:accounts.removeActiveBody") : t("mobile:accounts.removeBody")
        }
        confirmLabel={t("mobile:accounts.remove")}
        confirmIcon={LogOut}
        onConfirm={confirmRemove}
        cancelLabel={t("mobile:accounts.cancel")}
        onCancel={() => setRemoving(null)}
        busy={removeBusy}
      />
    </Screen>
  );
}
