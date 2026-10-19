import { memo, type MouseEvent } from "react";
import { HeadphoneOff, MicOff, MoreVertical, Video, VolumeX } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger, UserAvatar, cn } from "@demli/ui";
import { openActionMenuAt } from "@demli/app-ui";
import type { VoiceParticipant as VoiceParticipantData } from "@demli/media";
import type { ChannelId, GroupId, UserId } from "@demli/types";
import { useAppTranslation } from "../lib/i18n";
import { useChatStore } from "../stores/chat-store";
import { ParticipantVolumeMenu } from "./ParticipantVolumeMenu";
import { ProfileCard } from "./ProfileCard";
import { LivePill } from "./CallControls";

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
 * The speaking light on a roster avatar: the avatar's own coral ring (UserAvatar
 * `speaking`) plus a soft coral glow behind it that fades in and out with the
 * voice (200ms tone step — a state change, not a pulse). The glow is small on
 * purpose: these rows sit in a scrolling sidebar, and a wide halo would be
 * clipped at the list edge.
 */
export function SpeakingAvatar({
  name,
  colorSeed,
  src,
  speaking,
}: {
  name: string;
  colorSeed: string;
  src: string | null;
  speaking: boolean;
}): JSX.Element {
  return (
    <span
      data-speaking={speaking || undefined}
      className={cn(
        "relative inline-flex shrink-0 rounded-full transition-shadow motion-hover",
        // The ring tone matches the row it sits on (sidebar base), so the 2px
        // separation ring never reads as a grey halo.
        "[--avatar-ring:var(--color-sidebar)]",
        speaking && "shadow-[0_0_8px_1px_var(--color-accent-glow)]",
      )}
    >
      <UserAvatar name={name} colorSeed={colorSeed} src={src} size="xs" speaking={speaking} />
    </span>
  );
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
 *
 * State glyphs, right to left in priority: deafened, muted (both the pink "off"
 * colour — something this person normally sends is cut), sharing (the coral
 * CANLI pill), camera, and "muted for you" (your own local volume at 0%).
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
      <li
        data-testid="voice-participant"
        data-speaking={participant.speaking || undefined}
        className={cn(
          // Row hover is a tone change only (Koyu Masa): the row lifts to the
          // surface step in 200ms — nothing moves.
          "group flex h-8 items-center gap-2 rounded-lg px-2 transition-colors motion-hover hover:bg-hover",
        )}
      >
        {/* Left-click → profile card. A button (not the whole row) is the trigger
            so right-click still reaches the row's context menu unimpeded. */}
        <ProfileCard userId={participant.userId} groupId={groupId ?? undefined}>
          <button
            type="button"
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2 rounded-md text-left",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
            )}
          >
            <SpeakingAvatar
              name={name}
              colorSeed={participant.userId}
              src={user?.avatarUrl ?? null}
              speaking={participant.speaking}
            />
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-label transition-colors motion-hover",
                participant.speaking ? "font-medium text-fg-display" : "text-fg-muted group-hover:text-fg",
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
                  "flex size-6 shrink-0 items-center justify-center rounded-md text-fg-faint opacity-0",
                  "transition-[opacity,background-color,color] motion-hover hover:bg-wash hover:text-fg",
                  "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                  "group-hover:opacity-100",
                  // No hover on touch: keep the kebab visible on coarse pointers /
                  // narrow viewports so the menu stays reachable without right-click.
                  "pointer-coarse:opacity-100 max-[899px]:opacity-100",
                )}
              >
                <MoreVertical className="size-3.5" aria-hidden />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">{t("desktop:voice.audioOptions")}</TooltipContent>
          </Tooltip>
        )}
        {locallyMuted && (
          <VolumeX
            role="img"
            aria-label={t("desktop:voice.userMutedIndicator")}
            className="size-3.5 shrink-0 text-fg-faint"
          />
        )}
        {participant.cameraEnabled && (
          <Video
            role="img"
            aria-label={t("desktop:voice.cameraIndicator")}
            className="size-3.5 shrink-0 text-fg-muted"
          />
        )}
        {participant.screenSharing && (
          <LivePill label={t("desktop:stage.live")} srLabel={t("desktop:voice.sharingIndicator")} />
        )}
        {!participant.micEnabled && (
          <MicOff
            role="img"
            aria-label={t("desktop:voice.mutedIndicator")}
            className="size-3.5 shrink-0 text-danger"
          />
        )}
        {/* Deafened → headphone-off, next to the mic-muted icon. A deafened user
            is always mic-muted too, so both glyphs show (§11, LiveKit-attribute
            fed); the glyph, not the colour, tells the two apart. */}
        {participant.deafened && (
          <HeadphoneOff
            role="img"
            aria-label={t("desktop:voice.deafenedIndicator")}
            className="size-3.5 shrink-0 text-danger"
          />
        )}
      </li>
    </ParticipantVolumeMenu>
  );
});
