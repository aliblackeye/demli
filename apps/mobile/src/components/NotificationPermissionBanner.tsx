import { BellOff } from "lucide-react-native";
import { Banner } from "@/components/ui/Banner";
import { useAppTranslation } from "@/lib/i18n";
import { permissionAction, shouldShowPermissionBanner } from "@/push/permission-model";
import { useNotificationPermission } from "@/push/permission-store";
import { space } from "@/theme/theme";

/**
 * Home strip shown while notifications are OFF for Demli (field report
 * 2026-10-20: messages sent to a closed app produced nothing on the phone, and
 * nothing in the app said why). States the consequence in one line and offers
 * the one action that changes it — the in-app prompt while the OS still allows
 * it, otherwise the app's system settings page. Dismissible for this session
 * only: it is the reason pushes do not arrive, so it comes back next launch.
 *
 * Hidden while the answer is unknown or granted; the permission store is kept
 * fresh by PushController (launch + every return to the foreground).
 */
export function NotificationPermissionBanner() {
  const { t } = useAppTranslation();
  const status = useNotificationPermission((s) => s.status);
  const canAskAgain = useNotificationPermission((s) => s.canAskAgain);
  const dismissed = useNotificationPermission((s) => s.dismissed);
  const resolve = useNotificationPermission((s) => s.resolve);
  const dismiss = useNotificationPermission((s) => s.dismiss);

  if (!shouldShowPermissionBanner({ status, canAskAgain }, dismissed)) return null;

  const action = permissionAction({ status, canAskAgain });
  return (
    <Banner
      variant="warning"
      icon={BellOff}
      title={t("mobile:notifications.bannerTitle")}
      description={t("mobile:notifications.bannerBody")}
      action={{
        label:
          action === "request"
            ? t("mobile:notifications.bannerAllow")
            : t("mobile:notifications.bannerOpenSettings"),
        onPress: () => void resolve(),
      }}
      onDismiss={dismiss}
      dismissLabel={t("mobile:notifications.bannerDismiss")}
      style={{ marginHorizontal: space.md, marginTop: space.sm }}
    />
  );
}
