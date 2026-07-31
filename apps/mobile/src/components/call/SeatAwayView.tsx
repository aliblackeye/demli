import { Pressable, View } from "react-native";
import { Text } from "../ui/Text";
import { PhoneIncoming, PhoneOff, Smartphone } from "lucide-react-native";
import type { CallState } from "@demli/client-core";
import { useAppTranslation } from "@/lib/i18n";
import { getCallController } from "@/stores/call-store";
import { RingingScreen } from "./RingingScreen";
import { colors, radius, space } from "@/theme/theme";

/**
 * THE SEAT-AWAY SURFACE (ADR 0023 §1 / call-as-room plan W4) — what this phone
 * shows when the call is live but its media is NOT on this device.
 *
 * A DM call is two layers, and mobile only ever drew one of them:
 *
 *   MEMBERSHIP (`phase: "active"`) — "there is a live call here, both of you
 *                belong to it". Untouched by which device is talking.
 *   SEAT       (`state.seat`)      — "which device is actually in the audio".
 *
 * Before this, `phase === "active"` went straight to {@link InCallView} no matter
 * where the seat was, so the two normal seat-away states rendered as a broken call:
 *
 *  - `elsewhere` — the account answered on another device. LiveKit's single
 *    connection per identity had already evicted this one, so the user sat on a
 *    full in-call screen with NO media and a grid of controls driving a room they
 *    were not in (§35). That is the `session_replaced` regression: it stopped
 *    being terminal (correctly — the call is very much alive), and mobile had no
 *    band to move it to, so it showed nothing at all and the user could not tell
 *    what had happened.
 *  - `vacant` — the user pressed Leave. The call keeps running and they can walk
 *    back in, which is the entire point of the founder's scenario; with no surface
 *    for it there was nothing to walk back in FROM.
 *
 * So this is deliberately not a dead in-call screen with things greyed out. It is
 * a calm status screen with exactly the actions that are real here: take the seat
 * (`joinHere()` — the deliberate handoff the auto-join gate refuses to make on its
 * own) or end the call for everyone (`hangup()`).
 *
 * Reuses {@link RingingScreen} so the peer avatar/name keep their place across
 * ring → in-call → seat-away instead of the screen jumping between layouts.
 */
export function SeatAwayView({ state, peerName }: { state: CallState; peerName: string }) {
  const { t } = useAppTranslation();
  const elsewhere = state.seat === "elsewhere";

  // Same texts as the desktop seat band (packages/i18n) — the two platforms must
  // explain this state with one voice, since the whole point is that the user is
  // looking at BOTH devices.
  const title = elsewhere ? t("mobile:call.seatElsewhere") : t("mobile:call.seatVacant");
  const hint = elsewhere ? t("mobile:call.seatElsewhereHint") : t("mobile:call.seatVacantHint");
  const takeLabel = elsewhere ? t("mobile:call.bringHere") : t("mobile:call.rejoin");

  return (
    <RingingScreen
      name={peerName}
      avatarUri={state.peer?.avatarUrl}
      statusLine={title}
      // Nothing is ringing — a pulse here would read as "incoming".
      pulse={false}
      actions={
        <View style={{ gap: space.md }}>
          {/* The one line that says WHY the controls are gone and what taking the
              seat will cost (on `elsewhere`, it drops the other device). */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: space.sm,
              padding: space.md,
              borderRadius: radius.md,
              borderCurve: "continuous",
              borderWidth: 1,
              borderColor: colors.stroke,
              backgroundColor: colors.surface,
            }}
          >
            <View
              style={{
                width: 32,
                height: 32,
                borderRadius: radius.pill,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: colors.surfaceRaised,
              }}
            >
              {elsewhere ? (
                <Smartphone size={16} color={colors.accent} />
              ) : (
                <PhoneIncoming size={16} color={colors.accent} />
              )}
            </View>
            <Text style={{ flex: 1, color: colors.fgMuted, fontSize: 13, lineHeight: 18 }}>
              {hint}
            </Text>
          </View>

          <Pressable
            onPress={() => void getCallController().joinHere()}
            disabled={state.pending}
            accessibilityRole="button"
            accessibilityLabel={takeLabel}
            accessibilityState={{ disabled: state.pending }}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: space.sm,
              minHeight: 52,
              borderRadius: radius.pill,
              backgroundColor: colors.online,
              opacity: state.pending ? 0.5 : pressed ? 0.85 : 1,
            })}
          >
            <PhoneIncoming size={20} color={colors.onAccent} />
            <Text style={{ color: colors.onAccent, fontSize: 16, fontWeight: "700" }}>
              {takeLabel}
            </Text>
          </Pressable>

          {/* Ending the call is still reachable from here — leaving the room did
              not take away the ability to actually finish it. */}
          <Pressable
            onPress={() => void getCallController().hangup()}
            accessibilityRole="button"
            accessibilityLabel={t("mobile:call.hangUp")}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: space.sm,
              minHeight: 48,
              borderRadius: radius.pill,
              borderWidth: 1,
              borderColor: colors.stroke,
              backgroundColor: colors.surface,
              opacity: pressed ? 0.75 : 1,
            })}
          >
            <PhoneOff size={18} color={colors.danger} />
            <Text style={{ color: colors.danger, fontSize: 15, fontWeight: "600" }}>
              {t("mobile:call.hangUp")}
            </Text>
          </Pressable>
        </View>
      }
    />
  );
}
