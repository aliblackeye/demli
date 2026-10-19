import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, BackHandler, Easing, Pressable, View } from "react-native";
import { Text } from "../ui/Text";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronDown, UserPlus } from "lucide-react-native";
import type { CallState } from "@demli/client-core";
import type { UserId } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { useGroupDetails } from "@/queries/chat-queries";
import { getCallController } from "@/stores/call-store";
import { useAuthStore } from "@/stores/auth-store";
import { useChatStore } from "@/stores/chat-store";
import { useRemoteScreenShares, useVoiceStore } from "@/stores/voice-store";
import { AudioOutputControl } from "@/components/voice/AudioOutputControl";
import { useStageTiles } from "@/components/voice/use-stage-tiles";
import { VoiceControls } from "@/components/voice/VoiceControls";
import { VoiceNotices } from "@/components/voice/VoiceNotices";
import { VoiceStage } from "@/components/voice/VoiceStage";
import { colors, radius, space, typography } from "@/theme/theme";
import { AddPersonSheet } from "./AddPersonSheet";

/**
 * A small pulsing accent dot marking the ringing state in the call header. One
 * slow opacity loop, nothing else (§7 — not a motion demo); mirrors the desktop
 * ringing badge.
 */
function RingingDot() {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, {
          toValue: 1,
          duration: 700,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(anim, {
          toValue: 0,
          duration: 700,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [anim]);
  return (
    <Animated.View
      style={{
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: colors.accent,
        opacity: anim.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }),
      }}
    />
  );
}

/** mm:ss elapsed since the call went active (drives the header duration). */
function useElapsed(active: boolean): string | null {
  const [seconds, setSeconds] = useState(0);
  const startRef = useRef<number | null>(null);
  useEffect(() => {
    if (!active) {
      startRef.current = null;
      setSeconds(0);
      return;
    }
    startRef.current = Date.now();
    setSeconds(0);
    const id = setInterval(() => {
      if (startRef.current) setSeconds(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [active]);
  if (!active) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * The in-call surface for a LIVE DM call — ringing-out AND active (ADR 0012 / plan
 * Wave 7; instant-room directive). Desktop parity: the same voice/video stage as a
 * voice channel — participant grid ⇄ focus, screen-share WATCHING (host shares from
 * desktop), camera focus/fullscreen and the draggable active-speaker PiP — because
 * a call room IS a voice room and the shared engine already drives all of it
 * (voice-store). This view only adds the call chrome: a minimize handle, the
 * peer/group title + status, an "Add person" control (seamless group upgrade), and
 * hang-up.
 *
 * INSTANT ROOM: the CALLER lands here the moment the call starts, while the peer is
 * still ringing — `start()` has already joined LiveKit, so every control genuinely
 * works before anyone answers (founder: "sesli oda gibi olmalı"). The ringing state
 * is kept as a badge in the header, never as a blocking screen. Two consequences
 * handled here:
 *   - the duration timer starts on ANSWER, not on join (ringing shows "Ringing…");
 *   - the end button CANCELS while ringing and HANGS UP once active;
 *   - "Add person" is disabled while ringing (the server upgrades ACTIVE calls
 *     only, 409 otherwise) — disabled with a hint rather than a dead button (§35).
 *
 * Media state comes from `useVoiceStore` (mirrors the engine); the CALL context
 * (peer, surface, phase) comes from the passed `state`. Fullscreen is lifted to
 * the /call screen so it can force LANDSCAPE only while a share is fullscreen
 * (founder #70), keeping the call PORTRAIT otherwise.
 */
export function InCallView({
  state,
  startWithVideo,
  shareFullscreen,
  onShareFullscreenChange,
  onMinimize,
}: {
  state: CallState;
  startWithVideo: boolean;
  shareFullscreen: boolean;
  onShareFullscreenChange: (open: boolean) => void;
  onMinimize: () => void;
}) {
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();

  const status = useVoiceStore((s) => s.status);
  const micEnabled = useVoiceStore((s) => s.micEnabled);
  const deafened = useVoiceStore((s) => s.deafened);
  const cameraEnabled = useVoiceStore((s) => s.cameraEnabled);
  const screenShareEnabled = useVoiceStore((s) => s.screenShareEnabled);
  const toggleMic = useVoiceStore((s) => s.toggleMic);
  const toggleDeafen = useVoiceStore((s) => s.toggleDeafen);
  const toggleCamera = useVoiceStore((s) => s.toggleCamera);
  const toggleScreenShare = useVoiceStore((s) => s.toggleScreenShare);

  const shares = useRemoteScreenShares();
  const activeShare = shares[0] ?? null;

  const [addOpen, setAddOpen] = useState(false);

  // A screen share can vanish while fullscreen (host stops / we leave) — drop
  // fullscreen so the landscape lock releases and the phone returns to portrait.
  useEffect(() => {
    if (!activeShare && shareFullscreen) onShareFullscreenChange(false);
  }, [activeShare, shareFullscreen, onShareFullscreenChange]);

  // Android hardware back MINIMIZES the active call (leaves the /call route; the
  // call stays alive and the CallMiniBar taps back in) — it must never hang up.
  // Consuming the event (return true) also stops a back with no route stack (a
  // push-deep-linked call) from exiting the app and killing the call. A fullscreen
  // share instead just exits fullscreen; the stage owns its own back there.
  useEffect(() => {
    if (shareFullscreen) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      onMinimize();
      return true;
    });
    return () => sub.remove();
  }, [shareFullscreen, onMinimize]);

  const connected = status === "connected";
  /** Still ringing the peer — we are in the room, they have not answered yet. */
  const ringing = state.phase === "outgoing";

  // Auto-enable the camera once when a VIDEO call goes live (either the caller
  // started with `media:"video"` or the callee accepted with video). One-shot: we
  // never fight a later manual toggle. With the instant room this now fires while
  // still ringing — intended: a video call shows YOUR camera before they pick up.
  const wantVideo = startWithVideo || state.media === "video";
  const cameraKicked = useRef(false);
  useEffect(() => {
    if (wantVideo && connected && !cameraKicked.current && !cameraEnabled) {
      cameraKicked.current = true;
      toggleCamera();
    }
  }, [wantVideo, connected, cameraEnabled, toggleCamera]);

  // Names: prefer the (post-upgrade) group roster; fall back to the call peer,
  // self, then the realtime user directory, then a short id.
  const groupId = state.surface?.kind === "group" ? state.surface.groupId : undefined;
  const { data: group } = useGroupDetails(groupId ?? null);
  const me = useAuthStore((s) => s.user);
  const users = useChatStore((s) => s.users);
  const peer = state.peer;
  const nameFor = useMemo(() => {
    const byId = new Map<string, string>();
    for (const m of group?.members ?? []) {
      byId.set(m.userId, m.user.displayName || m.user.username);
    }
    if (peer) byId.set(peer.id, peer.displayName || peer.username);
    if (me) byId.set(me.id, me.displayName || me.username);
    return (userId: UserId): string => {
      const known = byId.get(userId);
      if (known) return known;
      const u = users[userId];
      if (u) return u.displayName || u.username;
      return userId.slice(0, 6);
    };
  }, [group?.members, users, peer, me]);

  /**
   * The same resolution ladder as `nameFor`, for the photo: group roster, then
   * the DM peer, then self, then the realtime user directory, then null. The DM
   * peer matters most here — in a 1-1 call they are often NOT in the users
   * directory yet, which is exactly why the call grid drew bare initials.
   */
  const avatarFor = useMemo(() => {
    const byId = new Map<string, string | null>();
    for (const m of group?.members ?? []) {
      byId.set(m.userId, m.user.avatarUrl ?? null);
    }
    if (peer) byId.set(peer.id, peer.avatarUrl ?? null);
    if (me) byId.set(me.id, me.avatarUrl ?? null);
    return (userId: UserId): string | null => {
      const known = byId.get(userId);
      if (known !== undefined) return known;
      return users[userId]?.avatarUrl ?? null;
    };
  }, [group?.members, users, peer, me]);

  // The stage, built by the SHARED builder the voice room also uses (which in
  // turn consumes `buildTiles` from `@demli/media`). This used to be an
  // 18-line copy of the room's memo — the copy is what let the two surfaces
  // drift, so there is now exactly one.
  const stage = useStageTiles({ nameFor, avatarFor });

  // Post-upgrade the surface carries the full group (from `call.upgraded`); fall
  // back to the fetched details, then the DM peer, then a generic label.
  const surfaceGroup = state.surface?.kind === "group" ? state.surface.group : undefined;
  const title =
    surfaceGroup?.name ??
    group?.group?.name ??
    (peer ? peer.displayName || peer.username : t("mobile:call.inCall"));
  // Talk time counts from the ANSWER, not from our (earlier) room join — the timer
  // resets to 0 the moment `ringing` clears.
  const duration = useElapsed(connected && !ringing);
  const statusLine = ringing
    ? t("mobile:call.ringing")
    : connected
      ? duration ?? t("mobile:call.inCall")
      : t("mobile:call.connecting");
  const sharerName = activeShare ? nameFor(activeShare.userId) : null;

  /**
   * The primary red button. Ringing → withdraw the invite (there is no room to
   * walk out of yet). Otherwise LEAVE THE ROOM (ADR 0023 §2) — NOT hang up.
   *
   * This is the founder's model verbatim: "mobilde ayrıl butonuna basıp ayrılıp bu
   * süre içerisinde masaüstünden o call'a katılabilmeliyim". `leaveRoom()` releases
   * only THIS device's media seat; the call row stays live, the peer is never told
   * the call ended, and the account can walk back in from any device until the
   * server's alone-grace elapses. The last-one-out case (nobody left behind) falls
   * through to a real hang-up INSIDE the controller — this surface must not
   * second-guess it, or the two platforms drift on who closes the row.
   */
  const endCall = () => {
    const controller = getCallController();
    if (ringing) void controller.cancel();
    else void controller.leaveRoom();
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.app }}>
      {/* Call header: minimize · title/duration · add person. Hidden while a share
          is fullscreen (the fullscreen viewer owns the whole screen). */}
      {!shareFullscreen ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: space.md,
            paddingTop: insets.top + space.sm,
            paddingHorizontal: space.lg,
            paddingBottom: space.sm,
          }}
        >
          <Pressable
            onPress={onMinimize}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={t("mobile:call.a11yMinimize")}
            style={({ pressed }) => ({
              width: 40,
              height: 40,
              borderRadius: radius.pill,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: colors.surfaceRaised,
              opacity: pressed ? 0.75 : 1,
            })}
          >
            <ChevronDown size={22} color={colors.fg} />
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text variant="display" numberOfLines={1} style={{ color: colors.fg, fontSize: 16, fontWeight: "700" }}>
              {title}
            </Text>
            {/* Ringing badge: the "calling" state stays visible while the room
                underneath is fully usable. */}
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
              {ringing ? <RingingDot /> : null}
              <Text
                numberOfLines={1}
                style={{ color: ringing ? colors.accent : colors.fgMuted, fontSize: 12 }}
              >
                {statusLine}
              </Text>
            </View>
          </View>
          {/* Speaker / earpiece / headset / bluetooth routing. The voice room has
              had this in its status strip since the D1 audit; a DM call had no way
              to reach the earpiece at all, which is the same room-vs-call
              asymmetry as the dead volume sheet. Self-hides unless a session is
              live, so it costs nothing while connecting. */}
          <AudioOutputControl />
          <Pressable
            // The upgrade endpoint requires an ACTIVE call, so this is genuinely
            // unavailable until the peer answers — disabled with a hint (§35).
            onPress={() => setAddOpen(true)}
            disabled={ringing}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={t("mobile:call.a11yAddPerson")}
            accessibilityHint={ringing ? t("mobile:call.addPersonNeedsAnswer") : undefined}
            accessibilityState={{ disabled: ringing }}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: space.xs,
              paddingHorizontal: space.md,
              height: 40,
              borderRadius: radius.pill,
              backgroundColor: colors.surfaceRaised,
              opacity: ringing ? 0.4 : pressed ? 0.75 : 1,
            })}
          >
            <UserPlus size={18} color={colors.fg} />
            <Text style={{ color: colors.fg, fontSize: 13, fontWeight: "600" }}>
              {t("mobile:call.addPerson")}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {/* Sesli odayla aynı bildirimler: yalnız kalma geri sayımı (motor yalnız DM
          araması ve grup-DM seslisinde kurar) ve mikrofon/kamera/ekran/yeniden
          bağlanma hatası. Paylaşım tam ekrandayken gizli: o görüntüleyici ekranın
          tamamını sahipleniyor. */}
      {shareFullscreen ? null : <VoiceNotices />}

      {/* One-line affordance note while ringing: the controls below are live. */}
      {ringing && !shareFullscreen ? (
        <Text
          numberOfLines={1}
          style={{
            color: colors.fgFaint,
            fontSize: typography.size["2xs"],
            textAlign: "center",
            paddingHorizontal: space.lg,
            paddingBottom: space.xs,
          }}
        >
          {t("mobile:call.ringingStageHint")}
        </Text>
      ) : null}

      {/* THE stage — the very same shell the server voice room renders, so the
          call gets the in-stage bar, the per-user volume sheet and the self-view
          by construction rather than by remembering to add them twice. A call
          room IS a voice room; this is where that stops being a claim. */}
      <VoiceStage
        stage={stage}
        nameFor={nameFor}
        activeShare={activeShare}
        sharerName={sharerName}
        shareFullscreen={shareFullscreen}
        onShareFullscreenChange={onShareFullscreenChange}
        // Say what the button DOES (ADR 0023 §2): while ringing it withdraws the
        // invite; once the room is live it walks out of it, which is no longer the
        // same thing as hanging up on the other person.
        disconnectLabel={ringing ? t("mobile:call.cancel") : t("mobile:call.leaveRoom")}
        onDisconnect={endCall}
        // A fullscreen share owns the whole screen and carries its own chrome.
        chromeHidden={shareFullscreen}
      />

      {/* Controls (mic / camera / deafen / hang up), padded for the safe area. */}
      {!shareFullscreen ? (
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: colors.stroke,
            backgroundColor: colors.surface,
            paddingBottom: insets.bottom,
          }}
        >
          <VoiceControls
            micEnabled={micEnabled}
            deafened={deafened}
            cameraEnabled={cameraEnabled}
            screenShareEnabled={screenShareEnabled}
            connected={connected}
            canToggleAudio={
              status === "connected" || status === "joining" || status === "reconnecting"
            }
            onToggleMic={toggleMic}
            onToggleDeafen={toggleDeafen}
            onToggleCamera={toggleCamera}
            onToggleScreenShare={toggleScreenShare}
            onLeave={endCall}
          />
        </View>
      ) : null}

      <AddPersonSheet
        visible={addOpen}
        excludeUserId={peer?.id ?? null}
        onClose={() => setAddOpen(false)}
      />
    </View>
  );
}
