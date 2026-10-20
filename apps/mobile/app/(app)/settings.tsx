import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { router } from "expo-router";
import Constants from "expo-constants";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ArrowLeftRight,
  Hash,
  Info,
  LogOut,
  MonitorSmartphone,
  Pencil,
  RefreshCw,
  ShieldBan,
} from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { AudioProfileSettings } from "@/components/AudioProfileSettings";
import { EchoCancellerSettings } from "@/components/EchoCancellerSettings";
import { NotificationPermissionRow } from "@/components/NotificationPermissionRow";
import { Avatar } from "@/components/Avatar";
import { ChipSelect } from "@/components/ChipSelect";
import { HapticsSettings } from "@/components/HapticsSettings";
import { MicSettings } from "@/components/MicSettings";
import { ProfileBannerImage } from "@/components/ProfileBannerImage";
import { Screen } from "@/components/Screen";
import { SoundSettings } from "@/components/SoundSettings";
import { VideoSettings } from "@/components/VideoSettings";
import { ConfirmSheet } from "@/components/settings/ConfirmSheet";
import { ROW_ICON_INSET, SettingsBlock, SettingsRow, SettingsSection } from "@/components/settings/SettingsSection";
import { Text } from "@/components/ui/Text";
import { Touchable } from "@/components/ui/Touchable";
import { toast } from "@/components/ui/toast-store";
import { applyLanguagePreference, getLanguagePreference, type LanguagePreference } from "@/lib/i18n";
import { useAuthStore } from "@/stores/auth-store";
import { useSelfPresenceAsSeen } from "@/lib/use-self-presence";
import { useAccountsStore } from "@/stores/accounts-store";
import { logoutActiveAccount } from "@/lib/account-manager";
import { currentUpdateInfo } from "@/updates/updates";
import { useUpdatesStore } from "@/updates/updates-store";
import { colors, radius, space } from "@/theme/theme";

/**
 * Settings — one scroll of Koyu Masa settings cards (design system "Ayarlar":
 * groups on a surface card, switches in setting rows, consequences stated in
 * each group's footnote). The identity card at the top is the same banner +
 * avatar the profile card draws, and opens the profile editor.
 *
 * Every control here changes something real: the media cards write the
 * persisted media/sound/haptics stores the engine reads, language applies
 * live, the update check runs the real OTA check and reports its outcome in a
 * toast, sign-out logs the ACTIVE account out (ADR 0013) after a confirm.
 */
export default function SettingsScreen() {
  const { t, i18n } = useAppTranslation();
  const user = useAuthStore((s) => s.user);
  const selfPresence = useSelfPresenceAsSeen();
  const accountCount = useAccountsStore((s) => s.accounts.length);
  const checkForUpdates = useUpdatesStore((s) => s.check);
  const insets = useSafeAreaInsets();
  const [signingOut, setSigningOut] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  // Language preference: "system" (follow OS) or an explicit locale. Read once
  // from the persisted choice; changing it applies live and re-persists.
  const [langPref, setLangPref] = useState<LanguagePreference>("system");
  useEffect(() => {
    let active = true;
    void getLanguagePreference().then((pref) => {
      if (active) setLangPref(pref);
    });
    return () => {
      active = false;
    };
  }, []);

  const name = user?.displayName || user?.username || t("mobile:common.you");

  const updateInfo = currentUpdateInfo();
  const updateSubtitle = updateInfo.enabled
    ? updateInfo.channel
      ? t("mobile:settings.checkUpdatesChannel", { channel: updateInfo.channel })
      : t("mobile:settings.checkUpdatesLatest")
    : t("mobile:settings.checkUpdatesReleaseOnly");

  // "About" data, read at runtime (never hardcoded). App version comes from the
  // bundled Expo config; runtime version prefers the live `expo-updates` value
  // and falls back to the config so it still shows in dev / Expo Go where
  // `Updates.runtimeVersion` is null. `runtimeVersion` may be an object under a
  // policy config, so we only accept the plain-string form.
  const appVersion = Constants.expoConfig?.version ?? null;
  const runtimeVersion =
    updateInfo.runtimeVersion ??
    (typeof Constants.expoConfig?.runtimeVersion === "string" ? Constants.expoConfig.runtimeVersion : null);
  const versionValue =
    appVersion && runtimeVersion
      ? t("mobile:settings.versionValue", { version: appVersion, runtime: runtimeVersion })
      : (appVersion ?? runtimeVersion ?? t("mobile:settings.versionUnknown"));
  // Short OTA update id: only present in a build that has taken an update.
  const shortUpdateId = updateInfo.updateId ? updateInfo.updateId.slice(0, 8) : null;

  const onSelectLanguage = (key: string) => {
    const pref = key as LanguagePreference;
    setLangPref(pref);
    void applyLanguagePreference(i18n, pref);
  };

  /** Run the real OTA check and say what it found, without a blocking dialog. */
  const onCheckUpdates = () => {
    setCheckingUpdate(true);
    void checkForUpdates({ manual: true })
      .then((result) => {
        const key = "update-check";
        switch (result) {
          case "up-to-date":
            toast({ key, variant: "success", title: t("mobile:settings.updateUpToDateTitle"), description: t("mobile:settings.updateUpToDateBody") });
            break;
          case "ready":
            toast({ key, variant: "accent", title: t("mobile:settings.updateReadyTitle"), description: t("mobile:settings.updateReadyBody") });
            break;
          case "downloading":
            toast({ key, title: t("mobile:settings.updateDownloadingTitle"), description: t("mobile:settings.updateDownloadingBody") });
            break;
          case "disabled":
            toast({ key, title: t("mobile:settings.updateDisabledTitle"), description: t("mobile:settings.updateDisabledBody") });
            break;
          case "error":
            toast({
              key,
              variant: "danger",
              title: t("mobile:settings.updateErrorTitle"),
              description: t("mobile:settings.updateErrorBody"),
              action: { label: t("common:buttons.retry"), onPress: onCheckUpdates },
            });
            break;
          // "critical" -> the blocking screen takes over; nothing to say here.
        }
      })
      .finally(() => setCheckingUpdate(false));
  };

  const onLogout = () => {
    setSigningOut(true);
    // Multi-account (ADR 0013): log out the ACTIVE account. If another stored
    // account remains the manager switches to it (staying authenticated); if none
    // remain it signs out and the (app) guard redirects to sign-in.
    void logoutActiveAccount().finally(() => {
      setSigningOut(false);
      setConfirmSignOut(false);
    });
  };

  return (
    <Screen>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl + insets.bottom, gap: space.xl }}
      >
        {/* Identity card — the same banner + avatar the profile card draws. */}
        <Touchable
          onPress={() => router.push("/profile")}
          accessibilityRole="button"
          accessibilityLabel={`${name}. ${t("mobile:settings.editProfile")}`}
          tone={colors.surface}
          pressedTone={colors.surfaceRaised}
          style={{ borderRadius: radius.card, borderCurve: "continuous", overflow: "hidden" }}
        >
          <ProfileBannerImage bannerUrl={user?.bannerUrl} seedId={user?.id ?? "self"} height={64} />
          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space.md, paddingHorizontal: space.lg, paddingBottom: space.lg, marginTop: -28 }}>
            <View style={{ padding: 3, borderRadius: radius.pill, backgroundColor: colors.surface }}>
              <Avatar name={name} size={56} presence={selfPresence} uri={user?.avatarUrl} ringColor={colors.surface} />
            </View>
            <View style={{ flex: 1, paddingBottom: 2 }}>
              <Text type="subheading" tone="display" numberOfLines={1}>
                {name}
              </Text>
              {user?.username ? (
                <Text type="meta" tone="muted" numberOfLines={1} style={{ fontWeight: "400" }}>
                  @{user.username}
                </Text>
              ) : null}
            </View>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: space.xs,
                paddingHorizontal: space.md,
                paddingVertical: space.xs + 2,
                borderRadius: radius.pill,
                backgroundColor: colors.surfaceRaised,
                marginBottom: 2,
              }}
            >
              <Pencil size={13} color={colors.fg} strokeWidth={2} />
              <Text type="meta" tone="default" style={{ fontWeight: "600" }}>
                {t("mobile:settings.editShort")}
              </Text>
            </View>
          </View>
        </Touchable>

        <SettingsSection title={t("mobile:settings.sectionAccount")} separatorInset={ROW_ICON_INSET}>
          <SettingsRow
            icon={ArrowLeftRight}
            title={t("mobile:accounts.switchTitle")}
            subtitle={t("mobile:accounts.switchSubtitle")}
            value={accountCount > 1 ? t("mobile:settings.accountCount", { count: accountCount }) : undefined}
            onPress={() => router.push("/switch-account")}
          />
          <SettingsRow
            icon={MonitorSmartphone}
            title={t("mobile:accounts.sessions.title")}
            subtitle={t("mobile:accounts.sessions.rowSubtitle")}
            onPress={() => router.push("/active-sessions")}
          />
          {/* M18 (ADR 0017): the blocked-users list. One-directional by
              contract — "who I blocked", never "who blocked me". */}
          <SettingsRow
            icon={ShieldBan}
            title={t("mobile:block.settingsRowTitle")}
            subtitle={t("mobile:block.settingsRowSubtitle")}
            onPress={() => router.push("/blocked-users")}
          />
        </SettingsSection>

        <SettingsSection title={t("mobile:settings.sectionApp")} separatorInset={ROW_ICON_INSET}>
          <SettingsRow
            icon={RefreshCw}
            title={t("mobile:settings.checkUpdatesTitle")}
            subtitle={updateSubtitle}
            onPress={onCheckUpdates}
            busy={checkingUpdate}
          />
          <SettingsBlock label={t("language.label")} hint={t("mobile:settings.languageHint")}>
            <ChipSelect
              accessibilityLabel={t("language.label")}
              options={[
                { key: "system", label: t("mobile:settings.languageSystem") },
                { key: "tr", label: t("language.tr") },
                { key: "en", label: t("language.en") },
              ]}
              selectedKey={langPref}
              onSelect={onSelectLanguage}
            />
          </SettingsBlock>
        </SettingsSection>

        <NotificationPermissionRow />

        <MicSettings />

        <AudioProfileSettings />

        <EchoCancellerSettings />

        <VideoSettings />

        <SoundSettings />

        <HapticsSettings />

        <SettingsSection title={t("mobile:settings.sectionAbout")} separatorInset={ROW_ICON_INSET}>
          <SettingsRow icon={Info} title={t("mobile:settings.versionTitle")} subtitle={versionValue} chevron={false} />
          {shortUpdateId ? (
            <SettingsRow icon={Hash} title={t("mobile:settings.updateIdTitle")} subtitle={shortUpdateId} chevron={false} />
          ) : null}
        </SettingsSection>

        <SettingsSection>
          <SettingsRow
            icon={LogOut}
            title={t("buttons.signOut")}
            subtitle={accountCount > 1 ? t("mobile:settings.signOutSwitches") : t("mobile:settings.signOutLast")}
            destructive
            busy={signingOut}
            onPress={() => setConfirmSignOut(true)}
          />
        </SettingsSection>

        <Text type="caption" tone="faint" style={{ textAlign: "center" }}>
          {t("mobile:settings.tagline")}
        </Text>
      </ScrollView>

      <ConfirmSheet
        visible={confirmSignOut}
        title={t("mobile:settings.signOutTitle", { name: user?.username ? `@${user.username}` : name })}
        body={accountCount > 1 ? t("mobile:settings.signOutSwitches") : t("mobile:settings.signOutLast")}
        confirmLabel={t("buttons.signOut")}
        confirmIcon={LogOut}
        onConfirm={onLogout}
        cancelLabel={t("common:buttons.cancel")}
        onCancel={() => setConfirmSignOut(false)}
        busy={signingOut}
      />
    </Screen>
  );
}
