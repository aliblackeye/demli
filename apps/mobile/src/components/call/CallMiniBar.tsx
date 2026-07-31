import { useEffect } from "react";
import { Platform, Pressable, View } from "react-native";
import { Text } from "../ui/Text";
import { router, usePathname } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Phone, Smartphone } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { getCallController, useCallState } from "@/stores/call-store";
import { useInAppNotificationStore } from "@/stores/in-app-notification-store";
import { colors, elevation, radius, space } from "@/theme/theme";

/** How long an ended call's outcome lingers before the slot resets to idle. */
const ENDED_DISMISS_MS = 2800;

/**
 * Approximate native stack header height (below the status bar). The bar floats
 * OUTSIDE the Stack, so it can't read the real header height — this constant
 * drops it just under the header instead of covering the title/back button.
 */
const HEADER_HEIGHT = Platform.select({ ios: 44, android: 56, default: 56 });

/**
 * Extra drop applied while the in-app notification banner is showing, so the two
 * top overlays stack instead of colliding (the banner owns the very top). Roughly
 * the banner's height plus a gap.
 */
const BANNER_CLEARANCE = 64;

/**
 * Global "return to call" bar + ended-state auto-dismiss (ADR 0012 / Wave 7).
 * Mounted once in the authed layout:
 *
 *  - While a call is active/outgoing and the user has navigated AWAY from the
 *    /call screen (a call is app-scoped — leaving /call keeps media alive, like
 *    the voice room), a compact bar floats over every screen and taps back into
 *    the call. Hidden on /call itself and during the inbound ring (the overlay
 *    owns that).
 *  - When a call ENDS, it schedules the single `dismiss()` that returns the slot
 *    to idle after the outcome has shown (the /call screen reads the outcome in
 *    the meantime). Keyed on `phase` so a new ring arriving during the window
 *    cancels the pending dismiss instead of wiping the fresh call.
 */
export function CallMiniBar() {
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const state = useCallState();
  // Only re-renders when banner visibility flips (not on every store change).
  const bannerVisible = useInAppNotificationStore((s) => s.current !== null);

  // Ended → auto-dismiss to idle after a beat. Cleanup cancels it if the phase
  // changes first (e.g. a fresh incoming call reuses the slot).
  useEffect(() => {
    if (state.phase !== "ended") return;
    const timer = setTimeout(() => getCallController().dismiss(), ENDED_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [state.phase]);

  const onCallScreen = pathname.startsWith("/call");
  const show =
    (state.phase === "active" || state.phase === "outgoing") && !onCallScreen;
  if (!show) return null;

  const name =
    state.peer?.displayName || state.peer?.username || t("mobile:call.inCall");

  // The SEAT decides what this bar says (ADR 0023 §1), not the phase alone: a call
  // running on the user's other device — or one they walked out of and can still
  // walk back into — is live, but "Aramada" would be a lie about THIS phone. This
  // is the only surface that shows a seat-away call while the user is off the
  // /call route, so it also carries the take-the-seat action; without it the
  // founder's "leave on mobile, rejoin later" has no entry point from the app at
  // large.
  const seatedHere = state.seat === "here";
  const seatAway = state.phase === "active" && !seatedHere;
  const subtitle = seatAway
    ? state.seat === "elsewhere"
      ? t("mobile:call.seatElsewhere")
      : t("mobile:call.seatVacant")
    : state.phase === "outgoing"
      ? t("mobile:call.ringing")
      : t("mobile:call.inCall");
  const takeLabel =
    state.seat === "elsewhere" ? t("mobile:call.bringHere") : t("mobile:call.rejoin");

  // Sit just below the native header; drop further while a banner is up so the
  // two top overlays never overlap.
  const top =
    insets.top + HEADER_HEIGHT + space.sm + (bannerVisible ? BANNER_CLEARANCE : 0);

  return (
    <View
      style={{
        position: "absolute",
        left: space.sm,
        right: space.sm,
        top,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("mobile:call.a11yReturnToCall")}
        onPress={() => router.push("/call")}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: space.sm,
          paddingLeft: space.md,
          paddingRight: space.md,
          paddingVertical: space.sm,
          minHeight: 48,
          borderRadius: radius.md,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: colors.stroke,
          backgroundColor: colors.surface,
          opacity: pressed ? 0.9 : 1,
          ...elevation.panel,
        })}
      >
        <View
          style={{
            width: 32,
            height: 32,
            borderRadius: radius.pill,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: seatAway ? colors.surfaceRaised : colors.online,
          }}
        >
          {seatAway ? (
            <Smartphone size={16} color={colors.accent} />
          ) : (
            <Phone size={16} color={colors.onAccent} />
          )}
        </View>
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={{ color: colors.fg, fontSize: 14, fontWeight: "600" }}>
            {name}
          </Text>
          <Text numberOfLines={1} style={{ color: colors.fgMuted, fontSize: 12 }}>
            {subtitle}
          </Text>
        </View>
        {/* Take the seat straight from the bar. Tapping the bar body still opens
            /call (where the full band explains the state); this is the shortcut for
            the case the user already knows what they want. */}
        {seatAway ? (
          <Pressable
            onPress={() => void getCallController().joinHere()}
            disabled={state.pending}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={takeLabel}
            accessibilityState={{ disabled: state.pending }}
            style={({ pressed }) => ({
              paddingHorizontal: space.md,
              height: 32,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: radius.pill,
              backgroundColor: colors.online,
              opacity: state.pending ? 0.5 : pressed ? 0.8 : 1,
            })}
          >
            <Text style={{ color: colors.onAccent, fontSize: 12, fontWeight: "700" }}>
              {takeLabel}
            </Text>
          </Pressable>
        ) : null}
      </Pressable>
    </View>
  );
}
