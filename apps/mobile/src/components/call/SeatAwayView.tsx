import { View } from "react-native";
import { PhoneIncoming, PhoneOff, Smartphone } from "lucide-react-native";
import type { CallState } from "@demli/client-core";
import { useAppTranslation } from "@/lib/i18n";
import { getCallController } from "@/stores/call-store";
import { space } from "@/theme/theme";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { RingingScreen } from "./RingingScreen";

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
 *
 * Koyu Masa: the explanation is an info Banner (what happened, and what taking
 * the seat costs), the seat is the coral accent CTA (joining is the warm act),
 * and ending the call for everyone is the danger WASH button — destructive, but a
 * deliberate second choice, never as loud as the way back in.
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
          <Banner
            variant="info"
            icon={elsewhere ? Smartphone : PhoneIncoming}
            // The status line above already names the state; the banner carries
            // only the consequence, so nothing is said twice.
            title={hint}
          />

          <Button
            variant="accent"
            size="lg"
            block
            icon={PhoneIncoming}
            label={takeLabel}
            loading={state.pending}
            haptic="medium"
            onPress={() => void getCallController().joinHere()}
          />

          {/* Ending the call is still reachable from here — leaving the room did
              not take away the ability to actually finish it. */}
          <Button
            variant="danger"
            size="lg"
            block
            icon={PhoneOff}
            label={t("mobile:call.hangUp")}
            haptic="medium"
            onPress={() => void getCallController().hangup()}
          />
        </View>
      }
    />
  );
}
