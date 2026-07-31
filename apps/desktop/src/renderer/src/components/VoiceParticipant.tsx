import { memo, type MouseEvent } from "react";
import { HeadphoneOff, MicOff, MonitorUp, MoreVertical, Video, VolumeX } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger, UserAvatar, cn } from "@demli/ui";
import { openActionMenuAt } from "@demli/app-ui";
import type { VoiceParticipant as VoiceParticipantData } from "@demli/media";
import type { ChannelId, GroupId, UserId } from "@demli/types";
import { useAppTranslation } from "../lib/i18n";
import { useChatStore } from "../stores/chat-store";
import { ParticipantVolumeMenu } from "./ParticipantVolumeMenu";
import { ProfileCard } from "./ProfileCard";

/**
 * Surface the action menu from a tappable kebab too (task #9): the per-user
 * volume + social/moderation menu lived behind a right-click only, which is not
 * discoverable — and unreachable on touch. {@link openActionMenuAt} dispatches a
 * bubbling `contextmenu` at the kebab, which the row's {@link ParticipantVolumeMenu}
 * (now an {@link ActionMenu}) opens — the shared helper the whole app uses.
 */
function openAudioMenu(event: MouseEvent<HTMLButtonElement>): void {
  event.preventDefault();
  event.stopPropagation();
  const rect = event.currentTarget.getBoundingClientRect();
  openActionMenuAt(event.currentTarget, rect.left, rect.bottom);
}

export interface VoiceParticipantProps {
  participant: VoiceParticipantData;
  /** The voice channel this participant is in (= our connected room) — disconnect target. */
  channelId?: ChannelId | null;
  /** The server that owns the channel — kick/ban + profile role context. */
  groupId?: GroupId | null;
  /** Viewer is owner ∨ KICK_MEMBERS on this server — gates the moderation items (§35). */
  canModerate?: boolean;
  /** The server owner's id — the owner is never a moderation target. */
  ownerId?: UserId | null;
}

/**
 * One participant row (voice panel + under voice channels). Memoized — the
 * speaking simulation replaces only changed participant objects, so idle rows
 * skip rerendering entirely (CLAUDE.md §27).
 *
 * Interaction: LEFT-click the avatar/name opens the profile card
 * (message / add-friend); RIGHT-click (or the hover kebab) opens the action menu
 * (per-user volume + social + gated moderation). The two never collide — the
 * profile trigger only handles click, the row is the context-menu trigger.
 */
export const VoiceParticipant = memo(function VoiceParticipant({
  participant,
  channelId = null,
  groupId = null,
  canModerate = false,
  ownerId = null,
}: VoiceParticipantProps): JSX.Element {
  const { t } = useAppTranslation();
  const user = useChatStore((s) => s.users[participant.userId]);
  const name = user?.displayName ?? participant.identity;
  // Personally muted (volume 0) — only meaningful for a remote (local is always 1).
  const locallyMuted = !participant.isLocal && participant.volume <= 0;
  const isTargetOwner = ownerId != null && ownerId === participant.userId;

  return (
    <ParticipantVolumeMenu
      participant={participant}
      channelId={channelId}
      groupId={groupId}
      canModerate={canModerate}
      isTargetOwner={isTargetOwner}
    >
      <li className="group flex items-center gap-2 rounded-md px-1.5 py-0.5 transition-colors motion-instant hover:bg-white/[0.04]">
        {/* Left-click → profile card. A button (not the whole row) is the trigger
            so right-click still reaches the row's context menu unimpeded. */}
        <ProfileCard userId={participant.userId} groupId={groupId ?? undefined}>
          <button
            type="button"
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2 rounded text-left",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
            )}
          >
            <UserAvatar
              name={name}
              colorSeed={participant.userId}
              src={user?.avatarUrl ?? null}
              size="xs"
              speaking={participant.speaking}
            />
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[13px]",
                participant.speaking ? "font-medium text-fg" : "text-fg-muted",
              )}
            >
              {name}
            </span>
          </button>
        </ProfileCard>
        {/* Discoverable entry to the per-user audio menu — remotes only; you
            can't attenuate yourself (task #9). Hidden until row hover / focus. */}
        {!participant.isLocal && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t("desktop:voice.audioOptions")}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={openAudioMenu}
                className={cn(
                  "shrink-0 rounded p-0.5 text-fg-faint opacity-0 transition-opacity motion-instant",
                  "hover:text-fg focus-visible:opacity-100 focus-visible:outline-none",
                  "focus-visible:ring-2 focus-visible:ring-accent/70 group-hover:opacity-100",
                  // No hover on touch: keep the kebab visible on coarse pointers /
                  // narrow viewports so the menu stays reachable without right-click.
                  "pointer-coarse:opacity-100 max-[899px]:opacity-100",
                )}
              >
                <MoreVertical className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">{t("desktop:voice.audioOptions")}</TooltipContent>
          </Tooltip>
        )}
        {locallyMuted && (
          <VolumeX
            aria-label={t("desktop:voice.userMutedIndicator")}
            className="size-3.5 shrink-0 text-fg-faint"
          />
        )}
        {participant.cameraEnabled && (
          <Video
            aria-label={t("desktop:voice.cameraIndicator")}
            className="size-3.5 shrink-0 text-online"
          />
        )}
        {participant.screenSharing && (
          <MonitorUp
            aria-label={t("desktop:voice.sharingIndicator")}
            className="size-3.5 shrink-0 text-online"
          />
        )}
        {!participant.micEnabled && (
          <MicOff
            aria-label={t("desktop:voice.mutedIndicator")}
            className="size-3.5 shrink-0 text-fg-faint"
          />
        )}
        {/* Deafened → headphone-off, next to the mic-muted icon.
            A deafened user is always mic-muted too, so both glyphs show; the danger
            tone distinguishes deafen from a plain mute (§11, LiveKit-attribute fed). */}
        {participant.deafened && (
          <HeadphoneOff
            aria-label={t("desktop:voice.deafenedIndicator")}
            className="size-3.5 shrink-0 text-danger"
          />
        )}
      </li>
    </ParticipantVolumeMenu>
  );
});
