import { Pressable, View } from "react-native";
import { Text } from "../components/ui/Text";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { RefreshCw, X } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { colors, radius, space } from "../theme/theme";
import { useUpdatesStore } from "./updates-store";

/**
 * Subtle, dismissible banner for an OPTIONAL update that has been downloaded and
 * is ready to apply. Floats above the bottom safe area so it never blocks the
 * app. "Yeniden başlat" reloads into the new update now; the X dismisses it (the
 * update still applies on the next cold launch). Shown only in the `ready` phase.
 */
export function UpdateBanner() {
  const { t } = useAppTranslation();
  const phase = useUpdatesStore((s) => s.phase);
  const dismissed = useUpdatesStore((s) => s.bannerDismissed);
  const applyReady = useUpdatesStore((s) => s.applyReady);
  const dismissBanner = useUpdatesStore((s) => s.dismissBanner);
  const insets = useSafeAreaInsets();

  if (phase !== "ready" || dismissed) return null;

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
        <RefreshCw size={16} color={colors.accent} />
        <Text style={{ color: colors.fg, fontSize: 13, fontWeight: "600", flexShrink: 1 }}>
          {t("mobile:updates.bannerReady")}
        </Text>
        <Pressable
          onPress={() => void applyReady()}
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
            {t("mobile:updates.bannerRestart")}
          </Text>
        </Pressable>
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
