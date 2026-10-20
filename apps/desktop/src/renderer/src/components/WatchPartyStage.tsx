/**
 * Watch-party tile for the voice stage (M20, ADR 0016) — the player plus the
 * thin band of state around it: who is driving, what this user may do about it,
 * and any refusal the gateway sent back.
 *
 * ## The host / viewer split is the whole design
 *
 * A viewer sees NO transport controls. Not greyed-out ones with a tooltip:
 * §35 forbids a control that looks pressable and does nothing, and the gateway
 * would refuse the frame anyway (`NOT_HOST`). What a viewer gets instead is the
 * one fact they actually need — who IS driving — and the host-transfer path is
 * the host's to offer, not theirs to request.
 *
 * The server owner override (ADR 0016 §Authority step 4) is honoured here too:
 * an owner sees host controls in their own server even when someone else holds
 * the host role, so a room is never held hostage by a host who wandered off.
 * That is COSMETIC gating like every other client-side permission check — the
 * gateway re-decides, and this component simply agrees with it.
 *
 * ## Renders
 *
 * The 5 s heartbeat writes to the watch store every tick for an active room, and
 * this subtree is the only one that subscribes to the session object (§27) —
 * everything else in the shell reads the boolean `useHasWatchParty`. Inside the
 * player itself the per-second readings live in refs and re-render nothing.
 */

import { useCallback, useMemo, useState } from "react";
import { ListVideo, Repeat2, Square, Tv, UserRoundCog } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  UserAvatar,
  cn,
} from "@demli/ui";
import { WatchQueuePanel, type WatchQueueEntry } from "@demli/app-ui";
import type { ChannelId, GroupId, UserId } from "@demli/types";
import { useAppTranslation } from "../lib/i18n";
import { watchControlMode, type HostControlIntent } from "@demli/client-core";
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
} from "../realtime/connection";
import { useServerPermissions } from "../queries/chat-queries";
import { useAuthStore } from "../stores/auth-store";
import { useChatStore } from "../stores/chat-store";
import {
  useWatchPartyStore,
  useWatchQueue,
  useWatchRefusal,
  useWatchSession,
  useWatchVideoTitle,
} from "../stores/watch-party-store";
import { NO_OCCUPANTS, useVoiceOccupancyStore } from "../stores/voice-occupancy-store";
import { WatchPartyPlayer } from "./WatchPartyPlayer";
import { WatchVideoDialog } from "./WatchVideoDialog";

export interface WatchPartyStageProps {
  /** The voice channel the party is bound to. */
  channelId: ChannelId;
  /** The server that channel belongs to — for the owner override. */
  groupId: GroupId | null;
  className?: string;
}

export function WatchPartyStage({
  channelId,
  groupId,
  className,
}: WatchPartyStageProps): JSX.Element | null {
  const { t } = useAppTranslation();
  const session = useWatchSession(channelId);
  const queue = useWatchQueue(channelId);
  const nowPlayingTitle = useWatchVideoTitle(channelId, session?.videoId ?? null);
  const refusal = useWatchRefusal(channelId);
  const clearRefusal = useWatchPartyStore((s) => s.clearRefusal);
  const myId = useAuthStore((s) => s.user?.id ?? null);
  const { isOwner } = useServerPermissions(groupId);
  const users = useChatStore((s) => s.users);
  const occupants = useVoiceOccupancyStore((s) => s.byChannel[channelId] ?? NO_OCCUPANTS);

  /** Which dialog the picker is currently serving, or null when it is closed. */
  const [picker, setPicker] = useState<"change" | "queue" | null>(null);
  /**
   * The queue panel is open by default for everyone: "what is next?" is the
   * question the feature exists to answer, and a panel nobody discovers answers
   * it for nobody. It collapses because a 16:9 video on a narrow window wants
   * the width back.
   */
  const [queueOpen, setQueueOpen] = useState(true);

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
   * The host's player reached the end of the video — advance the room.
   *
   * Stable for the same reason as `onHostControl`, and host-gated inside the
   * player rather than here so this component does not need to re-create the
   * callback when the owner override flips.
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
  const onQueueAdd = useCallback(() => setPicker("queue"), []);

  /**
   * Queue rows joined to display names.
   *
   * Memoized on the queue and the roster, so the 5 s heartbeat — which rewrites
   * `sessions`, not `queues` — produces a stable array and the memoized panel
   * below re-renders on a real queue change and on nothing else (§27).
   */
  const queueEntries = useMemo<WatchQueueEntry[]>(
    () =>
      queue.map((item) => ({
        itemId: item.itemId,
        videoId: item.videoId,
        title: item.title,
        durationSeconds: item.durationSeconds,
        addedByName:
          users[item.addedBy]?.displayName ?? t("desktop:watchParty.unknownMember"),
      })),
    [queue, users, t],
  );

  const hostName = session ? (users[session.hostId]?.displayName ?? null) : null;
  const hostAvatarUrl = session ? (users[session.hostId]?.avatarUrl ?? null) : null;

  /**
   * Transfer targets: the room's OTHER occupants. The gateway rejects a transfer
   * to somebody who is not in the voice channel (`INVALID_PAYLOAD`), so offering
   * anyone else here would be offering a button that fails — the menu is built
   * from the same server-truth occupancy the gateway checks against.
   */
  const transferTargets = useMemo(() => {
    if (!session) return [];
    return occupants
      .filter((occupant) => occupant.userId !== session.hostId)
      .map((occupant) => ({
        userId: occupant.userId,
        name: users[occupant.userId]?.displayName ?? t("desktop:watchParty.unknownMember"),
      }));
  }, [occupants, session, users, t]);

  if (!session) return null;

  const refusalMessage =
    refusal === null
      ? null
      : refusal === "NOT_IN_VOICE"
        ? t("desktop:watchParty.refusalNotInVoice")
        : refusal === "NOT_HOST"
          ? t("desktop:watchParty.refusalNotHost")
          : refusal === "WATCH_QUEUE_FULL"
            ? t("desktop:watchParty.refusalQueueFull")
            : t("desktop:watchParty.refusalNotActive");

  return (
    <div className={cn("flex h-full w-full min-h-0 flex-col gap-2", className)}>
      {/* Status band. Compact on purpose — the video is the point, and this is
          the smallest amount of chrome that still answers "who is driving?". */}
      <div
        data-testid="watch-band"
        // Borderless band one tone above the stage card; the coral TV glyph is
        // the party's one warm mark.
        className="flex shrink-0 items-center gap-2 rounded-xl bg-surface py-1.5 pl-3 pr-1.5"
      >
        <Tv className="size-4 shrink-0 text-accent" aria-hidden />
        <span className="shrink-0 font-display text-label font-medium text-fg-display">
          {t("desktop:watchParty.title")}
        </span>
        <span aria-hidden className="size-1 shrink-0 rounded-full bg-fg-subtle" />
        <div className="flex min-w-0 items-center gap-1.5">
          <UserAvatar
            name={hostName ?? "?"}
            colorSeed={session.hostId}
            src={hostAvatarUrl}
            size="xs"
            className="[--avatar-ring:var(--color-surface)]"
          />
          <p className="truncate text-label text-fg-muted">
            {isHost
              ? t("desktop:watchParty.youAreHost")
              : t("desktop:watchParty.hostedBy", {
                  name: hostName ?? t("desktop:watchParty.unknownMember"),
                })}
          </p>
        </div>

        {/* The queue toggle is for EVERYONE — seeing what is next is not a host
            privilege, it is the question the panel exists to answer. Only the
            controls INSIDE the panel are gated. */}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={queueOpen ? "secondary" : "ghost"}
                size="icon-sm"
                aria-label={t("desktop:watchParty.queueToggle")}
                aria-pressed={queueOpen}
                onClick={() => setQueueOpen((open) => !open)}
              >
                <ListVideo className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t("desktop:watchParty.queueToggle")}
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Host-only actions. A viewer gets no disabled twins of these — the
            absence IS the message, and the line above already names the host. */}
        {isHost && (
          <div className="flex shrink-0 items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="secondary"
                  size="icon-sm"
                  aria-label={t("desktop:watchParty.changeVideo")}
                  onClick={() => setPicker("change")}
                >
                  <Repeat2 className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {t("desktop:watchParty.changeVideo")}
              </TooltipContent>
            </Tooltip>

            {/* Transfer is offered only when there is somebody to transfer TO —
                an empty menu is a control that does nothing (§35). */}
            {transferTargets.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="secondary"
                    size="icon-sm"
                    aria-label={t("desktop:watchParty.transferHost")}
                  >
                    <UserRoundCog className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {transferTargets.map((target) => (
                    <DropdownMenuItem
                      key={target.userId}
                      onSelect={() =>
                        transferWatchPartyHost(channelId, target.userId as UserId)
                      }
                    >
                      {target.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="danger"
                  size="icon-sm"
                  aria-label={t("desktop:watchParty.stop")}
                  onClick={() => stopWatchParty(channelId)}
                >
                  <Square className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t("desktop:watchParty.stop")}</TooltipContent>
            </Tooltip>
          </div>
        )}

        {!isHost && (
          <p className="hidden shrink-0 rounded-pill bg-wash px-2 py-0.5 text-2xs text-fg-faint sm:block">
            {t("desktop:watchParty.viewerMode")}
          </p>
        )}
      </div>

      {refusalMessage !== null && (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-2 rounded-xl bg-danger-surface py-1.5 pl-3 pr-1.5 animate-fade-in"
        >
          <p className="min-w-0 flex-1 text-label text-fg">{refusalMessage}</p>
          <Button variant="ghost" size="sm" onClick={clearRefusal}>
            {t("desktop:watchParty.dismiss")}
          </Button>
        </div>
      )}

      {/* Player and queue are SIBLINGS in a row, and the player comes first.
          That ordering is load-bearing: toggling the panel must not change the
          player's position in the tree, because remounting the iframe destroys
          the embed handshake and restarts playback from zero. Adding or removing
          a node AFTER it leaves it reconciled in place. */}
      <div className="flex min-h-0 flex-1 gap-2">
        <div className="min-h-0 min-w-0 flex-1">
          <WatchPartyPlayer
            session={session}
            isHost={isHost}
            onHostControl={onHostControl}
            onEnded={onEnded}
          />
        </div>

        {queueOpen && (
          <WatchQueuePanel
            className="w-64 shrink-0"
            items={queueEntries}
            nowPlaying={{ videoId: session.videoId, title: nowPlayingTitle }}
            canControl={isHost}
            onPlayNow={onQueuePlayNow}
            onRemove={onQueueRemove}
            onReorder={onQueueReorder}
            onAdd={onQueueAdd}
          />
        )}
      </div>

      <WatchVideoDialog
        open={picker !== null}
        onOpenChange={(open) => setPicker(open ? picker : null)}
        mode={picker ?? "queue"}
        channelId={channelId}
        onSubmit={(input) => {
          if (picker === "change") {
            setWatchPartyVideo(channelId, input.videoRef);
            return;
          }
          addToWatchQueue(channelId, input);
        }}
      />
    </div>
  );
}
