import { ActivityIndicator, Pressable, View } from "react-native";
import { Text } from "../components/ui/Text";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowDownToLine, X } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { colors, radius, space } from "../theme/theme";
import { APK_INSTALL_SUPPORTED } from "./native-apk";
import { useNativeUpdateStore } from "./native-update-store";

/**
 * Subtle, dismissible banner for an OPTIONAL native update — a newer APK exists
 * but the installed runtime is still supported. Unlike the OTA banner (which
 * reloads), this drives the full IN-APP install flow: tapping "Update" downloads
 * the APK with progress, then launches the Android installer — never a browser.
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
  const insets = useSafeAreaInsets();

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
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        paddingBottom: insets.bottom + space.md,
        paddingHorizontal: space.lg,
        alignItems: "center",
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: space.md,
          maxWidth: 420,
          backgroundColor: colors.surfaceRaised,
          borderColor: colors.stroke,
          borderWidth: 1,
          borderRadius: radius.pill,
          borderCurve: "continuous",
          paddingLeft: space.lg,
          paddingRight: space.sm,
          paddingVertical: space.sm,
          // Warm near-black lift — the string form of `elevation.panel`.
          boxShadow: "0 6px 20px rgba(8,3,1,0.5)",
        }}
      >
        <ArrowDownToLine size={16} color={colors.accent} />
        <Text style={{ color: colors.fg, fontSize: 13, fontWeight: "600", flexShrink: 1 }}>
          {label}
        </Text>

        {busy ? (
          <ActivityIndicator size="small" color={colors.accent} />
        ) : (
          <Pressable
            onPress={() =>
              phase === "downloaded" ? void installDownloaded() : void startUpdate()
            }
            style={({ pressed }) => ({
              backgroundColor: colors.accent,
              opacity: pressed ? 0.85 : 1,
              borderRadius: radius.pill,
              borderCurve: "continuous",
              paddingHorizontal: space.md,
              paddingVertical: space.xs + 2,
            })}
          >
            <Text style={{ color: colors.onAccent, fontSize: 13, fontWeight: "700" }}>
              {phase === "downloaded"
                ? t("mobile:updates.nativeInstall")
                : phase === "error"
                  ? t("mobile:updates.nativeRetry")
                  : t("mobile:updates.nativeUpdate")}
            </Text>
          </Pressable>
        )}

        <Pressable
          onPress={dismissBanner}
          hitSlop={8}
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, padding: space.xs })}
        >
          <X size={16} color={colors.fgMuted} />
        </Pressable>
      </View>
    </View>
  );
}
