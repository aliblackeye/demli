import { useCallback, useEffect, useState } from "react";
import { Linking } from "react-native";
import * as Notifications from "expo-notifications";
import { Bell, BellOff } from "lucide-react-native";
import { SettingsRow, SettingsSection } from "./settings/SettingsSection";
import { useAppTranslation } from "@/lib/i18n";

/**
 * Notification permission, made visible and recoverable.
 *
 * The app already asks at sign-in (`push-manager.ensurePermission`), but a denial
 * was a dead end: push silently never arrived, nothing in the UI said why, and on
 * Android a second `requestPermissionsAsync()` is a no-op once the user has said
 * no — so the app COULD not ask again even if it wanted to. The only way back is
 * the OS settings page, and the user had no reason to suspect that.
 *
 * Founder: "bildirimlere izin verin şeyi çıksın da bari bildirimler çalışsın …
 * ben izin vermesem çalışmayacaktı."
 *
 * So this row states the current answer plainly and gives the one action that can
 * change it. It is deliberately NOT a nag: when permission is granted it is a
 * quiet confirmation, not a banner demanding attention.
 */
export function NotificationPermissionRow(): JSX.Element | null {
  const { t } = useAppTranslation();
  const [granted, setGranted] = useState<boolean | null>(null);
  const [canAskAgain, setCanAskAgain] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const perms = await Notifications.getPermissionsAsync();
      setGranted(perms.granted);
      setCanAskAgain(perms.canAskAgain);
    } catch {
      // A permissions read that throws (older OS, odd OEM) must not blank the
      // settings screen — leave the row hidden rather than showing a lie.
      setGranted(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onPress = useCallback(() => {
    void (async () => {
      // Ask in-app while that is still possible; Android turns the prompt into a
      // no-op after a denial, and that is exactly when the OS settings page is
      // the only route.
      if (canAskAgain) {
        try {
          const res = await Notifications.requestPermissionsAsync();
          if (res.granted) {
            await refresh();
            return;
          }
        } catch {
          // fall through to settings
        }
      }
      await Linking.openSettings();
      // The user leaves the app to flip it; re-read when they come back.
      void refresh();
    })();
  }, [canAskAgain, refresh]);

  if (granted === null) return null;

  return (
    <SettingsSection
      title={t("mobile:notifications.permissionSection")}
      footer={granted ? undefined : t("mobile:notifications.permissionHint")}
    >
      <SettingsRow
        icon={granted ? Bell : BellOff}
        destructive={!granted}
        title={granted ? t("mobile:notifications.permissionOnTitle") : t("mobile:notifications.permissionOffTitle")}
        subtitle={granted ? t("mobile:notifications.permissionOnSubtitle") : t("mobile:notifications.permissionOffSubtitle")}
        onPress={granted ? undefined : onPress}
        chevron={!granted}
      />
    </SettingsSection>
  );
}
