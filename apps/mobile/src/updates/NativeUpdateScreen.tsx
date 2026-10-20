import { useEffect, useRef } from "react";
import { useAppTranslation } from "@/lib/i18n";
import { Button } from "../components/ui/Button";
import { ProgressBar } from "../components/ui/ProgressBar";
import { APK_INSTALL_SUPPORTED } from "./native-apk";
import { useNativeUpdateStore } from "./native-update-store";
import { UpdateScreenFrame } from "./UpdateScreenFrame";

/**
 * Full-screen blocking gate for a FORCED native update — the installed APK's
 * runtime is below the supported floor (`minSupportedRuntimeVersion`). Rendered
 * by `NativeUpdateGate` INSTEAD of the app while the level is `forced`.
 *
 * The whole update happens IN-APP (the founder's mission): on mount it
 * auto-starts the download, shows progress, then launches the Android installer —
 * the user is never sent to a browser. If the OS install is cancelled the APK
 * stays on disk and this screen re-offers "Install" (no re-download). The screen
 * stays up until the user installs and relaunches on a supported runtime.
 *
 * iOS can't sideload, so there `APK_INSTALL_SUPPORTED` is false and we only show
 * the message (no download/install controls).
 */
export function NativeUpdateScreen() {
  const { t } = useAppTranslation();
  const phase = useNativeUpdateStore((s) => s.phase);
  const progress = useNativeUpdateStore((s) => s.progress);
  const targetVersion = useNativeUpdateStore((s) => s.targetVersion);
  const startUpdate = useNativeUpdateStore((s) => s.startUpdate);
  const installDownloaded = useNativeUpdateStore((s) => s.installDownloaded);

  // Auto-start the in-app download+install exactly once. Only fire from a resting
  // phase (idle, or an already-downloaded APK) so a user-cancelled install or an
  // error never re-triggers into a loop — after that they drive it by hand.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!APK_INSTALL_SUPPORTED || autoStarted.current || !targetVersion) return;
    if (phase === "idle" || phase === "downloaded") {
      autoStarted.current = true;
      void startUpdate();
    }
  }, [phase, targetVersion, startUpdate]);

  const percent = Math.round(progress * 100);

  const body =
    phase === "downloading"
      ? t("mobile:updates.nativeDownloading", { percent })
      : phase === "downloaded"
        ? t("mobile:updates.nativeInstallReadyBody")
        : phase === "installing"
          ? t("mobile:updates.nativeInstalling")
          : phase === "error"
            ? t("mobile:updates.nativeInstallError")
            : t("mobile:updates.nativeForcedBody");

  return (
    <UpdateScreenFrame title={t("mobile:updates.nativeForcedTitle")} body={body}>
      {phase === "downloading" ? (
        <ProgressBar value={progress} accessibilityLabel={body} />
      ) : null}

      {APK_INSTALL_SUPPORTED ? (
        phase === "downloaded" ? (
          <Button
            variant="primary"
            size="lg"
            block
            label={t("mobile:updates.nativeInstall")}
            onPress={() => void installDownloaded()}
          />
        ) : phase === "error" ? (
          <Button
            variant="primary"
            size="lg"
            block
            label={t("mobile:updates.nativeRetry")}
            onPress={() => void startUpdate()}
          />
        ) : (
          // idle / downloading / installing — a busy, non-interactive affordance.
          <Button
            variant="secondary"
            size="lg"
            block
            label={
              phase === "downloading"
                ? t("mobile:updates.nativeDownloading", { percent })
                : t("mobile:updates.nativeInstalling")
            }
            loading
          />
        )
      ) : null}
    </UpdateScreenFrame>
  );
}
