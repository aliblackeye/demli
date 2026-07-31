import { useEffect } from "react";
import { BackHandler, Pressable, StyleSheet, View } from "react-native";
import { Text } from "../ui/Text";
import { router } from "expo-router";
import { Phone, PhoneOff, Video } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { haptics } from "@/lib/haptics";
import { getCallController, useCallState } from "@/stores/call-store";
import { colors, radius, space } from "@/theme/theme";
import { RingingScreen } from "./RingingScreen";
import { BusyCallBanner } from "./BusyCallBanner";

/** A round call action (accept / video / decline) with a label under it. */
function ActionButton({
  Icon,
  color,
  label,
  onPress,
}: {
  Icon: typeof Phone;
  color: string;
  label: string;
  onPress: () => void;
}) {
  return (
    <View style={{ alignItems: "center", gap: space.xs }}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={({ pressed }) => ({
          width: 64,
          height: 64,
          borderRadius: radius.pill,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: color,
          opacity: pressed ? 0.85 : 1,
        })}
      >
        <Icon size={26} color={colors.onAccent} />
      </Pressable>
      <Text style={{ color: colors.fgMuted, fontSize: 12 }}>{label}</Text>
    </View>
  );
}

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
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.app, zIndex: 50, elevation: 50 }]}>
      <RingingScreen
        name={name}
        avatarUri={caller?.avatarUrl}
        statusLine={statusLine}
        actions={
          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-evenly",
              alignItems: "flex-start",
            }}
          >
            <ActionButton
              Icon={PhoneOff}
              color={colors.danger}
              label={t("mobile:call.decline")}
              onPress={decline}
            />
            <ActionButton
              Icon={Video}
              color={colors.accent}
              label={t("mobile:call.acceptVideo")}
              onPress={() => accept(true)}
            />
            <ActionButton
              Icon={Phone}
              color={colors.online}
              label={t("mobile:call.accept")}
              onPress={() => accept(false)}
            />
          </View>
        }
      />
    </View>
  );
}
