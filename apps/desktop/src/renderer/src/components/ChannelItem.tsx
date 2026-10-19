import type { ReactNode } from "react";
import { BellOff, Hash, Lock, MessageSquare, Pencil, UserPlus, Volume2 } from "lucide-react";
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from "@demli/ui";
import {
  ActionMenu,
  shellRowClass,
  shellRowIconButtonClass,
  shellUnreadPipClass,
  type RenderChannelOptions,
} from "@demli/app-ui";
import { unreadBadgeText } from "@demli/client-core";
import type { Channel, ChannelId, GroupId } from "@demli/types";
import { PERMISSIONS } from "@demli/types";
import type { VoiceParticipant as VoiceParticipantData } from "@demli/media";
import type { VoiceOccupant } from "@demli/protocol";
import { useAppTranslation } from "../lib/i18n";
import { channelMuteModeFor, useChatStore } from "../stores/chat-store";
import { useDraftStore } from "../stores/draft-store";
import { hasDraft } from "../stores/draft-model";
import { useGroupDetails, useServerPermissions } from "../queries/chat-queries";
import {
  activateVoiceChannel,
  joinVoiceChannel,
  leaveVoiceRoom,
  openChannelChat,
} from "../lib/channel-actions";
import { planChannelRowControls, type ChannelRowControlsPlan } from "./channelRowControls";
import { NotificationMuteSubmenu } from "./NotificationMuteSubmenu";
import { UnreadCountBadge } from "./UnreadCountBadge";
import { useVoiceStore } from "../stores/voice-store";
import { NO_OCCUPANTS, useVoiceOccupancyStore } from "../stores/voice-occupancy-store";
import { useUiStore } from "../stores/ui-store";
import { VoiceParticipant } from "./VoiceParticipant";
import { VoiceOccupantRow } from "./VoiceOccupantRow";

const NO_PARTICIPANTS: VoiceParticipantData[] = [];

/**
 * The members under a voice channel row. Two sources:
 * - the ONE room we are connected to renders the rich LiveKit view (speaking,
 *   mic, camera, screen) from the voice store;
 * - every OTHER visible voice channel renders server-authoritative occupancy
 *   ({@link VoiceOccupantRow}), fed by `voice.participant_*` deltas + the
 *   `auth.succeeded` snapshot, so we see who is in rooms we have not joined.
 * Empty voice channels render nothing.
 */
function VoiceChannelOccupants({
  channelId,
  groupId,
}: {
  channelId: ChannelId;
  groupId: GroupId;
}): JSX.Element | null {
  const { t } = useAppTranslation();
  const ownParticipants = useVoiceStore((s) =>
    s.roomId === channelId && s.status === "connected" ? s.participants : NO_PARTICIPANTS,
  );
  const occupants = useVoiceOccupancyStore(
    (s): readonly VoiceOccupant[] => s.byChannel[channelId] ?? NO_OCCUPANTS,
  );

  // The viewer's moderation authority on THIS channel's server, computed once and
  // passed down (not per row) — kick/ban/disconnect show only for owner ∨
  // KICK_MEMBERS (§35). Cached React-Query reads, so the many voice channels in a
  // group all share one fetch (§27).
  const { data: details } = useGroupDetails(groupId);
  const ownerId = details?.group.ownerId ?? null;
  const { isOwner, can } = useServerPermissions(groupId);
  const canModerate = isOwner || can(PERMISSIONS.KICK_MEMBERS);

  // Our own room: the LiveKit view is richer and authoritative for it.
  if (ownParticipants.length > 0) {
    return (
      <ul className="mb-0.5 ml-6 mr-1" aria-label={t("desktop:channel.connectedToVoice")}>
        {ownParticipants.map((participant) => (
          <VoiceParticipant
            key={participant.userId}
            participant={participant}
            channelId={channelId}
            groupId={groupId}
            canModerate={canModerate}
            ownerId={ownerId}
          />
        ))}
      </ul>
    );
  }

  if (occupants.length === 0) return null;
  return (
    <ul className="mb-0.5 ml-6 mr-1" aria-label={t("desktop:channel.connectedToVoice")}>
      {occupants.map((occupant) => (
        <VoiceOccupantRow
          key={occupant.userId}
          occupant={occupant}
          channelId={channelId}
          groupId={groupId}
          canModerate={canModerate}
          ownerId={ownerId}
        />
      ))}
    </ul>
  );
}

/**
 * One secondary icon control on a channel row.
 *
 * Secondary chrome, so it follows the same three-way reveal rule the kebab uses:
 * hidden until the row is hovered on a fine pointer, and PERMANENTLY visible
 * (and clickable) on a coarse pointer, on a narrow viewport, or under keyboard
 * focus — the surfaces where there is no hover and a hover-only control would
 * simply not exist for the user at all.
 *
 * The exact reveal classes come from `planChannelRowControls`, not from here:
 * the invite control is pinned ON while its row is SELECTED (the founder's
 * "hover edince veya seçili olunca"), and keeping that decision in one testable
 * place is what stops a hand-inlined variant quietly losing the `pointer-coarse:`
 * half — which looks perfect in review and is invisible on a phone.
 *
 * Rendered as a SIBLING of the row button (inside ActionMenu's `trailing` slot),
 * never a child: a `<button>` inside a `<button>` is invalid HTML and browsers
 * resolve it by dropping the nesting, which would silently make this control
 * fire the row's handler — i.e. join a voice room — instead of its own.
 */
function RowIconButton({
  label,
  icon,
  onActivate,
  revealClasses,
}: {
  label: string;
  icon: ReactNode;
  onActivate: () => void;
  /** From `planChannelRowControls` — never hand-written at the call site. */
  revealClasses: string;
}): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          // The row underneath reacts to click AND arms a long-press menu, so
          // neither the press nor the click may reach it — a leaked click here
          // would connect the user to voice, which is exactly what these controls
          // exist to avoid.
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onActivate();
          }}
          className={cn(
            shellRowIconButtonClass,
            // Keyboard focus reveals the control even where hover would not.
            "focus-visible:pointer-events-auto focus-visible:opacity-100",
            revealClasses,
          )}
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The row's trailing controls, in one absolutely-positioned strip.
 *
 * ONE container rather than each button placing itself: the number of controls
 * varies by row (a text channel the viewer cannot invite to has none; a voice
 * channel they can invite to has two), and per-button `right-…` offsets would
 * have to encode that count at every site. A flex strip lets each button just
 * exist, and leaves exactly one place — `trailingPaddingClasses` — that has to
 * know how much room to reserve on the row itself.
 *
 * The strip sits left of the kebab wherever the kebab is actually shown (coarse
 * pointer / narrow viewport) and takes the corner itself otherwise.
 *
 * Both controls exist because their capability has no other reachable home on
 * every input model (§35):
 *   - "open chat without joining" — a voice channel's chat is readable by anyone
 *     who can see the channel (ADR 0007), but the row's own click CONNECTS you;
 *   - "invite into this channel" — the founder's requested affordance, shown
 *     only to a viewer the server would actually let create an invite.
 */
function ChannelRowActions({
  channel,
  plan,
  isVoice,
  openInvite,
}: {
  channel: Channel;
  plan: ChannelRowControlsPlan;
  isVoice: boolean;
  openInvite: () => void;
}): JSX.Element | null {
  const { t } = useAppTranslation();
  if (plan.slots === 0) return null;

  return (
    <div
      className={cn(
        "absolute top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5",
        "right-1 pointer-coarse:right-8 max-[899px]:right-8",
      )}
    >
      {plan.showChatControl && (
        <RowIconButton
          label={t("desktop:channel.openChat")}
          icon={<MessageSquare className="size-3.5" aria-hidden />}
          onActivate={() => openChannelChat(channel)}
          revealClasses={plan.chatRevealClasses}
        />
      )}
      {plan.showInviteControl && (
        <RowIconButton
          label={
            isVoice
              ? t("desktop:channel.inviteToVoice")
              : t("desktop:channel.inviteToChannel")
          }
          icon={<UserPlus className="size-3.5" aria-hidden />}
          onActivate={openInvite}
          revealClasses={plan.inviteRevealClasses}
        />
      )}
    </div>
  );
}

/**
 * The inert options a caller that does not supply them gets: no management, no
 * reordering, no drag. Module-level so its identity is stable across renders.
 */
const PLAIN_OPTIONS: RenderChannelOptions = {
  canManage: false,
  groupName: null,
  ordering: null,
  dragProps: { draggable: false, onDragStart: () => {}, onDragEnd: () => {} },
  // Fails CLOSED: a caller that has not resolved the invite policy offers no
  // invite control at all, rather than one the server would refuse.
  canInvite: false,
  openInvite: () => {},
};

export function ChannelItem({
  channel,
  options = PLAIN_OPTIONS,
}: {
  channel: Channel;
  /**
   * Everything the shared sidebar knows about this row: `canManage` (owner ∨
   * MANAGE_CHANNELS — gates edit/delete), `groupName` (recorded on a voice join
   * for the panel, task #2), the M18 `ordering` actions, the drag props to
   * spread onto the row, and `canInvite` (the `invite_policy` gate). `ordering`
   * is null for a viewer who may not reorder and `canInvite` is false for one who
   * may not invite, so those entries never render at all (§35).
   */
  options?: RenderChannelOptions;
}): JSX.Element {
  const { t } = useAppTranslation();
  const { canManage, groupName, ordering, dragProps, canInvite, openInvite } = options;
  const isActive = useChatStore((s) => s.activeChannelId === channel.id);
  const isUnread = useChatStore((s) => Boolean(s.unreadChannelIds[channel.id]));
  const isMentionUnread = useChatStore((s) => Boolean(s.mentionUnreadChannelIds[channel.id]));
  const unreadCount = useChatStore((s) => s.unreadCounts[channel.id] ?? 0);
  // A saved unsent draft on this channel shows a pencil (M17) — voice channels
  // included since M20, because they carry the same composer and the draft store
  // was always keyed by plain channel id. Boolean selector → the row only
  // repaints when the presence of a draft flips (§27).
  const showDraft = useDraftStore((s) => hasDraft(s.drafts, channel.id));
  // Effective mute mode for this channel: its own mute wins over its group's.
  const muteMode = useChatStore((s) =>
    channelMuteModeFor(s.notificationMutes, channel.id, channel.groupId),
  );
  const markChannelRead = useChatStore((s) => s.markChannelRead);
  const isVoiceTarget = useVoiceStore((s) => s.roomId === channel.id && s.status !== "idle");
  const openChannelSettings = useUiStore((s) => s.openChannelSettings);

  const isVoice = channel.kind === "voice";
  const Icon = isVoice ? Volume2 : Hash;

  // The primary gesture, per kind. A TEXT channel opens its chat; a VOICE
  // channel CONNECTS you and opens the room's chat with it (founder decision:
  // in a voice channel the action you came for is to JOIN), except when it is
  // the room you are already in, where it only opens the chat. Both arms
  // escape the video stage mid-call (§7), and
  // neither drives the voice engine itself: `activateVoiceChannel` goes through
  // the join guard, which owns the single media FSM (§11).
  //
  // Reading a voice channel WITHOUT connecting is not lost — it moved to
  // {@link ChannelRowActions} on the row and the "open chat" entry in the menu
  // below, so the capability keeps a reachable control on every input model.
  const handleClick = (): void =>
    isVoice ? activateVoiceChannel(channel, groupName) : openChannelChat(channel);

  // Two INDEPENDENT row states now, where a voice row used to have only one:
  // `isActive` is "your chat is reading this channel", `isVoiceTarget` is "your
  // microphone is in this room". They are routinely true of different rows, so
  // the selected wash follows selection alone — folding the connection into it
  // would suppress the unread pip on the very channel you are talking in but not
  // reading (task #3).
  const highlighted = isActive;

  // Which trailing controls this row shows and how each reveals — one decision,
  // read by the icon strip AND by the row's right-hand padding below.
  const rowControls = planChannelRowControls({
    isVoice,
    canInvite,
    selected: highlighted,
  });

  // Badge suppression (migration 0013): "all" hides the unread pip entirely;
  // "mentions" hides the plain pip but keeps it for a mention (a distinct accent
  // dot). A muted-but-not-highlighted row is dimmed.
  const muted = muteMode !== null;
  const showMentionBadge = muteMode === "mentions" && isMentionUnread;
  const showUnread = isUnread && (muteMode === null || showMentionBadge);
  // #110 count badge: a genuine number for a counted, non-mentions-muted unread.
  // A mentions-muted channel's raw count would include muted noise, so it keeps
  // the pip instead of showing a misleading number.
  const countBadge = showUnread && muteMode !== "mentions" ? unreadBadgeText(unreadCount, true) : null;
  const showNumberBadge = countBadge !== null && countBadge !== "1+";

  return (
    <>
      <ActionMenu
        kebab={{ label: t("a11y.moreActions") }}
        trailing={
          <ChannelRowActions
            channel={channel}
            plan={rowControls}
            isVoice={isVoice}
            openInvite={openInvite}
          />
        }
        menu={
          <>
            {/* Both voice gestures, spelled out. "Open chat" is the keyboard and
                right-click path to what the row's chat icon does — that icon is
                hover-revealed on a fine pointer, so without this entry the
                read-without-joining capability would depend on discovering a
                hover affordance (§35). The room entry mirrors the live session:
                join when we are elsewhere, disconnect when we are in it. */}
            {isVoice && (
              <>
                <ContextMenuItem onSelect={() => openChannelChat(channel)}>
                  {t("desktop:channel.openChat")}
                </ContextMenuItem>
                {isVoiceTarget ? (
                  <ContextMenuItem onSelect={() => leaveVoiceRoom()}>
                    {t("desktop:voice.disconnect")}
                  </ContextMenuItem>
                ) : (
                  <ContextMenuItem onSelect={() => joinVoiceChannel(channel, groupName)}>
                    {t("desktop:channel.joinVoiceShort")}
                  </ContextMenuItem>
                )}
                <ContextMenuSeparator />
              </>
            )}
            {/* "Mark as read" applies to every channel that has a message stream
                — which since M20 includes voice channels (task #6 predates it). */}
            <ContextMenuItem onSelect={() => markChannelRead(channel.id)}>
              {t("desktop:channel.markRead")}
            </ContextMenuItem>
            {/* The keyboard / right-click path to the row's invite icon, and the
                only one on a surface where hover does not exist. Gated on the
                SAME `canInvite` as the icon, so a viewer the server would refuse
                sees neither — the founder's reference screenshot of a member
                without the permission has no invite row at all (§35).
                It now targets THIS CHANNEL rather than opening the generic server
                invite: that generic entry was previously shown to everyone here,
                which is exactly the "control that can only 403" this replaces. */}
            {canInvite && (
              <ContextMenuItem onSelect={openInvite}>
                {isVoice
                  ? t("desktop:channel.inviteToVoice")
                  : t("desktop:channel.inviteToChannel")}
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
            <NotificationMuteSubmenu scope="channel" targetId={channel.id} isMuted={muted} />
            {/* Reordering without a mouse drag (M18): HTML5 drag-and-drop does not
                exist on touch and the web app is opened from phones, so every move
                the drag affords is also reachable here. Each entry is omitted when
                it would be a no-op — an edge channel shows no "move up" at all
                rather than a disabled one (§35). */}
            {ordering &&
              (ordering.canMoveUp || ordering.canMoveDown || ordering.moveTargets.length > 0) && (
                <>
                  <ContextMenuSeparator />
                  {ordering.canMoveUp && (
                    <ContextMenuItem onSelect={ordering.moveUp}>
                      {t("desktop:sidebar.moveUp")}
                    </ContextMenuItem>
                  )}
                  {ordering.canMoveDown && (
                    <ContextMenuItem onSelect={ordering.moveDown}>
                      {t("desktop:sidebar.moveDown")}
                    </ContextMenuItem>
                  )}
                  {ordering.moveTargets.length > 0 && (
                    <ContextMenuSub>
                      <ContextMenuSubTrigger>
                        {t("desktop:sidebar.moveToCategory")}
                      </ContextMenuSubTrigger>
                      <ContextMenuSubContent className="w-52">
                        {ordering.moveTargets.map((target) => (
                          <ContextMenuItem
                            key={target.id ?? "uncategorized"}
                            onSelect={() => ordering.moveTo(target.id)}
                          >
                            <span className="min-w-0 truncate">{target.name}</span>
                          </ContextMenuItem>
                        ))}
                      </ContextMenuSubContent>
                    </ContextMenuSub>
                  )}
                </>
              )}
            {canManage && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => openChannelSettings(channel.id)}>
                  {t("desktop:channel.edit")}
                </ContextMenuItem>
                {/* Delete carries a delete intent so the settings dialog opens
                    straight on its confirm step, not the generic editor (task #1). */}
                <ContextMenuItem danger onSelect={() => openChannelSettings(channel.id, "delete")}>
                  {t("desktop:channel.delete")}
                </ContextMenuItem>
              </>
            )}
          </>
        }
      >
        <button
          type="button"
          onClick={handleClick}
          aria-current={highlighted ? "true" : undefined}
          // The row IS the drag handle (M18). Spread rather than hand-written so
          // the shared sidebar owns every placement decision; for a viewer who may
          // not reorder these are inert no-ops and `draggable` is false.
          {...dragProps}
          className={cn(
            // The shell's one row language (selected coral wash, surface-tone
            // hover, deeper press, quiet muted) — shared with every other list.
            shellRowClass({ selected: highlighted, unread: showUnread, muted }),
            // Compact 32px rows: the overhaul's 44px rhythm read as oversized to
            // the founder.
            "group h-8 gap-2 px-2 text-sm",
            // Reserve room on the right for the always-on touch/narrow kebab so it
            // never overlaps the unread/mute/lock badges (kebab is hover-only on a
            // fine pointer, where no reservation is needed).
            "pointer-coarse:pr-9 max-[899px]:pr-9",
            // Plus one slot per trailing control this row actually renders
            // (voice chat icon, invite icon) — see channelRowControls.
            rowControls.paddingClasses,
          )}
        >
            {showUnread && !highlighted && !showNumberBadge && (
              <span
                aria-label={t("desktop:channel.unread")}
                className={shellUnreadPipClass(showMentionBadge)}
              />
            )}
            {/* The glyph is where "your mic is in this room" lives now that the
                row wash means "your chat is reading this channel". The two
                states are independent, so they need independent signals — and
                independent colours: selection is coral (the row wash), a live
                voice connection is the success green every "connected" state
                in the app uses. */}
            <Icon
              className={cn(
                "size-[18px] shrink-0 transition-colors motion-hover",
                isVoiceTarget
                  ? "text-success"
                  : highlighted
                    ? "text-accent"
                    : "text-fg-faint group-hover:text-fg-muted",
              )}
              aria-label={isVoiceTarget ? t("desktop:channel.connectedToVoice") : undefined}
            />
            <span
              className={cn(
                "min-w-0 truncate",
                showUnread && !highlighted && "font-semibold",
                isVoiceTarget && !highlighted && "text-fg",
              )}
            >
              {channel.name}
            </span>
            {/* NSFW / 18+ marker next to the channel name. Access
                is gated on entry (NsfwChannelGate); this is the at-a-glance hint. */}
            {channel.nsfw && (
              <span
                aria-label={t("desktop:channel.nsfw")}
                title={t("desktop:channel.nsfw")}
                className="shrink-0 rounded-[5px] bg-danger-surface px-1 py-0.5 text-badge font-semibold leading-none text-danger"
              >
                18+
              </span>
            )}
            {(showDraft || muted || channel.restricted || showNumberBadge) && (
              <span className="ml-auto flex shrink-0 items-center gap-1">
                {showDraft && (
                  <Pencil
                    aria-label={t("desktop:channel.hasDraft")}
                    className="size-3 text-fg-faint"
                  />
                )}
                {muted && (
                  <BellOff
                    aria-label={t("desktop:mute.mutedA11y")}
                    className="size-3 text-fg-faint"
                  />
                )}
                {channel.restricted && (
                  <Lock
                    aria-label={t("desktop:channel.restricted")}
                    className="size-3 text-fg-faint"
                  />
                )}
                {showNumberBadge && countBadge && (
                  <UnreadCountBadge
                    key={countBadge}
                    text={countBadge}
                    tone={isMentionUnread ? "accent" : "neutral"}
                    aria-label={t("desktop:channel.unread")}
                  />
                )}
              </span>
            )}
          </button>
      </ActionMenu>
      {isVoice && <VoiceChannelOccupants channelId={channel.id} groupId={channel.groupId} />}
    </>
  );
}
