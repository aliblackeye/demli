import { RefreshCw } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { Button } from "../components/ui/Button";
import { UpdatePill } from "./UpdatePill";
import { useUpdatesStore } from "./updates-store";

/**
 * Subtle, dismissible pill for an OPTIONAL update that has been downloaded and
 * is ready to apply. Floats above the bottom safe area (and the tab bar) so it
 * never blocks the app. "Yeniden başlat" reloads into the new update now; the X
 * dismisses it (the update still applies on the next cold launch). Shown only in
 * the `ready` phase.
 */
export function UpdateBanner() {
  const { t } = useAppTranslation();
  const phase = useUpdatesStore((s) => s.phase);
  const dismissed = useUpdatesStore((s) => s.bannerDismissed);
  const applyReady = useUpdatesStore((s) => s.applyReady);
  const dismissBanner = useUpdatesStore((s) => s.dismissBanner);

  if (phase !== "ready" || dismissed) return null;

  return (
    <UpdatePill
      icon={RefreshCw}
      label={t("mobile:updates.bannerReady")}
      onDismiss={dismissBanner}
      action={
        <Button variant="accent" size="sm" label={t("mobile:updates.bannerRestart")} onPress={() => void applyReady()} />
      }
    />
  );
}
