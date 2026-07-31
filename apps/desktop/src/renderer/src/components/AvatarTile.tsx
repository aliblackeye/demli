/**
 * A cameraless participant tile for the video stage — the hero of the "Demli
 * Voice v2" look (founder design). Camera-on and camera-off participants are
 * EQUAL tiles in the grid; this is the camera-off half:
 *
 *  - a warm, near-black RADIAL gradient base (the app's warm ramp tokens), with
 *  - a soft, identity-hued GLOW disc blurred behind the avatar, and
 *  - a large avatar circle with Space Grotesk (`font-display`) initials.
 *
 * Speaking is signalled the Demli way: a pulsing ACCENT ring around the avatar
 * plus an accent box-shadow halo on the whole tile (not the old green ring). The
 * focused/stage tile (`large`) wears an "ODAKTA" badge top-right. No cropping, no
 * video — just identity.
 *
 * The glow + avatar hue are derived from the same seed (user id) as the mobile
 * renderer (see lib/video-stage `tileHue`), so a person reads as one identity
 * colour across desktop and phone.
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
import { UserAvatar, cn } from "@demli/ui";
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
  /** Highlight this tile as the current stage item (accent ring + ODAKTA badge). */
  active?: boolean;
  /** Larger avatar for the focused/stage view — also flags the tile as focused. */
  large?: boolean;
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
  // "Focused" for the ODAKTA badge / accent framing: the promoted stage tile
  // (large) or an explicitly-marked active tile. Never for a plain grid tile.
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
      // Per-identity warm radial base (Demli Voice v2 .dc.html): each tile carries
      // the person's hue as a deep radial, darkening to the rail floor — not a flat
      // neutral ramp. hsl() + the glow disc below read as one identity colour.
      style={{
        backgroundImage: `radial-gradient(120% 95% at 30% 12%, hsl(${hue} 55% 13%) 0%, hsl(${hue} 48% 8%) 55%, var(--color-rail) 100%)`,
      }}
      className={cn(
        // Entrance is orchestrated by the VideoStage grid wrapper (framer stagger)
        // so tiles resolve in sequence; keeping a CSS `animate-fade-up` here too
        // would double the entrance. The speaking pulse-ring below stays CSS (§27).
        "group/tile relative flex items-center justify-center overflow-hidden rounded-2xl",
        // Elevation + edge as a composable box-shadow. Idle: a cream hairline.
        // Speaking: an accent ring + a soft accent glow. Focused-but-quiet: a
        // steady accent ring.
        //
        // Every ACCENT layer is `inset`, and that is load-bearing rather than a
        // style preference. These tiles live in scroll containers, and a box that
        // scrolls has to clip: `overflow-y:auto` forces `overflow-x` to `auto`
        // too, so it clips on all four sides. An outset glow therefore got sheared
        // off along the grid's top edge and down the outermost columns (founder:
        // "gradyanlı parlayan borderlar kırpılıyor"). Padding the container cannot
        // fix it either — padding is inside the scrollport, so tiles would just
        // scroll into it and bleed over the toolbar instead.
        //
        // Drawing the glow INSIDE the tile removes the problem rather than
        // budgeting for it: there is nothing outside the border box left to clip,
        // in any container, at any tile count. The one shadow that stays outset is
        // the black elevation drop — it is invisible against the dark stage even
        // when clipped, and it is what keeps the tile from looking pasted on.
        "shadow-[inset_0_0_0_1px_var(--color-stroke-strong),0_14px_40px_-18px_rgba(0,0,0,0.9)]",
        focused &&
          !participant.speaking &&
          "shadow-[inset_0_0_0_2px_var(--color-accent),0_14px_40px_-18px_rgba(0,0,0,0.9)]",
        participant.speaking &&
          "shadow-[inset_0_0_0_2px_var(--color-accent),inset_0_0_38px_-6px_var(--color-accent),0_16px_40px_-18px_rgba(0,0,0,0.9)]",
        interactive &&
          "cursor-pointer outline-none transition motion-standard hover:brightness-110 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
        className,
      )}
    >
      {/* Identity glow — a soft, blurred disc behind the avatar, hued off the
          same seed as mobile so the tile carries the person's colour. */}
      <span
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 aspect-square w-[46%] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-25 blur-[60px]"
        style={{ backgroundColor: `hsl(${hue} 72% 52%)` }}
      />

      {/* Avatar + speaking pulse ring. The wrapper scales for the large stage so
          the ring and circle grow together. UserAvatar draws the identity circle
          and initials (font-display via className); its own green speaking ring is
          suppressed — the accent pulse ring below is the Demli signal. */}
      <div className={cn("relative transition-transform motion-standard", large && "scale-[1.6]")}>
        {participant.speaking && (
          <span
            aria-hidden
            className="pointer-events-none absolute -inset-1.5 animate-pulse-ring rounded-full border-2 border-accent"
          />
        )}
        <UserAvatar
          name={name}
          colorSeed={participant.userId}
          src={avatarUrl}
          size="lg"
          speaking={false}
          className="relative rounded-full font-display shadow-[inset_0_0_0_2px_rgba(248,238,212,0.18),0_10px_30px_-10px_rgba(0,0,0,0.6)]"
        />
      </div>

      <VideoTileLabel
        name={name}
        muted={!participant.micEnabled}
        deafened={participant.deafened}
        screenSharing={participant.screenSharing}
      />

      {/* Focused/stage badge — the Demli "ODAKTA" pill (accent fill, dark ink). */}
      {focused && (
        <span className="absolute right-3 top-3 z-10 rounded-full bg-accent px-2.5 py-1 font-display text-badge font-bold tracking-wide text-on-accent">
          {t("desktop:stage.focused")}
        </span>
      )}
    </div>
  );

  // Right-click for the per-user volume control (the menu renders the bare tile
  // for the local user — you can't attenuate yourself).
  return <ParticipantVolumeMenu participant={participant}>{tile}</ParticipantVolumeMenu>;
});
