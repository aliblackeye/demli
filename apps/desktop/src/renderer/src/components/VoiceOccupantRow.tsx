import { memo, type MouseEvent } from "react";
import { MicOff, MoreVertical } from "lucide-react";
import { ContextMenuLabel, UserAvatar, cn } from "@demli/ui";
import { ActionMenu, openActionMenuAt } from "@demli/app-ui";
import type { VoiceOccupant } from "@demli/protocol";
import type { ChannelId, GroupId, UserId } from "@demli/types";
import { useAppTranslation } from "../lib/i18n";
import { useAuthStore } from "../stores/auth-store";
import { useChatStore } from "../stores/chat-store";
import { ParticipantActionItems } from "./ParticipantActionItems";
import { ProfileCard } from "./ProfileCard";

/**
 * Open the row's action menu from a tap on the kebab (touch/narrow discoverability
 * + no right-click on mobile). Dispatches a bubbling `contextmenu` at the kebab,
 * which the row's {@link ActionMenu} trigger (the <li>) handles.
 */
function openOccupantMenu(event: MouseEvent<HTMLButtonElement>): void {
  event.preventDefault();
  event.stopPropagation();
  const rect = event.currentTarget.getBoundingClientRect();
  openActionMenuAt(event.currentTarget, rect.left, rect.bottom);
}

export interface VoiceOccupantRowProps {
  occupant: VoiceOccupant;
  /** The voice channel this occupant is in — disconnect target. */
  channelId?: ChannelId | null;
  /** The server that owns the channel — kick/ban + profile role context. */
  groupId?: GroupId | null;
  /** Viewer is owner ∨ KICK_MEMBERS on this server — gates the moderation items (§35). */
  canModerate?: boolean;
  /** The server owner's id — the owner is never a moderation target. */
  ownerId?: UserId | null;
}

/**
 * One occupant of a voice channel the local user is NOT in — the cross-channel
 * "who is in voice" row. Lighter than {@link VoiceParticipant}: the server
 * `voice.participant_*` delta carries only `{ userId, muted }`, so there is no
 * speaking / camera / screen-share state to render (that lives in the LiveKit
 * voice store for the ONE room you are actually in). Resolves the display name +
 * avatar from the shared user directory (seeded by group details). Memoized so an
 * unrelated occupant change never rerenders this row (CLAUDE.md §27).
 *
 * Same row geometry and hover tone as {@link VoiceParticipant}, so a channel you
 * are in and one you are not read as the same list — only the live signals
 * (speaking light, CANLI pill) are absent, because they are not known here.
 *
 * Interaction mirrors {@link VoiceParticipant}: LEFT-click the avatar/name opens
 * the profile card; RIGHT-click opens the action menu (social + gated moderation).
 * No per-user volume here — the occupant is not in our room, so there is no audio
 * track to attenuate.
 */
export const VoiceOccupantRow = memo(function VoiceOccupantRow({
  occupant,
  channelId = null,
  groupId = null,
  canModerate = false,
  ownerId = null,
}: VoiceOccupantRowProps): JSX.Element {
  const { t } = useAppTranslation();
  const meId = useAuthStore((s) => s.user?.id);
  const user = useChatStore((s) => s.users[occupant.userId]);
  const name = user?.displayName ?? user?.username ?? occupant.userId;
  const isSelf = meId === occupant.userId;
  const isTargetOwner = ownerId != null && ownerId === occupant.userId;

  const row = (
    <li
      data-testid="voice-occupant"
      className="group flex h-8 items-center gap-2 rounded-lg px-2 transition-colors motion-hover hover:bg-hover"
    >
      {/* Left-click → profile card (a button trigger, so right-click still reaches
          the row's context menu unimpeded). */}
      <ProfileCard userId={occupant.userId} groupId={groupId ?? undefined}>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <span className="inline-flex shrink-0 [--avatar-ring:var(--color-sidebar)]">
            <UserAvatar
              name={name}
              colorSeed={occupant.userId}
              src={user?.avatarUrl ?? null}
              size="xs"
            />
          </span>
          <span className="min-w-0 flex-1 truncate text-label text-fg-muted transition-colors motion-hover group-hover:text-fg">
            {name}
          </span>
        </button>
      </ProfileCard>
      {/* Touch-reachable entry to the action menu (no right-click on mobile) — not
          for yourself (nothing to act on). Hidden + removed from layout on a fine
          pointer so wide-screen occupant rows are byte-identical (right-click still
          opens the menu there); shown only on a coarse pointer / narrow viewport. */}
      {!isSelf && (
        <button
          type="button"
          aria-label={t("a11y.moreActions")}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={openOccupantMenu}
          className={cn(
            "hidden size-6 shrink-0 items-center justify-center rounded-md text-fg-faint",
            "transition-colors motion-hover hover:bg-wash hover:text-fg",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
            "pointer-coarse:inline-flex max-[899px]:inline-flex",
          )}
        >
          <MoreVertical className="size-3.5" aria-hidden />
        </button>
      )}
      {occupant.muted && (
        <MicOff
          role="img"
          aria-label={t("desktop:voice.mutedIndicator")}
          className="size-3.5 shrink-0 text-danger"
        />
      )}
    </li>
  );

  // Nothing to act on for yourself — render the row without a context menu.
  if (isSelf) return row;

  return (
    <ActionMenu
      contentClassName="w-56"
      menu={
        <>
          <ContextMenuLabel className="truncate normal-case tracking-normal text-fg-muted">
            {name}
          </ContextMenuLabel>
          <ParticipantActionItems
            userId={occupant.userId}
            groupId={groupId}
            channelId={channelId}
            isSelf={false}
            isTargetOwner={isTargetOwner}
            canModerate={canModerate}
            inVoice
          />
        </>
      }
    >
      {row}
    </ActionMenu>
  );
});
