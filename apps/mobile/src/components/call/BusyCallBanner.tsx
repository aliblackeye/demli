import { useEffect } from "react";
import { View } from "react-native";
import Animated from "react-native-reanimated";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Phone, PhoneOff } from "lucide-react-native";
import type { PendingInvite } from "@demli/client-core";
import { Avatar } from "@/components/Avatar";
import { FLOATING_BAR_ENTER, FLOATING_BAR_EXIT } from "@/components/voice/floating-bar-motion";
import { useAppTranslation } from "@/lib/i18n";
import { getCallController } from "@/stores/call-store";
import { playSound } from "@/sounds/sound-manager";
import { colors, radius, space } from "@/theme/theme";
import { IconButton } from "../ui/IconButton";
import { Text } from "../ui/Text";

/**
 * Compact "X is calling you" banner shown while ALREADY in a call (call UX wave
 * #1, Task 1). A second `call.invite` arriving mid-call is parked in the shared
 * FSM (`pendingInvite`) instead of being dropped; this floats a small banner over
 * the current surface with accept-and-switch / decline.
 *
 * Deliberately NOT the full-screen ring and deliberately NOT ringing (the looping
 * ringtone reacts to `phase`, which a parked invite never changes) — only a short
 * single blip on appear, so the ongoing call's audio is never disrupted. Rendered
 * by {@link IncomingCallOverlay} (which owns the global call overlay slot).
 *
 * Koyu Masa: a floating glass bar that drops in from the top (the banner motion)
 * and lifts away when answered or declined; the caller's face with the coral
 * speaking-style ring (someone is reaching for you), Decline as the solid pink
 * disc, Accept-and-switch as the solid coral one — the ring screen's grammar at
 * banner size.
 */
export function BusyCallBanner({ invite }: { invite: PendingInvite }) {
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();

  // Short single blip on appear (and if the parked invite is replaced by another).
  // Never the looping ring — it must not talk over the live call.
  useEffect(() => {
    playSound("message");
  }, [invite.callId]);

  const caller = invite.caller;
  const name = caller.displayName || caller.username || t("mobile:call.unknownCaller");
  const title =
    invite.media === "video"
      ? t("mobile:call.busyVideoCallingYou", { name })
      : t("mobile:call.busyCallingYou", { name });

  const accept = () => {
    void getCallController().acceptPendingInvite();
    router.push("/call");
  };
  const decline = () => {
    void getCallController().declinePendingInvite();
  };

  return (
    <Animated.View
      entering={FLOATING_BAR_ENTER.fromTop}
      exiting={FLOATING_BAR_EXIT.toTop}
      accessibilityRole="alert"
      style={{
        position: "absolute",
        left: space.sm,
        right: space.sm,
        top: insets.top + space.sm,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: space.sm,
          paddingLeft: space.md,
          paddingRight: space.sm,
          paddingVertical: space.sm,
          borderRadius: radius.xl,
          borderCurve: "continuous",
          backgroundColor: colors.glassStrong,
        }}
      >
        <Avatar name={name} size="md" uri={caller.avatarUrl} speaking />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ color: colors.fg, fontSize: 14, fontWeight: "600" }}>
            {title}
          </Text>
          <Text numberOfLines={1} style={{ color: colors.fgMuted, fontSize: 12 }}>
            {t("mobile:call.busySwitchHint")}
          </Text>
        </View>
        <IconButton
          icon={PhoneOff}
          variant="dangerSolid"
          size="md"
          haptic="medium"
          label={t("mobile:call.a11yBusyDecline")}
          onPress={decline}
        />
        <IconButton
          icon={Phone}
          variant="accent"
          size="md"
          haptic="medium"
          label={t("mobile:call.a11yBusyAccept")}
          onPress={accept}
        />
      </View>
    </Animated.View>
  );
}
