import { useEffect } from "react";
import { Bell, BellOff } from "lucide-react-native";
import { SettingsRow, SettingsSection } from "./settings/SettingsSection";
import { useAppTranslation } from "@/lib/i18n";
import { useNotificationPermission } from "@/push/permission-store";

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
 *
 * State lives in the shared permission store (also behind the Home banner), so a
 * grant here re-registers the push token at once and the foreground listener
 * re-reads the answer when the user comes back from system settings.
 */
export function NotificationPermissionRow(): JSX.Element | null {
  const { t } = useAppTranslation();
  const status = useNotificationPermission((s) => s.status);
  const refresh = useNotificationPermission((s) => s.refresh);
  const resolve = useNotificationPermission((s) => s.resolve);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A read that failed (older OS, odd OEM) must not blank the settings screen
  // or claim the wrong answer — leave the row hidden.
  if (status === "unknown") return null;
  const granted = status === "granted";

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
        onPress={granted ? undefined : () => void resolve()}
        chevron={!granted}
      />
    </SettingsSection>
  );
}
