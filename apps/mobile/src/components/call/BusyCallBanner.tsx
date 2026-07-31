import { useEffect } from "react";
import { Pressable, View } from "react-native";
import { Text } from "../ui/Text";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Phone, PhoneOff } from "lucide-react-native";
import type { PendingInvite } from "@demli/client-core";
import { Avatar } from "@/components/Avatar";
import { useAppTranslation } from "@/lib/i18n";
import { getCallController } from "@/stores/call-store";
import { playSound } from "@/sounds/sound-manager";
import { colors, elevation, radius, space } from "@/theme/theme";

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
    <View
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
          borderRadius: radius.md,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: colors.stroke,
          backgroundColor: colors.surface,
          ...elevation.panel,
        }}
      >
        <Avatar name={name} size={40} uri={caller.avatarUrl} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ color: colors.fg, fontSize: 14, fontWeight: "600" }}>
            {title}
          </Text>
          <Text numberOfLines={1} style={{ color: colors.fgMuted, fontSize: 12 }}>
            {t("mobile:call.busySwitchHint")}
          </Text>
        </View>
        <RoundButton
          Icon={PhoneOff}
          color={colors.danger}
          label={t("mobile:call.a11yBusyDecline")}
          onPress={decline}
        />
        <RoundButton
          Icon={Phone}
          color={colors.online}
          label={t("mobile:call.a11yBusyAccept")}
          onPress={accept}
        />
      </View>
    </View>
  );
}

function RoundButton({
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
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={({ pressed }) => ({
        width: 40,
        height: 40,
        borderRadius: radius.pill,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: color,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <Icon size={18} color={colors.onAccent} />
    </Pressable>
  );
}
