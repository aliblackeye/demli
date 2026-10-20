import { useEffect, useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import { router, Stack } from "expo-router";
import {
  Mic,
  MicOff,
  MonitorPlay,
  PhoneOff,
  MessageSquare,
  RotateCcw,
  Tv,
  Volume2,
  WifiOff,
} from "lucide-react-native";
import { unreadBadgeText, voiceChatHeaderActions } from "@demli/client-core";
import { useAppTranslation, type AppTFunction } from "@/lib/i18n";
import type { UserId } from "@demli/types";
import type { VoiceState } from "@demli/media";
import { ChatSummaryHeaderTitle } from "@/components/ChatHeaderTitle";
import { ChatThread } from "@/components/ChatThread";
import { EmptyState } from "@/components/EmptyState";
import { UnreadCountBadge } from "@/components/home/UnreadCountBadge";
import { Screen } from "@/components/Screen";
import { Skeleton } from "@/components/Skeleton";
import { buildMemberColorMap } from "@/lib/permissions";
import { useGroupDetails, useRoles } from "@/queries/chat-queries";
import { useChatStore } from "@/stores/chat-store";
import { useHasWatchParty } from "@/stores/watch-party-store";
import { useRemoteScreenShares, useVoiceStore } from "@/stores/voice-store";
import { startWatchParty } from "@/realtime/connection";
import { useWatchSearchEnabled, useWatchVideoSearch } from "@/queries/watch-queries";
import { WatchPartyStage } from "@/components/watch/WatchPartyStage";
import { WatchVideoPickerSheet } from "@/components/watch/WatchVideoPickerSheet";
import { colors, space } from "@/theme/theme";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Text } from "../ui/Text";
import { AudioOutputControl } from "./AudioOutputControl";
import { LiveDot, TILE_RADIUS, voiceStatusColor } from "./stage-chrome";
import { VoiceNotices } from "./VoiceNotices";
import { useStageTiles } from "./use-stage-tiles";
import { VoiceConnectionBars } from "./VoiceConnectionBars";
import { ControlDock, VoiceControls } from "./VoiceControls";
import { VoiceStage } from "./VoiceStage";
import {
  initialVoiceView,
  shouldAutoJoinOnMount,
  type VoiceScreenIntent,
  type VoiceScreenView,
} from "./voice-channel-nav";
import { VoiceParticipantRow } from "./VoiceParticipant";

/**
 * Stable empty roster for the header title on the STAGE view: the stage has its
 * own live participant list below, so it shows no "N members" summary — and a
 * fresh `[]` per render would defeat the title component's memo.
 */
const NO_MEMBER_SUMMARY: readonly UserId[] = [];

/** Localized status line for the current FSM state. */
function statusLabel(status: VoiceState["status"], t: AppTFunction): string {
  switch (status) {
    case "idle":
      return t("mobile:voice.statusNotConnected");
    case "joining":
      return t("mobile:voice.statusJoining");
    case "connected":
      return t("mobile:voice.statusConnected");
    case "reconnecting":
      return t("mobile:voice.statusReconnecting");
    case "leaving":
      return t("mobile:voice.statusLeaving");
    case "error":
      return t("mobile:voice.statusError");
  }
}

/**
 * The voice room screen — a voice channel is ONE place with TWO views (M20):
 *
 *   STAGE — the room: participant tiles, a watched screen share, and the
 *           mic/deafen/camera/leave controls.
 *   CHAT  — the channel's conversation, which since M20 every voice channel has.
 *           Readable by anyone who can SEE the channel; being in the room is
 *           deliberately not required (ADR 0007).
 *
 * The chat is the SAME {@link ChatThread} a text channel renders — one chat
 * implementation, so pins, search, edit, reactions, attachments, drafts, the
 * offline outbox and the unread divider are not built twice. The only voice
 * specifics are which view is showing and the header's room controls, and WHICH
 * controls those are is decided by the shared `voiceChatHeaderActions` rule that
 * desktop/web use, not by a second copy of the logic here.
 *
 * Session is APP-scoped, not screen-scoped: the voice engine lives at module
 * level in `stores/voice-store` (app lifetime), so this screen only JOINS on
 * mount — and only when it was opened WITH a join intent. It never leaves on
 * unmount. Navigating away (to another screen or backgrounding the app) keeps
 * you connected; only an explicit Leave, switching rooms, or logout ends the
 * session. While away, the global `VoiceMiniBar` (mounted in the authed
 * `_layout`) keeps the session visible and lets you jump back here. (B2:
 * navigation must not drop voice.)
 */
export function VoiceRoomScreen({
  channelId,
  groupId,
  channelName,
  intent = "join",
}: {
  channelId: string;
  groupId?: string;
  channelName?: string;
  /**
   * Why the screen was opened: `"join"` connects on mount and lands on the
   * stage (the row's primary tap, the mini bar, a push deep link, the command
   * palette — and the default for any caller that says nothing). `"chat"` opens
   * the conversation and connects to NOTHING (the row's read control, and the
   * row's own tap when we are already in this very room).
   */
  intent?: VoiceScreenIntent;
}) {
  const { t } = useAppTranslation();

  const status = useVoiceStore((s) => s.status);
  const roomId = useVoiceStore((s) => s.roomId);
  const micEnabled = useVoiceStore((s) => s.micEnabled);
  const deafened = useVoiceStore((s) => s.deafened);
  const cameraEnabled = useVoiceStore((s) => s.cameraEnabled);
  const screenShareEnabled = useVoiceStore((s) => s.screenShareEnabled);
  const participants = useVoiceStore((s) => s.participants);
  const join = useVoiceStore((s) => s.join);
  const leave = useVoiceStore((s) => s.leave);
  const toggleMic = useVoiceStore((s) => s.toggleMic);
  const toggleDeafen = useVoiceStore((s) => s.toggleDeafen);
  const toggleCamera = useVoiceStore((s) => s.toggleCamera);
  const toggleScreenShare = useVoiceStore((s) => s.toggleScreenShare);

  // Which of the two views is showing. Seeded from the intent; the header's
  // controls flip it afterwards. Re-seeded when the intent itself changes, so
  // re-entering the route as a read (expo-router may reuse the mounted screen
  // for the same pathname) still lands on the chat.
  const [view, setView] = useState<VoiceScreenView>(() => initialVoiceView(intent));
  useEffect(() => {
    setView(initialVoiceView(intent));
  }, [intent]);

  const shares = useRemoteScreenShares();
  // One host per film night (matches the desktop focus view: shares[0]).
  const activeShare = shares[0] ?? null;

  // Whether the shared screen is being WATCHED fullscreen. Owned here (not in the
  // deep ScreenShareView) because the SCREEN's orientation lock keys off it:
  // portrait everywhere, LANDSCAPE only while a share is fullscreen (founder #70).
  const [shareFullscreen, setShareFullscreen] = useState(false);
  // The share can vanish while fullscreen (host stops / we leave). Drop fullscreen
  // so the landscape lock releases and the phone doesn't stay stuck sideways (#70).
  useEffect(() => {
    if (!activeShare && shareFullscreen) setShareFullscreen(false);
  }, [activeShare, shareFullscreen]);

  // ── watch party (M20, ADR 0016) ──────────────────────────────────────────
  // A BOOLEAN, deliberately: the 5 s sync heartbeat must not re-render the whole
  // voice screen (§27). The session object is read only inside WatchPartyStage.
  const watchActive = useHasWatchParty(channelId);
  const [watchStartOpen, setWatchStartOpen] = useState(false);
  // Expanded = the film gets the whole glass, which means LANDSCAPE — the same
  // deal the fullscreen screen share gets (founder #70), and for the same reason:
  // a 16:9 frame on a portrait phone is a third of the screen.
  const [watchExpanded, setWatchExpanded] = useState(false);
  // The party can end while expanded (the host stopped it, the room emptied).
  // Drop the expansion so the landscape lock releases and the phone does not stay
  // stuck sideways over an empty stage — the exact bug the share path already had.
  useEffect(() => {
    if (!watchActive && watchExpanded) setWatchExpanded(false);
  }, [watchActive, watchExpanded]);

  const watchSearchEnabled = useWatchSearchEnabled(watchStartOpen);
  const {
    state: watchSearchState,
    run: runWatchSearch,
    reset: resetWatchSearch,
  } = useWatchVideoSearch(channelId);


  // Resolve participant display names from the group roster (authoritative),
  // falling back to the realtime user directory, then a short id.
  const { data: group } = useGroupDetails(groupId ?? null);
  const { data: roles } = useRoles(groupId ?? null);
  const users = useChatStore((s) => s.users);
  const nameFor = useMemo(() => {
    const byId = new Map<string, string>();
    for (const m of group?.members ?? []) {
      byId.set(m.userId, m.user.displayName || m.user.username);
    }
    return (userId: UserId): string => {
      const fromGroup = byId.get(userId);
      if (fromGroup) return fromGroup;
      const u = users[userId];
      if (u) return u.displayName || u.username;
      return userId.slice(0, 6);
    };
  }, [group?.members, users]);

  /**
   * The same resolution ladder as `nameFor`, for the photo: group roster first
   * (authoritative), then the realtime user directory, then null (no avatar).
   * Deliberately parallel to `nameFor` so a participant that can show a name can
   * always show their picture — the two must never disagree about who someone is.
   */
  const avatarFor = useMemo(() => {
    const byId = new Map<string, string | null>();
    for (const m of group?.members ?? []) {
      byId.set(m.userId, m.user.avatarUrl ?? null);
    }
    return (userId: UserId): string | null => {
      const fromGroup = byId.get(userId);
      if (fromGroup !== undefined) return fromGroup;
      return users[userId]?.avatarUrl ?? null;
    };
  }, [group?.members, users]);

  // The channel's own record, for the chat's slow-mode indicator. Read from the
  // already-cached group details — no extra request, same as the text-channel
  // route does.
  const channel = group?.channels.find((c) => c.id === channelId) ?? null;
  const slowmodeSeconds = channel?.slowmodeSeconds ?? 0;

  // Author role colors + the header's member summary, both for the CHAT view.
  // Recompute only when members/roles change — never on presence ticks (§27).
  const authorColors = useMemo(
    () => buildMemberColorMap(group?.members, roles),
    [group?.members, roles],
  );
  const memberIds = useMemo<UserId[]>(
    () => (group?.members ?? []).map((m) => m.user.id),
    [group?.members],
  );

  // Unread signal for the stage's "open chat" button. Boolean + count selectors
  // (never the whole map) so an unrelated channel's traffic does not repaint the
  // room (§27).
  const chatUnread = useChatStore((s) => Boolean(s.unreadChannelIds[channelId]));
  const chatUnreadCount = useChatStore((s) => s.unreadCounts[channelId] ?? 0);

  // Join on mount — but ONLY when this screen was opened to join. Opened as a
  // read (the row's chat control), it must connect to nothing; that promise is
  // the whole point of the read path, so it is enforced here rather than relying
  // on the engine's "already in this room" no-op.
  //
  // We deliberately DO NOT leave on unmount — the session is app-scoped (see the
  // component doc). `join` is a no-op when already in this room, so returning to
  // this screen from the mini bar never re-joins. (B2 root-cause fix: the old
  // `return () => leave()` cleanup is what dropped voice on navigation.)
  useEffect(() => {
    if (!shouldAutoJoinOnMount(intent)) return;
    join(channelId, { groupId, name: channelName });
  }, [channelId, groupId, channelName, join, intent]);

  // The unified participant stage — EVERY participant is an equal tile, camera on
  // or off (§7, the unified grid). Built by the SHARED builder the DM call also
  // uses, which in turn consumes `buildTiles` from `@demli/media`: this used to
  // be an 18-line memo duplicated verbatim in `InCallView`, and that copy is
  // precisely how the room and the call drifted apart on the phone.
  const stage = useStageTiles({ nameFor, avatarFor });

  const connected = status === "connected";
  // Mic + deafen stay usable while a room exists (joining/connected/reconnecting),
  // not only when fully connected — you most need to mute during a flaky
  // reconnect (audit D2). Camera stays gated on `connected` (live track).
  const roomActive = status === "connected" || status === "joining" || status === "reconnecting";
  const sharerName = activeShare ? nameFor(activeShare.userId) : null;

  const title = channelName ?? t("mobile:voice.title");
  const showChat = view === "chat";

  // Which room controls the CHAT view's header offers. The shared rule
  // (@demli/client-core) decides, exactly as it does for the desktop chat
  // header — join when we are not in this room, otherwise leave, plus a way back
  // to the stage when we are not looking at it. `hasStageVideo` is true for the
  // whole session here because the mobile stage is a real place with or without
  // video: it carries the participant grid AND the mic/deafen/camera controls, so
  // there is always something to return to (on desktop the center falls back to
  // the chat when no video exists, hence the flag).
  const inThisRoom = roomId === channelId && status !== "idle";
  const headerActions = voiceChatHeaderActions(channelId, {
    voiceRoomId: roomId,
    voiceStatus: status,
    hasStageVideo: inThisRoom,
    stageFocused: view === "stage",
  });

  // Leaving from the stage's button drops the room and returns to the channel
  // list. Leaving from the CHAT header only drops the room — you stay where you
  // are reading, which is the point of a chat that does not require the room.
  const handleLeave = () => {
    leave();
    if (router.canGoBack()) router.back();
  };

  const runHeaderAction = (action: (typeof headerActions)[number]) => {
    if (action === "join") {
      join(channelId, { groupId, name: channelName });
      setView("stage");
      return;
    }
    if (action === "return-to-stage") {
      setView("stage");
      return;
    }
    leave();
  };

  const unreadBadge = chatUnread ? unreadBadgeText(chatUnreadCount, true) : null;

  return (
    <Screen>
      {/* Orientation (founder #70): the voice screen stays PORTRAIT — the grid no
          longer flips sideways just because you rotate the phone (the "app stuck in
          landscape" bug). Landscape is granted ONLY while a shared screen is watched
          fullscreen, so a wide desktop film fills the phone's long axis; closing
          fullscreen (or the share ending) flips `shareFullscreen` back to false and
          the phone returns to portrait — never stuck. react-native-screens applies
          this at the Android activity level and re-applies it when the prop changes,
          so no native module is needed (OTA-safe). */}
      <Stack.Screen
        options={{
          title,
          // Speaker GLYPH + display-font name (desktop header pattern) — not an
          // emoji baked into the title string, which rendered in the system
          // emoji font and read off-brand. The chat view shows the roster
          // summary under it, exactly like a text channel's header.
          headerTitle: () => (
            <ChatSummaryHeaderTitle
              title={title}
              memberIds={showChat ? memberIds : NO_MEMBER_SUMMARY}
              glyph="voice"
            />
          ),
          headerRight: () =>
            showChat ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
                {/* Mic stays one tap away while reading. The mobile shell hides
                    the global VoiceMiniBar on this route (its own controls cover
                    it), so without this the chat view would have no mute. */}
                {inThisRoom ? (
                  <IconButton
                    icon={micEnabled ? Mic : MicOff}
                    // Muted while reading = the pink wash, the dock's grammar.
                    variant={micEnabled ? "ghost" : "danger"}
                    haptic="light"
                    label={
                      micEnabled
                        ? t("mobile:voice.a11yMuteMic")
                        : t("mobile:voice.a11yUnmuteMic")
                    }
                    onPress={toggleMic}
                  />
                ) : null}
                {headerActions.map((action) =>
                  action === "join" ? (
                    // The chat view's primary act when you are not in the room:
                    // the warm call to action.
                    <IconButton
                      key={action}
                      icon={Volume2}
                      variant="accent"
                      haptic="light"
                      label={t("mobile:voice.a11yJoinChannel", { name: title })}
                      onPress={() => runHeaderAction(action)}
                    />
                  ) : action === "return-to-stage" ? (
                    <IconButton
                      key={action}
                      icon={MonitorPlay}
                      label={t("mobile:voice.returnToStage")}
                      onPress={() => runHeaderAction(action)}
                    />
                  ) : (
                    <IconButton
                      key={action}
                      icon={PhoneOff}
                      variant="dangerSolid"
                      haptic="medium"
                      label={t("mobile:voice.a11yLeaveChannel")}
                      onPress={() => runHeaderAction(action)}
                    />
                  ),
                )}
              </View>
            ) : (
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
                {/* Start a Watch Party. Offered only while we are actually in
                    THIS room (the gateway refuses `NOT_IN_VOICE` otherwise) and
                    only when none is running — once a party exists, changing its
                    video and ending it live in the stage's own band, so this
                    button would be a second door to a room that already has one. */}
                {inThisRoom && !watchActive ? (
                  <IconButton
                    icon={Tv}
                    label={t("mobile:watchParty.start")}
                    onPress={() => setWatchStartOpen(true)}
                  />
                ) : null}
                <IconButton
                  icon={MessageSquare}
                  label={t("mobile:voice.openChat")}
                  onPress={() => setView("chat")}
                  badge={
                    unreadBadge ? (
                      <UnreadCountBadge
                        text={unreadBadge}
                        a11yLabel={t("mobile:group.unreadA11y")}
                      />
                    ) : undefined
                  }
                />
              </View>
            ),
          // The expanded watch stage takes the header too — a title bar over a
          // landscape film is exactly the chrome the expansion exists to remove.
          headerShown: !watchExpanded,
          orientation: shareFullscreen || watchExpanded ? "landscape" : "portrait",
        }}
      />

      {showChat ? (
        // The SAME thread a text channel renders. `channelKind` is the one thing
        // it needs to know — the store's active-channel gate asks whether the
        // channel is chat-capable, and reporting "text" here would leave the
        // messages arriving in front of the user flagged unread.
        <ChatThread
          channelId={channelId}
          groupId={groupId ?? ""}
          name={channelName ?? ""}
          channelKind="voice"
          slowmodeSeconds={slowmodeSeconds}
          authorColors={authorColors}
          serverGroupId={groupId}
        />
      ) : (
        <>
          {/* Status strip. Hidden while the watch stage is expanded — that state
              is a request for the whole screen, and a connection dot is not worth
              a band across a landscape film. */}
          <View
            style={{
              display: watchExpanded ? "none" : "flex",
              flexDirection: "row",
              alignItems: "center",
              gap: space.sm,
              minHeight: 44,
              paddingHorizontal: space.lg,
              paddingTop: space.sm,
            }}
          >
            {/* The room's state in one line: a dot that breathes while the
                connection is still moving, the state in its own tone, then the
                head count in the meta tone. */}
            <LiveDot
              color={voiceStatusColor(status)}
              pulsing={status === "joining" || status === "reconnecting"}
            />
            <Text numberOfLines={1} style={{ flex: 1 }}>
              <Text
                style={{
                  color:
                    status === "connected"
                      ? colors.success
                      : status === "error"
                        ? colors.danger
                        : status === "joining" || status === "reconnecting"
                          ? colors.warning
                          : colors.fgMuted,
                  fontSize: 13,
                  fontWeight: "600",
                }}
              >
                {statusLabel(status, t)}
              </Text>
              <Text style={{ color: colors.fgFaint, fontSize: 13, fontWeight: "500" }}>
                {`  ·  ${t("mobile:voice.inRoom", { n: participants.length })}`}
              </Text>
            </Text>
            {/* Audio output route picker — self-hides unless the session is live. */}
            <AudioOutputControl />
            {/* Ping / connection-quality bars — self-hides unless connected. */}
            <VoiceConnectionBars />
          </View>

          {/* Özel aramayla aynı bildirim bileşeni: yalnız kalma geri sayımı (sunucu
              sesli kanalında motor hiç kurmaz) + §26 ses hatası. */}
          <VoiceNotices />

          {/* Main area: screen-share focus view (with a collapsible participant strip)
              when the host is sharing; else the unified participant grid (grid ⇄ focus)
              whenever anyone is in the room — every participant is an equal tile,
              camera on or off (§7). Falls back to the status/roster view only before
              the roster populates. Camera + screen share can be on together (task #18). */}
          {/* THE stage — the very same shell the DM call renders (VoiceStage), so
              the room and the call cannot drift apart again. The watch party and
              the waiting/roster view are passed as SLOTS because they are the two
              things genuinely specific to a server voice channel. */}
          <VoiceStage
            stage={stage}
            nameFor={nameFor}
            activeShare={activeShare}
            sharerName={sharerName}
            shareFullscreen={shareFullscreen}
            onShareFullscreenChange={setShareFullscreen}
            disconnectLabel={t("mobile:voice.controlLeave")}
            onDisconnect={handleLeave}
            // A fullscreen share / expanded party owns the whole screen.
            chromeHidden={shareFullscreen || watchExpanded}
            watchSlot={
              watchActive ? (
                // The watch party OWNS the stage while it runs, ahead of a screen
                // share — it is the thing the room deliberately started, and it is
                // the only one of the two that has a host, a queue and a playhead
                // everybody is synchronized to. A share running underneath stays
                // published and audible; it simply is not what the stage shows.
                <WatchPartyStage
                  channelId={channelId}
                  groupId={groupId ?? null}
                  participantTiles={stage.tiles}
                  nameFor={nameFor}
                  avatarFor={avatarFor}
                  expanded={watchExpanded}
                  onExpandedChange={setWatchExpanded}
                />
              ) : null
            }
            emptySlot={
              <ScrollView
                contentInsetAdjustmentBehavior="automatic"
                style={{ flex: 1 }}
                contentContainerStyle={{ padding: space.lg, gap: space.xs, flexGrow: 1 }}
              >
                {status === "error" && participants.length === 0 ? (
                  // The join itself failed — the banner above says why; this is
                  // the one thing you can do about it, in the place you look.
                  <View style={{ flex: 1, justifyContent: "center" }}>
                    <EmptyState
                      tone="error"
                      icon={<WifiOff size={22} color={colors.danger} strokeWidth={2} />}
                      title={t("mobile:voice.joinFailedTitle")}
                      subtitle={t("mobile:voice.joinFailedSubtitle")}
                      action={
                        <Button
                          variant="secondary"
                          icon={RotateCcw}
                          label={t("mobile:voice.rejoin")}
                          onPress={() => join(channelId, { groupId, name: channelName })}
                        />
                      }
                    />
                  </View>
                ) : (status === "joining" || status === "reconnecting") &&
                  participants.length === 0 ? (
                  // Taking shape, not a spinner: the two tiles the room is about
                  // to fill, announced once as "joining".
                  <View
                    accessible
                    accessibilityRole="progressbar"
                    accessibilityState={{ busy: true }}
                    accessibilityLabel={t("mobile:voice.statusJoining")}
                    style={{ flex: 1, gap: space.sm }}
                  >
                    <Skeleton width="100%" height="auto" radius={TILE_RADIUS} style={{ flex: 1 }} />
                    <Skeleton width="100%" height="auto" radius={TILE_RADIUS} style={{ flex: 1 }} />
                  </View>
                ) : connected ? (
                  <EmptyState
                    compact
                    icon={<MonitorPlay size={22} color={colors.fgMuted} strokeWidth={2} />}
                    title={t("mobile:voice.waitingTitle")}
                    subtitle={t("mobile:voice.waitingSubtitle")}
                  />
                ) : null}
                {participants.map((p) => (
                  <VoiceParticipantRow
                    key={p.identity}
                    participant={p}
                    name={nameFor(p.userId)}
                    avatarUrl={avatarFor(p.userId)}
                  />
                ))}
              </ScrollView>
            }
          />

          {/* Controls (mute / deafen / leave), padded for the bottom safe area.
              Hidden while the watch stage is expanded, exactly as the fullscreen
              screen share hides them (it covers the screen with a modal): the
              expanded state is landscape, where a 90pt control bar is a quarter
              of the height. Collapsing is one tap on the player's corner button,
              which stays visible over the film for precisely this reason. */}
          <ControlDock hidden={watchExpanded}>
            <VoiceControls
              micEnabled={micEnabled}
              deafened={deafened}
              cameraEnabled={cameraEnabled}
              screenShareEnabled={screenShareEnabled}
              connected={connected}
              canToggleAudio={roomActive}
              onToggleMic={toggleMic}
              onToggleDeafen={toggleDeafen}
              onToggleCamera={toggleCamera}
              onToggleScreenShare={toggleScreenShare}
              onLeave={handleLeave}
            />
          </ControlDock>
        </>
      )}

      {/* NB: the per-user "User Volume" sheet host now lives in {@link VoiceStage},
          which both this screen and the DM call render. It used to be mounted here
          and ONLY here, which is what made the identical long-press dead inside a
          call. Mounting it twice would give the controller two listeners, so this
          screen deliberately does not. */}

      {/* Pick the FIRST video — by search or by link. The "change the video" and
          "add to queue" twins live in the stage's own band and sheet, so the
          verbs are never offered from the same place at the same time.

          Search matters most right here: this is the moment a party is created,
          and requiring a link from a real browser to get past it would leave the
          "pick it from inside the app" request half-answered on the surface where
          hunting for a link is hardest. */}
      <WatchVideoPickerSheet
        visible={watchStartOpen}
        onClose={() => setWatchStartOpen(false)}
        mode="start"
        searchEnabled={watchSearchEnabled}
        search={watchSearchState}
        onSearch={runWatchSearch}
        onResetSearch={resetWatchSearch}
        onSubmit={(input) => startWatchParty(channelId, input.videoRef)}
      />
    </Screen>
  );
}
