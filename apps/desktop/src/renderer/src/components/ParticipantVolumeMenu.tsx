/**
 * Per-user playback volume control (kişi-başı ses seviyesi).
 *
 * Wraps any participant surface (roster row, camera tile, avatar tile) so a
 * RIGHT-CLICK opens a context menu with a 0–100% volume slider + reset. The level
 * is a LISTENER-side, client-only offset — it scales that remote's own audio
 * playout, never the sender or SFU (no media over WebSocket, §10/§35). Engine-
 * owned (`voice-store.setParticipantVolume`), so it composes with deafen: while
 * deafened (a master mute) the slider is disabled and reads as inert.
 *
 * NEVER shown for the local user (you can't attenuate yourself). For a local
 * participant this renders `children` untouched, so callers can wrap every tile
 * unconditionally.
 *
 * The slider value is kept in fast LOCAL state so the thumb tracks the pointer
 * instantly, while each change is pushed to the engine (the source of truth, §11);
 * an external change (reset, another surface) re-syncs the local value.
 */

import { memo, useEffect, useRef, useState, type ReactElement } from "react";
import { RotateCcw, Volume1, Volume2, VolumeX } from "lucide-react";
import { ContextMenuItem, ContextMenuLabel, ContextMenuSeparator } from "@demli/ui";
import { ActionMenu } from "@demli/app-ui";
import {
  DEFAULT_PARTICIPANT_VOLUME,
  ELEMENT_PLAYBACK_MAX_VOLUME,
  isDefaultParticipantVolume,
  MIN_PARTICIPANT_VOLUME,
  type VoiceParticipant as VoiceParticipantData,
} from "@demli/media";
import type { ChannelId, GroupId } from "@demli/types";
import { useAppTranslation } from "../lib/i18n";
import { useVoiceStore } from "../stores/voice-store";
import { useChatStore } from "../stores/chat-store";
import { ParticipantActionItems } from "./ParticipantActionItems";

/**
 * 5% slider increments. The slider stops at 100%: remote voices play through
 * `<audio>` elements here, which cannot go louder (see ELEMENT_PLAYBACK_MAX_VOLUME).
 */
const VOLUME_STEP = 0.05;

export interface ParticipantVolumeMenuProps {
  participant: VoiceParticipantData;
  /**
   * The voice channel this participant is in (= the room we are connected to) and
   * its owning server — the context for the moderation actions. When either is
   * null the menu still shows volume + social, just no server-scoped moderation.
   */
  channelId?: ChannelId | null;
  groupId?: GroupId | null;
  /** Viewer is owner ∨ KICK_MEMBERS on this server — gates kick/ban/disconnect (§35). */
  canModerate?: boolean;
  /** This participant owns the server — never a moderation target. */
  isTargetOwner?: boolean;
  /** The single element the context menu attaches to (the row / tile). */
  children: ReactElement;
}

export const ParticipantVolumeMenu = memo(function ParticipantVolumeMenu({
  participant,
  channelId = null,
  groupId = null,
  canModerate = false,
  isTargetOwner = false,
  children,
}: ParticipantVolumeMenuProps): ReactElement {
  const { t } = useAppTranslation();
  const deafened = useVoiceStore((s) => s.deafened);
  const setParticipantVolume = useVoiceStore((s) => s.setParticipantVolume);
  const user = useChatStore((s) => s.users[participant.userId]);
  const name = user?.displayName ?? participant.identity;

  // Fast local mirror of the engine-owned level so the thumb never lags. Re-sync
  // whenever the authoritative value changes from elsewhere (reset, another tile)
  // — unless the user is mid-drag on THIS slider.
  const [value, setValue] = useState(participant.volume);
  const draggingRef = useRef(false);
  useEffect(() => {
    if (!draggingRef.current) setValue(participant.volume);
  }, [participant.volume]);

  // A remote muted to 0% has no menu badge here, but the tiles/rows show it.
  const percent = Math.round(value * 100);
  const VolumeIcon = value <= 0 ? VolumeX : value < 1 ? Volume1 : Volume2;
  const atDefault = isDefaultParticipantVolume(value);

  // The local user can't attenuate themselves — render the surface as-is.
  if (participant.isLocal) return children;

  const commit = (next: number): void => {
    setValue(next);
    setParticipantVolume(participant.userId, next);
  };

  return (
    <ActionMenu
      contentClassName="w-64"
      menu={
        <>
          <ContextMenuLabel className="truncate normal-case tracking-normal text-fg-muted">
            {name}
          </ContextMenuLabel>

          {/* Slider lives in a NON-item container: right-click stays open while
              dragging, and stopping keydown keeps arrow keys on the slider (not
              the menu's roving focus / typeahead). */}
          <div className="px-2 pb-2 pt-1" onKeyDown={(e) => e.stopPropagation()}>
          <div className="mb-1.5 flex items-center justify-between text-2xs text-fg-muted">
            <span>{t("desktop:voice.userVolume")}</span>
            <span className="font-medium tabular-nums text-fg">{percent}%</span>
          </div>
          <div className="flex items-center gap-2">
            <VolumeIcon className="size-3.5 shrink-0 text-fg-faint" aria-hidden />
            <input
              type="range"
              min={MIN_PARTICIPANT_VOLUME}
              max={ELEMENT_PLAYBACK_MAX_VOLUME}
              step={VOLUME_STEP}
              value={value}
              disabled={deafened}
              aria-label={t("desktop:voice.userVolumeFor", { name })}
              aria-valuetext={`${percent}%`}
              onPointerDown={() => (draggingRef.current = true)}
              onPointerUp={() => (draggingRef.current = false)}
              onChange={(e) => commit(e.currentTarget.valueAsNumber)}
              className="h-1.5 flex-1 cursor-pointer accent-accent disabled:cursor-not-allowed disabled:opacity-40"
            />
          </div>
          {deafened && (
            <p className="mt-1.5 text-badge leading-snug text-fg-faint">
              {t("desktop:voice.userVolumeDeafened")}
            </p>
          )}
        </div>

        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={deafened || atDefault}
          onSelect={() => commit(DEFAULT_PARTICIPANT_VOLUME)}
        >
          <RotateCcw className="size-3.5" aria-hidden />
          {t("desktop:voice.resetVolume")}
        </ContextMenuItem>

        {/* Social + moderation for this participant (§35 gate is inside). Always
            non-null here — the local user returns early above. */}
        <ContextMenuSeparator />
          <ParticipantActionItems
            userId={participant.userId}
            groupId={groupId}
            channelId={channelId}
            isSelf={participant.isLocal}
            isTargetOwner={isTargetOwner}
            canModerate={canModerate}
            inVoice
          />
        </>
      }
    >
      {children}
    </ActionMenu>
  );
});
