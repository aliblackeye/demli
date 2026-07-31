/**
 * Profile banner helpers (M15). A user may upload a banner image (photo or GIF);
 * when they have not, the card/settings header shows a warm, per-user diagonal
 * wash derived from the SAME seed the avatar uses — so the banner and avatar never
 * drift apart (single source: {@link seedColor}). The wash mixes toward the app
 * base (#1a0806) so it always reads as "Demli" rather than a flat colour block.
 *
 * Single source for BOTH the profile card ({@link ProfileCard}) and the unified
 * account settings panel ({@link ProfileSettings}).
 */

import type { CSSProperties } from "react";
import { seedColor } from "@demli/ui";
import type { User } from "@demli/types";

/** Inline style for the banner gradient fallback (no uploaded image). */
export function bannerGradient(seed: string): CSSProperties {
  const base = seedColor(seed);
  return {
    backgroundImage: `linear-gradient(135deg, ${base} 0%, color-mix(in oklab, ${base} 52%, #1a0806) 100%)`,
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
