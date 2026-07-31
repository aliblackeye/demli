import { useEffect, useRef } from "react";
import { View } from "react-native";
import { Text } from "../components/ui/Text";
import { useAppTranslation } from "@/lib/i18n";
import { Button } from "../components/Button";
import { colors, radius, space } from "../theme/theme";
import { APK_INSTALL_SUPPORTED } from "./native-apk";
import { useNativeUpdateStore } from "./native-update-store";

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
    <View
      style={{
        flex: 1,
        backgroundColor: colors.app,
        alignItems: "center",
        justifyContent: "center",
        padding: space.xl,
        gap: space.lg,
      }}
    >
      <View style={{ gap: space.sm, alignItems: "center" }}>
        <Text variant="display" style={{ color: colors.fg, fontSize: 20, fontWeight: "700", textAlign: "center" }}>
          {t("mobile:updates.nativeForcedTitle")}
        </Text>
        <Text style={{ color: colors.fgMuted, fontSize: 14, lineHeight: 20, textAlign: "center" }}>
          {body}
        </Text>
      </View>

      {phase === "downloading" ? <ProgressBar fraction={progress} /> : null}

      {APK_INSTALL_SUPPORTED ? (
        <View style={{ alignSelf: "stretch" }}>
          {phase === "downloaded" ? (
            <Button label={t("mobile:updates.nativeInstall")} onPress={() => void installDownloaded()} />
          ) : phase === "error" ? (
            <Button label={t("mobile:updates.nativeRetry")} onPress={() => void startUpdate()} />
          ) : (
            // idle / downloading / installing — a busy, non-interactive affordance.
            <Button
              label={
                phase === "downloading"
                  ? t("mobile:updates.nativeDownloading", { percent })
                  : t("mobile:updates.nativeInstalling")
              }
              loading
              disabled
            />
          )}
        </View>
      ) : null}
    </View>
  );
}

/** Slim determinate progress bar (0..1). No animation lib — width is the value. */
function ProgressBar({ fraction }: { fraction: number }) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <View
      style={{
        alignSelf: "stretch",
        height: 6,
        borderRadius: radius.pill,
        backgroundColor: colors.surfaceRaised,
        overflow: "hidden",
      }}
    >
      <View style={{ width: `${pct}%`, height: "100%", backgroundColor: colors.accent }} />
    </View>
  );
}
