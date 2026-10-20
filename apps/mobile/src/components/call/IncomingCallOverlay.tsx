import { useEffect } from "react";
import { BackHandler, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import { router } from "expo-router";
import { Phone, PhoneOff, Video } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { haptics } from "@/lib/haptics";
import { CallControl } from "@/components/voice/VoiceControls";
import { getCallController, useCallState } from "@/stores/call-store";
import { colors, motion, space } from "@/theme/theme";
import { RingingScreen } from "./RingingScreen";
import { BusyCallBanner } from "./BusyCallBanner";

/**
 * Global incoming-call overlay (ADR 0012 / Wave 7). Mounted once in the authed
 * layout so it floats over WHATEVER screen is showing the instant a `call.invite`
 * lands (the shared call FSM sets phase → "incoming"). A phone-style ring:
 * accept, accept-with-video, or decline. Accepting navigates into the /call
 * screen (which owns orientation + the in-call stage); declining just dismisses.
 *
 * Outgoing ringing and the active call live on the /call screen, not here — this
 * overlay is the inbound ring, so it never disrupts the user's navigation stack
 * for a call they may decline. It ALSO renders the compact busy banner (a second
 * invite parked while already in a call) — the two never co-occur, so this one
 * component owns both "someone is calling you" surfaces.
 *
 * Koyu Masa (design system §5.1, "gelen arama"): the breathing coral light behind
 * the caller, then three round actions — Decline as the solid pink disc on the
 * left, Accept as the solid coral disc on the right (the warm call to action, not
 * a borrowed green), video in between on the neutral disc. The overlay fades in
 * over the screen underneath and fades out when the ring resolves.
 */
export function IncomingCallOverlay() {
  const { t } = useAppTranslation();
  const state = useCallState();

  // Android hardware back while the ring is up = decline (a phone-call
  // convention). Without this, back would navigate the screen UNDER the overlay
  // (or background the app) while the call keeps ringing. Registered only while
  // ringing; returning true consumes the event so it never falls through.
  const ringing = state.phase === "incoming";
  useEffect(() => {
    if (!ringing) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      void getCallController().decline();
      return true;
    });
    return () => sub.remove();
  }, [ringing]);

  // While already IN a call, a second invite is parked (not a full ring): show the
  // compact busy banner instead (Task 1). `pendingInvite` is only ever set while a
  // call is live, so it never collides with the full-screen ring below.
  if (state.phase !== "incoming") {
    return state.pendingInvite ? <BusyCallBanner invite={state.pendingInvite} /> : null;
  }

  const caller = state.peer;
  const name = caller ? caller.displayName || caller.username : t("mobile:call.unknownCaller");
  const statusLine =
    state.media === "video"
      ? t("mobile:call.incomingVideo")
      : t("mobile:call.incomingVoice");

  const accept = (withVideo: boolean) => {
    haptics.success();
    void getCallController().accept();
    router.push({
      pathname: "/call",
      params: withVideo ? { withVideo: "1" } : {},
    });
  };
  const decline = () => {
    haptics.error();
    void getCallController().decline();
  };

  return (
    <Animated.View
      entering={FadeIn.duration(motion.duration.standard).reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
      accessibilityViewIsModal
      style={[StyleSheet.absoluteFill, { backgroundColor: colors.rail, zIndex: 50, elevation: 50 }]}
    >
      <RingingScreen
        name={name}
        avatarUri={caller?.avatarUrl}
        statusLine={statusLine}
        statusTone="accent"
        actions={
          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-evenly",
              alignItems: "flex-start",
              paddingBottom: space.md,
            }}
          >
            <CallControl
              icon={PhoneOff}
              variant="dangerSolid"
              size="xl"
              haptic="none"
              label={t("mobile:call.decline")}
              onPress={decline}
            />
            <CallControl
              icon={Video}
              variant="secondary"
              size="xl"
              haptic="none"
              label={t("mobile:call.acceptVideo")}
              onPress={() => accept(true)}
            />
            <CallControl
              icon={Phone}
              variant="accent"
              size="xl"
              haptic="none"
              label={t("mobile:call.accept")}
              onPress={() => accept(false)}
            />
          </View>
        }
      />
    </Animated.View>
  );
}
