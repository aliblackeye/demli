import { ScrollView, View } from "react-native";
import { Text } from "./ui/Text";
import { CalendarCheck, EyeOff, ShieldAlert } from "lucide-react-native";
import { nsfwGateStage } from "@demli/client-core";
import type { Channel } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { Button } from "@/components/Button";
import { BirthdateVerification } from "@/components/BirthdateVerification";
import { useNsfwGateStore } from "@/stores/nsfw-gate-store";
import { colors, radius, space } from "@/theme/theme";

/**
 * Age gate shown INSTEAD of a channel's messages + composer when it is marked
 * NSFW. Which of the three stages renders is decided by the shared,
 * framework-free `nsfwGateStage` (client-core), so mobile and desktop/web gate
 * identically:
 *
 * - `verifyAge`    — no date of birth on file. The user verifies RIGHT HERE
 *                    instead of being sent to profile settings: on success the
 *                    `me` cache updates, `isAdult` flips, and this re-renders
 *                    straight to the acknowledgement — no reload, no navigation.
 * - `minorBlocked` — a date of birth IS on file and it is under 18. A final,
 *                    honest refusal with NO input and no "try again": the value
 *                    is set-once server-side, so a field here would be a control
 *                    that cannot work (§35).
 * - `confirmAdult` — adult, not yet acknowledged: the one-time "this channel is
 *                    18+" prompt, remembered per channel so it does not nag.
 */
export function NsfwChannelGate({
  channel,
  isAdult,
  birthdateSet,
}: {
  channel: Channel;
  isAdult: boolean;
  /** Whether the account already has a (set-once) date of birth stored. */
  birthdateSet: boolean;
}) {
  const { t } = useAppTranslation();
  const confirm = useNsfwGateStore((s) => s.confirm);
  const acknowledged = useNsfwGateStore((s) => !!s.confirmedByChannel[channel.id]);

  const stage = nsfwGateStage({ isAdult, birthdateSet, acknowledged });
  if (stage === null) return null;

  const title =
    stage === "confirmAdult"
      ? t("mobile:nsfwGate.warnTitle")
      : stage === "verifyAge"
        ? t("mobile:nsfwGate.verifyTitle")
        : t("mobile:nsfwGate.blockTitle");
  const body =
    stage === "confirmAdult"
      ? t("mobile:nsfwGate.warnBody", { channel: channel.name })
      : stage === "verifyAge"
        ? t("mobile:nsfwGate.verifyBody", { channel: channel.name })
        : t("mobile:nsfwGate.blockBody");

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.app }}
      contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: space.xl }}
      keyboardShouldPersistTaps="handled"
    >
      <View
        style={{
          alignItems: "center",
          gap: space.md,
          padding: space.xl,
          borderRadius: radius.lg,
          borderCurve: "continuous",
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: colors.stroke,
        }}
      >
        <View
          style={{
            width: 56,
            height: 56,
            borderRadius: radius.pill,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: colors.dangerSurface,
          }}
        >
          {stage === "confirmAdult" ? (
            <EyeOff size={26} color={colors.danger} />
          ) : stage === "verifyAge" ? (
            <CalendarCheck size={26} color={colors.danger} />
          ) : (
            <ShieldAlert size={26} color={colors.danger} />
          )}
        </View>

        <Text
          variant="display"
          style={{ color: colors.fg, fontSize: 18, fontWeight: "800", textAlign: "center" }}
        >
          {title}
        </Text>
        <Text style={{ color: colors.fgMuted, fontSize: 14, lineHeight: 20, textAlign: "center" }}>
          {body}
        </Text>

        {stage === "confirmAdult" ? (
          <View style={{ alignSelf: "stretch", paddingTop: space.sm }}>
            <Button label={t("mobile:nsfwGate.continue")} onPress={() => confirm(channel.id)} />
          </View>
        ) : null}
        {stage === "verifyAge" ? (
          <View style={{ alignSelf: "stretch", paddingTop: space.sm }}>
            <BirthdateVerification />
          </View>
        ) : null}
        {/* `minorBlocked` renders no action at all — there is nothing the user
            can do here, and offering a button would promise otherwise. */}
      </View>
    </ScrollView>
  );
}
