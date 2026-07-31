import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, View } from "react-native";
import { Text } from "@/components/ui/Text";
import { router } from "expo-router";
import Constants from "expo-constants";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronRight, Hash, Info, MonitorSmartphone, RefreshCw, ShieldBan } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { AudioProfileSettings } from "@/components/AudioProfileSettings";
import { NotificationPermissionRow } from "@/components/NotificationPermissionRow";
import { Avatar } from "@/components/Avatar";
import { Button } from "@/components/Button";
import { ChipSelect } from "@/components/ChipSelect";
import { HapticsSettings } from "@/components/HapticsSettings";
import { MicSettings } from "@/components/MicSettings";
import { Row } from "@/components/Row";
import { Screen } from "@/components/Screen";
import { SoundSettings } from "@/components/SoundSettings";
import { VideoSettings } from "@/components/VideoSettings";
import { applyLanguagePreference, getLanguagePreference, type LanguagePreference } from "@/lib/i18n";
import { useAuthStore } from "@/stores/auth-store";
import { logoutActiveAccount } from "@/lib/account-manager";
import { currentUpdateInfo } from "@/updates/updates";
import { useUpdatesStore } from "@/updates/updates-store";
import { colors, radius, space, typography } from "@/theme/theme";

function SectionLabel({ children }: { children: string }) {
  return (
    <Text
      style={{
        color: colors.fgFaint,
        fontSize: typography.size["2xs"],
        fontWeight: "700",
        letterSpacing: 0.6,
        textTransform: "uppercase",
        paddingHorizontal: space.lg,
        paddingTop: space.lg,
        paddingBottom: space.xs,
      }}
    >
      {children}
    </Text>
  );
}

export default function SettingsScreen() {
  const { t, i18n } = useAppTranslation();
  const user = useAuthStore((s) => s.user);
  const checkForUpdates = useUpdatesStore((s) => s.check);
  const insets = useSafeAreaInsets();
  const [signingOut, setSigningOut] = useState(false);
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
    (typeof Constants.expoConfig?.runtimeVersion === "string"
      ? Constants.expoConfig.runtimeVersion
      : null);
  const versionValue =
    appVersion && runtimeVersion
      ? t("mobile:settings.versionValue", { version: appVersion, runtime: runtimeVersion })
      : (appVersion ?? runtimeVersion ?? t("mobile:settings.versionUnknown"));
  // Short OTA update id (nice-to-have): only present in a build that has taken an
  // update, so the row is hidden otherwise (e.g. dev, or an untouched release).
  const shortUpdateId = updateInfo.updateId ? updateInfo.updateId.slice(0, 8) : null;

  const onSelectLanguage = (key: string) => {
    const pref = key as LanguagePreference;
    setLangPref(pref);
    void applyLanguagePreference(i18n, pref);
  };

  const onCheckUpdates = () => {
    setCheckingUpdate(true);
    void checkForUpdates({ manual: true })
      .then((result) => {
        switch (result) {
          case "up-to-date":
            Alert.alert(
              t("mobile:settings.updateUpToDateTitle"),
              t("mobile:settings.updateUpToDateBody"),
            );
            break;
          case "ready":
            Alert.alert(
              t("mobile:settings.updateReadyTitle"),
              t("mobile:settings.updateReadyBody"),
            );
            break;
          case "downloading":
            Alert.alert(
              t("mobile:settings.updateDownloadingTitle"),
              t("mobile:settings.updateDownloadingBody"),
            );
            break;
          case "disabled":
            Alert.alert(
              t("mobile:settings.updateDisabledTitle"),
              t("mobile:settings.updateDisabledBody"),
            );
            break;
          case "error":
            Alert.alert(
              t("mobile:settings.updateErrorTitle"),
              t("mobile:settings.updateErrorBody"),
            );
            break;
          // "critical" -> the blocking screen takes over; no alert needed.
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
    });
  };

  return (
    <Screen>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: space.xl + insets.bottom }}
      >
        <Pressable
          onPress={() => router.push("/profile")}
          accessibilityLabel={t("mobile:settings.editProfile")}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: space.md,
            padding: space.lg,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <Avatar name={name} size={56} presence="online" uri={user?.avatarUrl} />
          <View style={{ flex: 1 }}>
            <Text variant="display" style={{ color: colors.fg, fontSize: 18, fontWeight: "700" }}>{name}</Text>
            {user?.username ? (
              <Text style={{ color: colors.fgMuted, fontSize: 13 }}>@{user.username}</Text>
            ) : null}
            <Text style={{ color: colors.accent, fontSize: 13, marginTop: 2 }}>
              {t("mobile:settings.editProfile")}
            </Text>
          </View>
          <ChevronRight size={18} color={colors.fgFaint} />
        </Pressable>

        <SectionLabel>{t("mobile:settings.sectionApp")}</SectionLabel>
        <View style={{ paddingHorizontal: space.md }}>
          <Row
            title={t("mobile:settings.checkUpdatesTitle")}
            subtitle={updateSubtitle}
            leading={<RefreshCw size={20} color={colors.fgMuted} />}
            onPress={checkingUpdate ? undefined : onCheckUpdates}
            disabled={checkingUpdate}
            showChevron={!checkingUpdate}
            trailing={
              checkingUpdate ? <ActivityIndicator size="small" color={colors.fgMuted} /> : undefined
            }
          />
        </View>

        <NotificationPermissionRow />

        <MicSettings />

        <AudioProfileSettings />

        <VideoSettings />

        <SoundSettings />

        <HapticsSettings />

        <SectionLabel>{t("language.label")}</SectionLabel>
        <View style={{ paddingHorizontal: space.lg, gap: space.sm }}>
          <ChipSelect
            options={[
              { key: "system", label: t("mobile:settings.languageSystem") },
              { key: "tr", label: t("language.tr") },
              { key: "en", label: t("language.en") },
            ]}
            selectedKey={langPref}
            onSelect={onSelectLanguage}
          />
          <Text style={{ color: colors.fgFaint, fontSize: 12 }}>
            {t("mobile:settings.languageHint")}
          </Text>
        </View>

        <SectionLabel>{t("mobile:settings.sectionAccount")}</SectionLabel>
        <View style={{ paddingHorizontal: space.md, gap: space.xs }}>
          <Row
            title={t("mobile:accounts.sessions.title")}
            subtitle={t("mobile:accounts.sessions.rowSubtitle")}
            leading={<MonitorSmartphone size={20} color={colors.fgMuted} />}
            onPress={() => router.push("/active-sessions")}
          />
          {/* M18 (ADR 0017): the blocked-users list. One-directional by
              contract — "who I blocked", never "who blocked me". */}
          <Row
            title={t("mobile:block.settingsRowTitle")}
            subtitle={t("mobile:block.settingsRowSubtitle")}
            leading={<ShieldBan size={20} color={colors.fgMuted} />}
            onPress={() => router.push("/blocked-users")}
          />
        </View>
        <View style={{ paddingHorizontal: space.lg, paddingTop: space.sm }}>
          <Button
            label={t("buttons.signOut")}
            variant="danger"
            loading={signingOut}
            onPress={onLogout}
            style={{ borderRadius: radius.md }}
          />
        </View>

        <SectionLabel>{t("mobile:settings.sectionAbout")}</SectionLabel>
        <View style={{ paddingHorizontal: space.md, gap: space.xs }}>
          <Row
            title={t("mobile:settings.versionTitle")}
            subtitle={versionValue}
            leading={<Info size={20} color={colors.fgMuted} />}
            showChevron={false}
          />
          {shortUpdateId ? (
            <Row
              title={t("mobile:settings.updateIdTitle")}
              subtitle={shortUpdateId}
              leading={<Hash size={20} color={colors.fgMuted} />}
              showChevron={false}
            />
          ) : null}
        </View>

        <Text
          style={{
            color: colors.fgFaint,
            fontSize: 12,
            textAlign: "center",
            paddingTop: space.xl,
          }}
        >
          {t("mobile:settings.tagline")}
        </Text>
      </ScrollView>
    </Screen>
  );
}
