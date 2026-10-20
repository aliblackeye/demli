/**
 * Profile banner helpers (M15, re-toned for Koyu Masa in M16). A user may upload
 * a banner image (photo or GIF); when they have not, the card/settings header
 * shows a per-user wash derived from the SAME seed the avatar uses — so the
 * banner and the initials avatar never drift apart (single source:
 * {@link seedColor}).
 *
 * Koyu Masa: the wash is the user's hue sunk into the neutral base (no warm
 * `#1a0806` floor any more — the warm ramp is retired), with ONE coral glow in
 * the top-left corner — the design system's "single warm light on black"
 * (demli-design-system §6), the same light the landing hero carries. Every
 * colour here is a token or the seeded hue; no literal hex.
 *
 * Single source for the profile card ({@link ProfileCard}), its live preview in
 * the account settings ({@link ProfileSettings}) and the crop editor preview.
 */

import type { CSSProperties } from "react";
import { seedColor } from "@demli/ui";
import type { User } from "@demli/types";

/** Inline style for the banner fallback (no uploaded image). */
export function bannerGradient(seed: string): CSSProperties {
  const base = seedColor(seed);
  return {
    backgroundColor: "var(--color-app)",
    backgroundImage: [
      // The warm light: a soft coral glow anchored top-left.
      "radial-gradient(120% 140% at 0% 0%, var(--color-accent-glow) 0%, transparent 55%)",
      // The person: their seeded hue, fading into the neutral base.
      `linear-gradient(135deg, color-mix(in oklab, ${base} 78%, var(--color-app)) 0%, color-mix(in oklab, ${base} 30%, var(--color-app)) 100%)`,
    ].join(", "),
  };
}

/**
 * The banner / adult fields the server adds to the user record (M15). Kept as a
 * local structural extension rather than editing the shared {@link User} type
 * (owned by the protocol/backend track): this compiles today against the current
 * `User` and stays correct once the backend lands the fields on the type. Read
 * `bannerUrl` through {@link userBannerUrl} so every call site shares one cast.
 */
export type UserWithBanner = User & {
  /** Public URL of the uploaded profile banner, or null when unset. */
  bannerUrl?: string | null;
  /** Whether the account holder is 18+ (derived from `birthdate`), for content gating. */
  isAdult?: boolean;
};

/** The user's uploaded banner URL, or null. One shared cast for every call site. */
export function userBannerUrl(user: User | null | undefined): string | null {
  return (user as UserWithBanner | null | undefined)?.bannerUrl ?? null;
}
