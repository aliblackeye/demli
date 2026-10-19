import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useAppTranslation } from "@/lib/i18n";
import { InCallView } from "@/components/call/InCallView";
import { RingingScreen } from "@/components/call/RingingScreen";
import { SeatAwayView } from "@/components/call/SeatAwayView";
import { callOutcomeLabel } from "@/components/call/call-outcome";
import { useCallState } from "@/stores/call-store";
import { colors, space } from "@/theme/theme";

/**
 * The DM-call screen (ADR 0012 / plan Wave 7) — the surface for a call that is
 * OURS to be on: outgoing ring (caller), a brief "Connecting…" (callee just
 * accepted), the active in-call stage, and the ended outcome. The inbound ring
 * itself is the global overlay, not this screen.
 *
 * INSTANT ROOM (founder directive, desktop parity): the caller's OUTGOING phase is
 * NOT a waiting room. `start()` already joined the LiveKit room, so this renders
 * the same {@link InCallView} it renders when active — camera, screen share, mic,
 * deafen all live while the peer's phone rings. `InCallView` occupies the SAME
 * switch branch position in both phases, so answering never remounts it and an open
 * camera / screen share survives the transition untouched.
 *
 * Owns orientation (react-native-screens Stack.Screen): PORTRAIT always, LANDSCAPE
 * only while a shared screen is watched fullscreen (founder #70) — the reason the
 * active call is a route and not a floating overlay. Leaving this screen keeps the
 * call alive (app-scoped media); the global CallMiniBar taps back in.
 */
export default function CallScreen() {
  const { t } = useAppTranslation();
  const params = useLocalSearchParams<{ withVideo?: string; name?: string }>();
  const state = useCallState();
  const [shareFullscreen, setShareFullscreen] = useState(false);

  // Once we have seen a live phase, a return to `idle` means the call finished and
  // was dismissed → pop the screen. Guards the caller's start race (idle+pending
  // for a tick before `outgoing`), which must NOT pop.
  const sawLive = useRef(false);
  if (state.phase !== "idle") sawLive.current = true;

  useEffect(() => {
    if (state.phase === "idle" && sawLive.current && router.canGoBack()) {
      router.back();
    }
  }, [state.phase]);

  const peerName =
    state.peer?.displayName || state.peer?.username || params.name || t("mobile:call.inCall");

  return (
    // Pure black: every phase of a call (ring, stage, outcome) sits on the same
    // page, so moving between them never flashes a different tone.
    <View style={{ flex: 1, backgroundColor: colors.rail }}>
      <Stack.Screen
        options={{
          headerShown: false,
          orientation: shareFullscreen ? "landscape" : "portrait",
        }}
      />
      {renderBody()}
    </View>
  );

  function renderBody() {
    switch (state.phase) {
      // Ringing-out and active share ONE surface (instant room). Same component in
      // the same position → React reconciles instead of remounting, so published
      // camera / screen-share tracks ride straight through the answer.
      case "outgoing":
      case "active":
        // SEAT AWAY (ADR 0023 §1): the call is live, but its media is not on this
        // device — the account answered on another one (`elsewhere`, which is what
        // a `voice.session_replaced` now means instead of "call ended"), or the
        // user pressed Leave and the call kept running (`vacant`).
        //
        // `InCallView` would draw the full stage — mic, camera, screen share, the
        // participant grid — over a room this phone is not in: every control dead,
        // no audio, and no explanation. That media-less call screen is exactly the
        // state the founder could not make sense of. The band says what happened
        // and offers the one action that changes it. Ringing is excluded: nobody
        // has a seat yet, and the instant room means the caller IS in it.
        if (state.phase === "active" && state.seat !== "here") {
          return <SeatAwayView state={state} peerName={peerName} />;
        }
        return (
          <InCallView
            state={state}
            startWithVideo={params.withVideo === "1"}
            shareFullscreen={shareFullscreen}
            onShareFullscreenChange={setShareFullscreen}
            onMinimize={() => {
              if (router.canGoBack()) router.back();
            }}
          />
        );

      case "incoming":
        // We accepted and are joining media; the ring overlay already handed off.
        return (
          <RingingScreen
            name={peerName}
            avatarUri={state.peer?.avatarUrl}
            statusLine={t("mobile:call.connecting")}
            pulse={false}
            actions={<View />}
          />
        );

      case "ended":
        return (
          <RingingScreen
            name={peerName}
            avatarUri={state.peer?.avatarUrl}
            statusLine={callOutcomeLabel(state.endedReason, state.role, t)}
            pulse={false}
            actions={<View />}
          />
        );

      case "idle":
      default:
        // Caller start race (idle+pending) before `outgoing`, or a stale open.
        return (
          <View
            style={{
              flex: 1,
              alignItems: "center",
              justifyContent: "center",
              gap: space.md,
            }}
          >
            <ActivityIndicator color={colors.fgFaint} />
          </View>
        );
    }
  }
}
