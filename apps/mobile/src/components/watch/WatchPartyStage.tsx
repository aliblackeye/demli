/**
 * Watch-party stage for the mobile voice room (M20 mobile parity) — the player
 * plus the thin band of state around it: who is driving, what this user may do
 * about it, and any refusal the gateway sent back.
 *
 * The RN twin of `apps/desktop/src/renderer/src/components/WatchPartyStage.tsx`.
 *
 * ## The host / viewer split is the whole design
 *
 * A viewer sees NO transport controls. Not greyed-out ones with a hint: §35
 * forbids a control that looks pressable and does nothing, and the gateway would
 * refuse the frame anyway (`NOT_HOST`). What a viewer gets instead is the one fact
 * they actually need — who IS driving — plus everything that is genuinely theirs:
 * the queue (read-only), the film volume, and the expand control.
 *
 * The server owner override (ADR 0016 §Authority step 4) is honoured here too: an
 * owner sees host controls in their own server even when someone else holds the
 * host role, so a room is never held hostage by a host who wandered off. That is
 * COSMETIC gating like every other client-side permission check — the gateway
 * re-decides, and this component simply agrees with it.
 *
 * ## Expanding is this surface's answer to a 16:9 video on a portrait phone
 *
 * Desktop puts the queue in a column beside the player because it has the width.
 * A phone has ~390pt: a 16:9 video is 220pt tall and the queue has to be a sheet.
 * The same arithmetic is why `expanded` exists — it asks the parent to unlock
 * LANDSCAPE (exactly as the screen-share stage does for a shared desktop, founder
 * #70) and drops the band, so the film fills the phone's long axis. The parent
 * owns the orientation lock because `Stack.Screen` does; this component owns the
 * intent.
 *
 * ## Renders
 *
 * The 5 s heartbeat writes to the watch store every tick for an active room, and
 * this subtree is the only one that subscribes to the session object (§27) —
 * everything else in the voice screen reads the boolean `useHasWatchParty`.
 * Inside the player itself the per-second readings live in refs and re-render
 * nothing, which is what keeps a WebView and a LiveKit room on the same phone
 * from fighting over the frame budget.
 *
 * ## Look (Koyu Masa)
 *
 * The band is a borderless surface strip: the coral TV glyph, the driver's face,
 * one line of who is in control, then ghost icon discs — the stop control in the
 * pink danger wash. A gateway refusal is the kit's danger Banner with its own
 * dismiss. Over the film, the expand and expanded-mute controls are veil discs
 * (muted = the pink wash, the dock's grammar).
 */

import { useCallback, useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import type { ViewStyle } from "react-native";
import {
  Eye,
  EyeOff,
  ListVideo,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  Repeat2,
  Square,
  Tv,
  UserRoundCog,
} from "lucide-react-native";
import { watchControlMode, type HostControlIntent } from "@demli/client-core";
import type { ChannelId, GroupId, UserId } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { Avatar } from "@/components/Avatar";
import { ActionRow, ActionSheet } from "@/components/ui/ActionSheet";
import { useServerPermissions } from "@/queries/chat-queries";
import { useWatchSearchEnabled, useWatchVideoSearch } from "@/queries/watch-queries";
import {
  addToWatchQueue,
  controlWatchParty,
  playWatchQueueItem,
  removeFromWatchQueue,
  reorderWatchQueue,
  reportWatchEnded,
  setWatchPartyVideo,
  stopWatchParty,
  transferWatchPartyHost,
} from "@/realtime/connection";
import { useAuthStore } from "@/stores/auth-store";
import { NO_OCCUPANTS, useVoiceOccupancyStore } from "@/stores/voice-occupancy-store";
import { useVoiceStore } from "@/stores/voice-store";
import {
  useWatchPartyStore,
  useWatchQueue,
  useWatchRefusal,
  useWatchSession,
  useWatchVideoTitle,
} from "@/stores/watch-party-store";
import { colors, radius, space } from "@/theme/theme";
import { Banner } from "../ui/Banner";
import { Chip } from "../ui/Chip";
import { IconButton } from "../ui/IconButton";
import { Text } from "../ui/Text";
import { ParticipantTile, type ParticipantTileData } from "../voice/ParticipantTile";
import { WatchPartyPlayer } from "./WatchPartyPlayer";
import {
  DEFAULT_WATCH_VOLUME,
  WatchQueueSheet,
  type WatchQueueEntry,
} from "./WatchQueueSheet";
import { WatchVideoPickerSheet, type WatchPickerMode } from "./WatchVideoPickerSheet";

export interface WatchPartyStageProps {
  /** The voice channel the party is bound to. */
  channelId: ChannelId;
  /** The server that channel belongs to — for the owner override. */
  groupId: GroupId | null;
  /**
   * Everyone in the room, for the filmstrip under the film.
   *
   * Watching together is still being together: the reason this strip exists is
   * that a film with no faces beside it is just a video, and the speaking ring on
   * a tile is how you know who just said something about it. Same tiles, same
   * collapse affordance as the screen-share stage — a 16:9 video on a portrait
   * phone wants the height back, so hiding them is one tap.
   */
  participantTiles: ParticipantTileData[];
  /**
   * Identity resolvers owned by the voice screen.
   *
   * Passed in rather than re-derived here because that screen already holds the
   * authoritative ladder — group roster first, then the realtime user directory,
   * then a short id — and a second, weaker lookup in this component would name
   * the host "Bilinmeyen üye" on exactly the members the roster knows and the
   * directory has not seen yet. One resolver, so the person driving the film is
   * called the same thing here, on their tile, and in the chat.
   */
  nameFor: (userId: UserId) => string;
  avatarFor: (userId: UserId) => string | null;
  /**
   * True while the stage is asking for the whole screen. Owned by the voice
   * screen because the LANDSCAPE lock lives on its `Stack.Screen`, exactly as it
   * does for a fullscreen screen share.
   */
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}

export function WatchPartyStage({
  channelId,
  groupId,
  participantTiles,
  nameFor,
  avatarFor,
  expanded,
  onExpandedChange,
}: WatchPartyStageProps) {
  const { t } = useAppTranslation();
  const session = useWatchSession(channelId);
  const queue = useWatchQueue(channelId);
  const nowPlayingTitle = useWatchVideoTitle(channelId, session?.videoId ?? null);
  const refusal = useWatchRefusal(channelId);
  const clearRefusal = useWatchPartyStore((s) => s.clearRefusal);
  const myId = useAuthStore((s) => s.user?.id ?? null);
  const { isOwner } = useServerPermissions(groupId ?? null);
  const occupants = useVoiceOccupancyStore((s) => s.byChannel[channelId] ?? NO_OCCUPANTS);
  /**
   * Mic state, for the expanded state's floating toggle.
   *
   * A boolean and a stable action — never the whole voice state — so a speaking
   * tick or a participant joining does not re-render the stage and, through it,
   * the player (§27).
   */
  const micEnabled = useVoiceStore((s) => s.micEnabled);
  const toggleMic = useVoiceStore((s) => s.toggleMic);

  /** Which sheet the picker is currently serving, or null when it is closed. */
  const [picker, setPicker] = useState<Exclude<WatchPickerMode, "start"> | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [stripCollapsed, setStripCollapsed] = useState(false);
  /** Stable strip tile size so a speaking tick does not churn the memoized tiles (§27). */
  const stripStyle = useMemo<ViewStyle>(() => ({ width: 112, aspectRatio: 4 / 3 }), []);
  /**
   * Film volume, 0–100. Local to this device and never broadcast: how loud the
   * movie should be relative to your friends' voices is a fact about YOUR room,
   * not about the party. Applied to the embed only — see WatchPartyPlayer's
   * header for why the audio session is untouchable while a call is up.
   */
  const [volumePercent, setVolumePercent] = useState<number>(DEFAULT_WATCH_VOLUME);

  const searchEnabled = useWatchSearchEnabled(picker !== null);
  const { state: searchState, run: runSearch, reset: resetSearch } = useWatchVideoSearch(channelId);

  const mode = watchControlMode({ session, userId: myId, isOwner });
  const isHost = mode === "host";

  /**
   * Stable, so the memoized player is not re-rendered by a presence tick in this
   * component (§27). Declared before the early return because hook order cannot
   * depend on whether a party is running.
   */
  const onHostControl = useCallback(
    (intent: HostControlIntent) => {
      controlWatchParty(channelId, intent.action, intent.positionSec);
    },
    [channelId],
  );

  /**
   * The host's player reached the end of the video — advance the room. Stable for
   * the same reason as `onHostControl`, and host-gated inside the player rather
   * than here so this component does not re-create the callback when the owner
   * override flips.
   */
  const onEnded = useCallback(
    (videoId: string) => {
      reportWatchEnded(channelId, videoId);
    },
    [channelId],
  );

  const onQueuePlayNow = useCallback(
    (itemId: string) => playWatchQueueItem(channelId, itemId),
    [channelId],
  );
  const onQueueRemove = useCallback(
    (itemId: string) => removeFromWatchQueue(channelId, itemId),
    [channelId],
  );
  const onQueueReorder = useCallback(
    (itemIds: string[]) => reorderWatchQueue(channelId, itemIds),
    [channelId],
  );
  const onQueueAdd = useCallback(() => {
    // One sheet at a time: the picker replaces the queue rather than stacking on
    // it, so dismissing lands back somewhere predictable.
    setQueueOpen(false);
    setPicker("queue");
  }, []);

  /**
   * Queue rows joined to display names.
   *
   * Memoized on the queue and the roster, so the 5 s heartbeat — which rewrites
   * `sessions`, not `queues` — produces a stable array and the memoized sheet
   * re-renders on a real queue change and on nothing else (§27).
   */
  const queueEntries = useMemo<WatchQueueEntry[]>(
    () =>
      queue.map((item) => ({
        itemId: item.itemId,
        videoId: item.videoId,
        title: item.title,
        durationSeconds: item.durationSeconds,
        addedByName: nameFor(item.addedBy),
      })),
    [queue, nameFor],
  );

  /**
   * Transfer targets: the room's OTHER occupants. The gateway rejects a transfer
   * to somebody who is not in the voice channel (`INVALID_PAYLOAD`), so offering
   * anyone else here would be offering a button that fails — the list is built
   * from the same server-truth occupancy the gateway checks against.
   */
  const transferTargets = useMemo(() => {
    if (!session) return [];
    return occupants
      .filter((occupant) => occupant.userId !== session.hostId)
      .map((occupant) => ({
        userId: occupant.userId as UserId,
        name: nameFor(occupant.userId as UserId),
        avatarUrl: avatarFor(occupant.userId as UserId),
      }));
  }, [occupants, session, nameFor, avatarFor]);

  if (!session) return null;

  const hostName = nameFor(session.hostId);
  const hostAvatarUrl = avatarFor(session.hostId);

  const refusalMessage =
    refusal === null
      ? null
      : refusal === "NOT_IN_VOICE"
        ? t("mobile:watchParty.refusalNotInVoice")
        : refusal === "NOT_HOST"
          ? t("mobile:watchParty.refusalNotHost")
          : refusal === "WATCH_QUEUE_FULL"
            ? t("mobile:watchParty.refusalQueueFull")
            : t("mobile:watchParty.refusalNotActive");

  return (
    <View style={{ flex: 1, minHeight: 0, gap: space.sm }}>
      {/* Status band. Dropped entirely while expanded — the point of expanding is
          that the film gets the glass, and the band's one fact (who is driving)
          is not worth 44pt of a landscape phone. */}
      {expanded ? null : (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: space.sm,
            marginHorizontal: space.md,
            paddingLeft: space.md,
            paddingRight: space.xs,
            paddingVertical: space.xs,
            borderRadius: radius.xl,
            borderCurve: "continuous",
            backgroundColor: colors.surface,
          }}
        >
          <Tv size={16} color={colors.accent} strokeWidth={2} />
          <Avatar name={hostName} uri={hostAvatarUrl} size={20} />
          <Text numberOfLines={1} style={{ flex: 1, color: colors.fgMuted, fontSize: 12, fontWeight: "500" }}>
            {isHost
              ? t("mobile:watchParty.youAreHost")
              : t("mobile:watchParty.hostedBy", {
                  name: hostName,
                })}
          </Text>

          {/* The queue control is for EVERYONE — seeing what is next is not a host
              privilege, it is the question the sheet exists to answer. Only the
              controls INSIDE it are gated. */}
          <IconButton
            icon={ListVideo}
            shape="square"
            haptic="light"
            label={t("mobile:watchParty.queueToggle")}
            onPress={() => setQueueOpen(true)}
          />

          {/* Host-only actions. A viewer gets no disabled twins of these — the
              absence IS the message, and the line above already names the host. */}
          {isHost ? (
            <>
              <IconButton
                icon={Repeat2}
                shape="square"
                haptic="light"
                label={t("mobile:watchParty.changeVideo")}
                onPress={() => setPicker("change")}
              />
              {/* Transfer is offered only when there is somebody to transfer TO —
                  an empty list is a control that does nothing (§35). */}
              {transferTargets.length > 0 ? (
                <IconButton
                  icon={UserRoundCog}
                  shape="square"
                  haptic="light"
                  label={t("mobile:watchParty.transferHost")}
                  onPress={() => setTransferOpen(true)}
                />
              ) : null}
              <IconButton
                icon={Square}
                shape="square"
                variant="danger"
                haptic="medium"
                label={t("mobile:watchParty.stop")}
                onPress={() => stopWatchParty(channelId)}
              />
            </>
          ) : null}
        </View>
      )}

      {refusalMessage !== null ? (
        <Banner
          variant="danger"
          title={refusalMessage}
          onDismiss={clearRefusal}
          style={{ marginHorizontal: space.md }}
        />
      ) : null}

      {/* The player. `expanded` changes its padding and nothing structural —
          moving it in the tree would remount the WebView, which destroys the
          embed handshake and restarts playback from zero. */}
      <View
        style={{
          flex: 1,
          minHeight: 0,
          marginHorizontal: expanded ? 0 : space.md,
          marginBottom: expanded ? 0 : space.sm,
        }}
      >
        <WatchPartyPlayer
          session={session}
          isHost={isHost}
          onHostControl={onHostControl}
          onEnded={onEnded}
          volumePercent={volumePercent}
        />

        {/* Floating controls over the film. They live here rather than in the
            band because in the EXPANDED state the band, the header and the
            control bar are all gone — this corner is the only chrome left. */}
        <View
          style={{
            position: "absolute",
            right: space.sm,
            top: space.sm,
            flexDirection: "row",
            gap: space.xs,
          }}
        >
          {/* Mute, but only while expanded — otherwise the room's real control
              bar is right there and a second mic button would be two sources of
              truth for the same state. Expanded is landscape with no control
              bar at all, and "somebody said something about the film" is the
              single most likely thing to happen while watching: needing to
              collapse the video first would fail the founder's standing bar that
              the voice experience is the best part of every surface. */}
          {expanded ? (
            <IconButton
              icon={micEnabled ? Mic : MicOff}
              variant={micEnabled ? "veil" : "danger"}
              shape="square"
              haptic="light"
              label={
                micEnabled ? t("mobile:voice.a11yMuteMic") : t("mobile:voice.a11yUnmuteMic")
              }
              onPress={toggleMic}
            />
          ) : null}

          <IconButton
            icon={expanded ? Minimize2 : Maximize2}
            variant="veil"
            shape="square"
            haptic="light"
            label={expanded ? t("mobile:watchParty.collapse") : t("mobile:watchParty.expand")}
            onPress={() => onExpandedChange(!expanded)}
          />
        </View>
      </View>

      {/* Who you are watching WITH. Dropped while expanded — that state exists
          precisely to give the film the whole glass. */}
      {!expanded && participantTiles.length > 0 ? (
        <View style={{ gap: space.xs, paddingBottom: space.xs }}>
          <Chip
            onPress={() => setStripCollapsed((collapsed) => !collapsed)}
            leading={
              stripCollapsed ? (
                <Eye size={15} color={colors.fgMuted} strokeWidth={2} />
              ) : (
                <EyeOff size={15} color={colors.fgMuted} strokeWidth={2} />
              )
            }
            label={
              stripCollapsed
                ? t("mobile:voice.showCamerasCount", { n: participantTiles.length })
                : t("mobile:voice.hideCameras")
            }
            style={{ alignSelf: "center" }}
          />

          {!stripCollapsed ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{
                gap: space.md,
                paddingHorizontal: space.md,
                alignItems: "center",
              }}
            >
              {participantTiles.map((tile) => (
                <ParticipantTile
                  key={tile.identity}
                  identity={tile.identity}
                  userId={tile.userId}
                  track={tile.track}
                  name={tile.name}
                  avatarUrl={tile.avatarUrl}
                  isLocal={tile.isLocal}
                  muted={tile.muted}
                  speaking={tile.speaking}
                  style={stripStyle}
                />
              ))}
            </ScrollView>
          ) : null}
        </View>
      ) : null}

      <WatchQueueSheet
        visible={queueOpen}
        onClose={() => setQueueOpen(false)}
        items={queueEntries}
        nowPlaying={{ videoId: session.videoId, title: nowPlayingTitle }}
        canControl={isHost}
        onPlayNow={onQueuePlayNow}
        onRemove={onQueueRemove}
        onReorder={onQueueReorder}
        onAdd={onQueueAdd}
        volumePercent={volumePercent}
        onVolumeChange={setVolumePercent}
      />

      <WatchVideoPickerSheet
        visible={picker !== null}
        onClose={() => setPicker(null)}
        mode={picker ?? "queue"}
        searchEnabled={searchEnabled}
        search={searchState}
        onSearch={runSearch}
        onResetSearch={resetSearch}
        onSubmit={(input) => {
          if (picker === "change") {
            setWatchPartyVideo(channelId, input.videoRef);
            return;
          }
          addToWatchQueue(channelId, input);
        }}
      />

      <ActionSheet
        visible={transferOpen}
        onClose={() => setTransferOpen(false)}
        title={t("mobile:watchParty.transferHost")}
      >
        {transferTargets.map((target) => (
          <ActionRow
            key={target.userId}
            icon={<Avatar name={target.name} uri={target.avatarUrl} size={24} />}
            label={target.name}
            onPress={() => {
              setTransferOpen(false);
              transferWatchPartyHost(channelId, target.userId);
            }}
          />
        ))}
      </ActionSheet>
    </View>
  );
}
