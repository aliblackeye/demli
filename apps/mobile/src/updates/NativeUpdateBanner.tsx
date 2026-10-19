import { ActivityIndicator, View } from "react-native";
import { ArrowDownToLine } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { Button } from "../components/ui/Button";
import { ProgressBar } from "../components/ui/ProgressBar";
import { colors } from "../theme/theme";
import { APK_INSTALL_SUPPORTED } from "./native-apk";
import { useNativeUpdateStore } from "./native-update-store";
import { UpdatePill } from "./UpdatePill";

/**
 * Subtle, dismissible pill for an OPTIONAL native update — a newer APK exists
 * but the installed runtime is still supported. Unlike the OTA banner (which
 * reloads), this drives the full IN-APP install flow: tapping "Update" downloads
 * the APK with a REAL progress bar under the label, then launches the Android
 * installer — never a browser.
 *
 * Phase-driven inline: idle → "Update"; downloading → progress %; downloaded →
 * "Install" (re-offered after an OS-install cancel, no re-download); installing →
 * spinner; error → "Try again". Shown only while the level is `optional`, the
 * banner isn't dismissed, and installs are supported (Android). Dismiss hides it
 * for the session; the next launch re-checks and may show it again.
 */
export function NativeUpdateBanner() {
  const { t } = useAppTranslation();
  const level = useNativeUpdateStore((s) => s.level);
  const dismissed = useNativeUpdateStore((s) => s.bannerDismissed);
  const phase = useNativeUpdateStore((s) => s.phase);
  const progress = useNativeUpdateStore((s) => s.progress);
  const startUpdate = useNativeUpdateStore((s) => s.startUpdate);
  const installDownloaded = useNativeUpdateStore((s) => s.installDownloaded);
  const dismissBanner = useNativeUpdateStore((s) => s.dismissBanner);

  // iOS can't sideload → nothing actionable, so never show the banner there.
  if (level !== "optional" || dismissed || !APK_INSTALL_SUPPORTED) return null;

  const percent = Math.round(progress * 100);
  const busy = phase === "downloading" || phase === "installing";

  const label =
    phase === "downloading"
      ? t("mobile:updates.nativeDownloading", { percent })
      : phase === "installing"
        ? t("mobile:updates.nativeInstalling")
        : phase === "downloaded"
          ? t("mobile:updates.nativeInstallReady")
          : phase === "error"
            ? t("mobile:updates.nativeInstallError")
            : t("mobile:updates.nativeOptionalBanner");

  return (
    <UpdatePill
      icon={ArrowDownToLine}
      label={label}
      onDismiss={dismissBanner}
      footer={
        phase === "downloading" ? (
          <ProgressBar value={progress} height={3} accessibilityLabel={label} />
        ) : null
      }
      action={
        busy ? (
          <View style={{ width: 40, alignItems: "center" }}>
            <ActivityIndicator size="small" color={colors.accent} />
          </View>
        ) : (
          <Button
            variant="accent"
            size="sm"
            label={
              phase === "downloaded"
                ? t("mobile:updates.nativeInstall")
                : phase === "error"
                  ? t("mobile:updates.nativeRetry")
                  : t("mobile:updates.nativeUpdate")
            }
            onPress={() => (phase === "downloaded" ? void installDownloaded() : void startUpdate())}
          />
        )
      }
    />
  );
}
