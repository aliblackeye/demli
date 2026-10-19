import { useEffect } from "react";
import { Bell, BellOff, BellRing, Check, Info } from "lucide-react";
import { Button } from "@demli/ui";
import { useAppTranslation } from "../lib/i18n";
import { isWebSurface } from "../lib/surface";
import { useNotificationSettings } from "../notifications/notification-settings";
import {
  useWebNotificationPermission,
  webNotificationsSupported,
} from "../notifications/web-permission";
import { SettingRow, SettingsGroup, SettingsNote } from "./settings-kit";
import { Toggle } from "./Toggle";

/**
 * Browser permission row — WEB ONLY.
 *
 * Electron shows OS toasts through the preload bridge and needs no permission,
 * so this whole block is absent there. In a browser it is the difference between
 * working notifications and none at all: nothing in the app may request the
 * permission on load (see notifications/web-permission.ts for why a load-time
 * prompt is a permanent, unrecoverable loss), so the request has to hang off a
 * real click, and it lives here.
 *
 * The state is reported honestly in all four cases — including `denied`, where
 * script can never re-prompt and the only honest thing to say is "unblock it in
 * the browser's site settings". A switch that looks on while nothing happens is
 * exactly what shipped before, and it is worse than an off switch.
 */
function WebPermissionRow(): JSX.Element {
  const { t } = useAppTranslation();
  const status = useWebNotificationPermission((s) => s.status);
  const requesting = useWebNotificationPermission((s) => s.requesting);
  const request = useWebNotificationPermission((s) => s.request);
  const refresh = useWebNotificationPermission((s) => s.refresh);

  // The user can flip the permission in browser UI without telling us; re-read
  // whenever the tab comes back so Settings never shows a stale answer.
  useEffect(() => {
    refresh();
    const onFocus = (): void => refresh();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refresh]);

  const description =
    status === "granted"
      ? t("desktop:notificationSettings.permissionGranted")
      : status === "denied"
        ? t("desktop:notificationSettings.permissionDenied")
        : status === "unsupported"
          ? t("desktop:notificationSettings.permissionUnsupported")
          : t("desktop:notificationSettings.permissionDefault");

  const icon = status === "granted" ? Check : status === "denied" || status === "unsupported" ? BellOff : BellRing;

  return (
    <SettingRow icon={icon} title={t("desktop:notificationSettings.permission")} description={description}>
      {status === "default" ? (
        <Button
          variant="secondary"
          size="sm"
          loading={requesting}
          onClick={() => {
            void request();
          }}
        >
          {t("desktop:notificationSettings.permissionEnable")}
        </Button>
      ) : undefined}
    </SettingRow>
  );
}

/**
 * "Bildirimler" settings section: the master switch for notifications, plus (on
 * the web build only) the browser permission row.
 *
 * Notifications now work on BOTH surfaces — Electron OS toasts and browser
 * notifications — and when neither can fire, alerts fall back to an in-app
 * toast, so the app is never silent. The trailing note explains the actual rule
 * the app follows: you are only left alone while you are already looking at the
 * conversation in question.
 */
export function NotificationSettings(): JSX.Element {
  const { t } = useAppTranslation();
  const enabled = useNotificationSettings((s) => s.enabled);
  const setEnabled = useNotificationSettings((s) => s.setEnabled);
  const hasBridge = Boolean(window.demli?.notifications);
  const isWeb = isWebSurface();
  // Web with no Notification API at all (old iOS Safari): the permission row has
  // nothing to offer, so it collapses to the unsupported line in the note below.
  const showPermissionRow = isWeb && webNotificationsSupported();

  return (
    <div className="space-y-8">
      <SettingsGroup title={t("desktop:notificationSettings.heading")}>
        <SettingRow
          icon={Bell}
          title={t("desktop:notificationSettings.enable")}
          description={t("desktop:notificationSettings.enableDesc")}
        >
          <Toggle
            checked={enabled}
            disabled={!hasBridge}
            onChange={setEnabled}
            label={t("desktop:notificationSettings.enable")}
          />
        </SettingRow>
        {showPermissionRow && <WebPermissionRow />}
      </SettingsGroup>
      <SettingsNote icon={Info}>{t("desktop:notificationSettings.note")}</SettingsNote>
    </div>
  );
}
