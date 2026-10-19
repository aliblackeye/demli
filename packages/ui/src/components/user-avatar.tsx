import { useCallback, useState, type CSSProperties } from "react";
import type { PresencePlatform, PresenceStatus } from "@demli/types";
import { cn } from "../lib/cn";
import { PresenceBadge } from "./presence-badge";

/**
 * Size steps. Initials scale with the circle (≈ 40% of the diameter) so a
 * two-letter monogram reads the same at a 20px reaction avatar and a 128px
 * editor preview. `xl` / `2xl` are the identity sizes (settings preview,
 * crop editor, lightbox fallback); the four small steps are the everyday ones.
 */
const SIZE_CLASS = {
  xs: "size-5 text-3xs",
  sm: "size-8 text-2xs",
  md: "size-10 text-xs",
  lg: "size-20 text-2xl",
  xl: "size-24 text-3xl",
  "2xl": "size-32 text-5xl",
} as const;

/** Rendered diameter per size step, for the proportional presence dot. */
export const USER_AVATAR_PX = { xs: 20, sm: 32, md: 40, lg: 80, xl: 96, "2xl": 128 } as const;

export type UserAvatarSize = keyof typeof SIZE_CLASS;

/**
 * Deterministic, muted background color derived from a seed (user/group id).
 * Initials on it are pure white (`fg-display`): at 36% lightness that is
 * ≥ 4.6:1 for every hue, where the softer `fg` ink drops to 3.7:1 on the
 * yellow-greens. The UI-tones test sweeps all 360 hues.
 */
export function seedColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 30% 36%)`;
}

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.charAt(0) ?? "?";
  const second = words.length > 1 ? (words[words.length - 1]?.charAt(0) ?? "") : "";
  return (first + second).toUpperCase();
}

export interface UserAvatarProps {
  name: string;
  /** Stable color seed — defaults to the name. Pass a user id when available. */
  colorSeed?: string;
  /**
   * Avatar image URL (`user.avatarUrl`). When present and it loads, the photo
   * covers the initials; on a load error it falls back to the initials so a dead
   * URL never leaves an empty circle. `null` keeps the initials avatar.
   *
   * REQUIRED ON PURPOSE — deliberately not optional (`?`). While it was optional,
   * a caller that simply forgot it got a plausible-looking initials circle and no
   * error, so the omission was invisible: 20 of 35 call sites had silently lost the
   * user's real photo, including the voice room and every call surface (founder,
   * 2026-07-28: "sesli odada avatar gelmiyor"). Twice before, the same omission was
   * reported as a P0 and patched one site at a time, which never stopped the next one.
   *
   * TypeScript requires a non-optional property to be PRESENT even though
   * `undefined` is in its type, so forgetting it is now a compile error, while
   * `src={user?.avatarUrl}` on a possibly-missing record still passes cleanly.
   * A site with genuinely no avatar to show writes `src={null}` — a decision that
   * reads as one, not an oversight. Those sites are pinned by
   * `apps/desktop/src/renderer/src/components/avatar-src-coverage.test.ts`.
   */
  src: string | null | undefined;
  size?: UserAvatarSize;
  presence?: PresenceStatus;
  /** Client kind driving the presence badge (task #47) — "mobile" shows a phone. */
  presencePlatform?: PresencePlatform;
  /**
   * Translated accessible name for the presence dot ("Çevrimiçi"). Without it
   * the badge falls back to its built-in English label.
   */
  presenceLabel?: string;
  /** Coral speaking ring (voice): +2px of accent outside the base ring. */
  speaking?: boolean;
  /**
   * Koyu Masa draws every avatar with a 2px ring in the surface colour behind
   * it, which is what separates overlapping avatars and the presence dot from
   * the photo. Set the colour with the `--avatar-ring` custom property (default
   * `--color-app`) or turn it off for an avatar that sits alone on media.
   */
  ring?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function UserAvatar({
  name,
  colorSeed,
  src,
  size = "md",
  presence,
  presencePlatform,
  presenceLabel,
  speaking = false,
  ring = true,
  className,
  style,
}: UserAvatarProps): JSX.Element {
  // Track the exact URL that failed rather than a boolean, so a NEW `src` (e.g.
  // right after an upload) is retried instead of staying stuck on the fallback.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const showImage = src != null && src.length > 0 && failedSrc !== src;
  // A photo fades in over the initials once it has decoded, instead of popping
  // in half-painted. An image that is ALREADY decoded when it mounts (the
  // browser cache — every virtualized message row scrolling back into view)
  // is marked loaded synchronously by the ref, so it never replays the fade.
  const imageRef = useCallback(
    (node: HTMLImageElement | null) => {
      if (node && src && node.complete && node.naturalWidth > 0) setLoadedSrc(src);
    },
    [src],
  );

  const dot = Math.max(10, Math.round(USER_AVATAR_PX[size] * 0.3));

  return (
    <span className={cn("relative inline-flex shrink-0 select-none rounded-full", className)} style={style}>
      {/* rounded-full on the OUTER wrapper so a caller's ring/shadow (className) hugs
          the circle instead of squaring off (founder P0: "avatar kare çerçeve"). */}
      <span
        aria-hidden
        className={cn(
          "relative flex items-center justify-center overflow-hidden rounded-full font-semibold leading-none text-fg-display",
          "transition-shadow motion-hover",
          SIZE_CLASS[size],
          speaking
            ? "shadow-[0_0_0_2px_var(--avatar-ring,var(--color-app)),0_0_0_4px_var(--color-accent)]"
            : ring && "shadow-[0_0_0_2px_var(--avatar-ring,var(--color-app))]",
        )}
        style={{ backgroundColor: seedColor(colorSeed ?? name) }}
      >
        {/* Initials sit underneath as the load/fallback state; the photo (when it
            loads) covers them, clipped to the circle by overflow-hidden. */}
        {initialsOf(name)}
        {showImage && (
          <img
            ref={imageRef}
            src={src}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onLoad={() => setLoadedSrc(src)}
            onError={() => setFailedSrc(src)}
            className={cn(
              "absolute inset-0 size-full rounded-full object-cover transition-opacity motion-fast",
              loadedSrc === src ? "opacity-100" : "opacity-0",
            )}
          />
        )}
      </span>
      {presence && (
        <PresenceBadge
          status={presence}
          platform={presencePlatform}
          label={presenceLabel}
          size={dot}
          className="absolute -bottom-0.5 -right-0.5"
        />
      )}
    </span>
  );
}
