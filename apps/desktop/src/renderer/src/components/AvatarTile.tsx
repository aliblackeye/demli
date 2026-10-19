/**
 * A cameraless participant tile for the video stage. Camera-on and camera-off
 * participants are EQUAL tiles in the grid; this is the camera-off half:
 *
 *  - a neutral surface-tone base (Koyu Masa: depth by tone, no gradient ramp),
 *  - a faint identity-hued glow disc blurred behind the avatar, so a person
 *    keeps one colour across desktop and phone (lib/video-stage `tileHue`, the
 *    same seed the mobile renderer uses), and
 *  - a large avatar circle with Onest (`font-display`) initials.
 *
 * Speaking is the ONE warm light on the stage: a coral ring + soft coral inner
 * glow over the whole tile that fades in and out with the voice, and a breathing
 * coral ring around the avatar. The focused/stage tile (`large`) wears the
 * "ODAKTA" veil pill top-right. No cropping, no video — just identity.
 *
 * Memoized on the `participant` object: the voice store keeps each participant
 * row referentially stable across no-op speaking ticks, so only the tile whose
 * participant actually changed (started/stopped speaking, muted, …) re-renders —
 * the rest of the grid is untouched (CLAUDE.md §27).
 */

import {
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from "react";
import { UserAvatar, badgeVariants, cn } from "@demli/ui";
import type { VoiceParticipant } from "@demli/media";
import { useAppTranslation } from "../lib/i18n";
import { tileHue } from "../lib/video-stage";
import { useChatStore } from "../stores/chat-store";
import { useAuthStore } from "../stores/auth-store";
import { VideoTileLabel } from "./VideoTileLabel";
import { ParticipantVolumeMenu } from "./ParticipantVolumeMenu";

export interface AvatarTileProps {
  participant: VoiceParticipant;
  className?: string;
  /** When provided the tile becomes clickable (promote to / exit the stage). */
  onSelect?: () => void;
  /** Highlight this tile as the current stage item (ODAKTA pill). */
  active?: boolean;
  /** Larger avatar for the focused/stage view — also flags the tile as focused. */
  large?: boolean;
}

/**
 * The speaking light, drawn as an overlay ABOVE the tile's content.
 *
 * Every layer is `inset`, and that is load-bearing rather than a style
 * preference: these tiles live in scroll containers, and a box that scrolls has
 * to clip — `overflow-y:auto` forces `overflow-x` to `auto` too, so it clips on
 * all four sides. An outset glow got sheared off along the grid's top edge and
 * down the outermost columns (founder: "gradyanlı parlayan borderlar
 * kırpılıyor"). Drawing it inside the border box leaves nothing to clip, in any
 * container, at any tile count (tile-glow-inset.test.ts).
 *
 * An overlay rather than the tile's own box-shadow because an inset shadow
 * paints UNDER the tile's children — on a camera tile the video would cover it.
 * Opacity is what animates, so the light fades rather than blinks (200ms).
 */
export const SPEAKING_GLOW =
  "shadow-[inset_0_0_0_2px_var(--color-accent),inset_0_0_36px_-8px_var(--color-accent)]";

export function SpeakingGlow({ on }: { on: boolean }): JSX.Element {
  return (
    <span
      aria-hidden
      data-testid="speaking-glow"
      data-on={on || undefined}
      className={cn(
        "pointer-events-none absolute inset-0 z-[5] rounded-[inherit] transition-opacity motion-hover",
        SPEAKING_GLOW,
        on ? "opacity-100" : "opacity-0",
      )}
    />
  );
}

export const AvatarTile = memo(function AvatarTile({
  participant,
  className,
  onSelect,
  active = false,
  large = false,
}: AvatarTileProps): JSX.Element {
  const { t } = useAppTranslation();
  const user = useChatStore((s) => s.users[participant.userId]);
  const me = useAuthStore((s) => s.user);
  const name =
    user?.displayName ??
    (participant.isLocal ? (me?.displayName ?? t("desktop:voice.you")) : participant.identity);
  // Same resolution order as the name: the shared directory first, then — for our
  // own tile, which the directory does not always carry — the auth store.
  const avatarUrl = user?.avatarUrl ?? (participant.isLocal ? (me?.avatarUrl ?? null) : null);
  const interactive = Boolean(onSelect);
  const hue = tileHue(participant.userId);
  // "Focused" for the ODAKTA pill: the promoted stage tile (large) or an
  // explicitly-marked active tile. Never for a plain grid tile.
  const focused = large || active;

  const tile: ReactElement = (
    <div
      {...(interactive
        ? {
            role: "button",
            tabIndex: 0,
            "aria-label": name,
            onClick: onSelect,
            onKeyDown: (e: ReactKeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect?.();
              }
            },
          }
        : {})}
      data-testid="avatar-tile"
      data-speaking={participant.speaking || undefined}
      className={cn(
        // Entrance is orchestrated by the VideoStage grid wrapper (framer stagger)
        // so tiles resolve in sequence; the speaking ring below stays CSS (§27).
        "group/tile relative flex items-center justify-center overflow-hidden rounded-xl bg-surface",
        "[--avatar-ring:var(--color-surface)]",
        interactive &&
          // Hover is a tone change (surface → raised, 200ms); nothing lifts.
          "cursor-pointer outline-none transition-colors motion-hover hover:bg-raised hover:[--avatar-ring:var(--color-raised)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
        className,
      )}
    >
      {/* Identity glow — a soft, blurred disc behind the avatar, hued off the
          same seed as mobile so the tile carries the person's colour. Data, not
          palette: the hue is derived per user, like UserAvatar's seed colour. */}
      <span
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 aspect-square w-[46%] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-[0.16] blur-[60px]"
        style={{ backgroundColor: `hsl(${hue} 60% 50%)` }}
      />

      {/* Avatar + speaking ring. The wrapper scales for the large stage so the
          ring and circle grow together (transform only). */}
      <div className={cn("relative transition-transform motion-standard", large && "scale-[1.6]")}>
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute -inset-1.5 rounded-full border-2 border-accent transition-opacity motion-hover",
            participant.speaking
              ? "animate-pulse-ring opacity-100 motion-reduce:animate-none"
              : "opacity-0",
          )}
        />
        <UserAvatar
          name={name}
          colorSeed={participant.userId}
          src={avatarUrl}
          size="lg"
          speaking={false}
          className="relative font-display"
        />
      </div>

      <VideoTileLabel
        name={name}
        muted={!participant.micEnabled}
        deafened={participant.deafened}
        screenSharing={participant.screenSharing}
      />

      {/* Focused/stage marker — a quiet veil pill with a coral dot, not a second
          coral fill competing with the speaking light. */}
      {focused && (
        <span
          className={cn(
            badgeVariants({ variant: "veil" }),
            "absolute right-3 top-3 z-10 gap-1.5 bg-scrim font-display text-badge font-semibold tracking-wide text-fg-display",
          )}
        >
          <span aria-hidden className="size-1.5 rounded-full bg-accent" />
          {t("desktop:stage.focused")}
        </span>
      )}

      <SpeakingGlow on={participant.speaking} />
    </div>
  );

  // Right-click for the per-user volume control (the menu renders the bare tile
  // for the local user — you can't attenuate yourself).
  return <ParticipantVolumeMenu participant={participant}>{tile}</ParticipantVolumeMenu>;
});
