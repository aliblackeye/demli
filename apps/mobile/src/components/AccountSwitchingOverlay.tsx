import { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
import { Text } from "./ui/Text";
import { useAppTranslation } from "@/lib/i18n";
import { useAccountsStore } from "@/stores/accounts-store";
import { colors, space } from "@/theme/theme";

/**
 * Absolute ceiling for how long the covering overlay may stay up. The ordered
 * switch already time-boxes both teardown (5s/step) and bringup (8s/step) and
 * clears `switching` in a finally, so it should always resolve well under this.
 * This is the last-resort net: the overlay must NEVER become a permanent screen
 * the user can only escape by force-killing the app (the founder's original
 * report). Comfortably above the worst-case switch time.
 */
const SWITCH_OVERLAY_SAFETY_TIMEOUT_MS = 15_000;

/**
 * Full-screen covering overlay shown while an account switch is in flight
 * (ADR 0013) — the mobile mirror of the desktop AccountSwitchingOverlay. Hides the
 * app during the ordered teardown+bringup so no previous-account data flashes
 * before the new identity's stores/cache are clean and its profile is loaded.
 *
 * While this is up, app/(app)/_layout has the whole navigation Stack UNMOUNTED,
 * so nothing behind it can re-render/reparent during the switch's store reset.
 */
export function AccountSwitchingOverlay() {
  const { t } = useAppTranslation();
  const switching = useAccountsStore((s) => s.switching);

  // Safety net: if `switching` is still true after the ceiling (an unforeseen
  // wedge the per-step time-boxes didn't catch), force it down so the app becomes
  // usable again instead of a permanent covering overlay.
  useEffect(() => {
    if (!switching) return;
    const timer = setTimeout(() => {
      console.warn("[accounts] switch overlay safety timeout — forcing dismiss");
      useAccountsStore.getState().setSwitching(false);
    }, SWITCH_OVERLAY_SAFETY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [switching]);

  if (!switching) return null;

  return (
    <View
      accessibilityRole="progressbar"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: colors.app,
        alignItems: "center",
        justifyContent: "center",
        gap: space.md,
        zIndex: 1000,
      }}
    >
      <ActivityIndicator size="large" color={colors.accent} />
      <Text style={{ color: colors.fgMuted, fontSize: 15, fontWeight: "600" }}>
        {t("mobile:accounts.switching")}
      </Text>
    </View>
  );
}
