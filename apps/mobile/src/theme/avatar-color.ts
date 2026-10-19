/**
 * Deterministic per-user tile color for a CAMERALESS participant tile — the
 * colored/gradient backdrop behind the big centered avatar in the voice video
 * grid (the "camera off" tile look). Same user → same color, every time,
 * on every device.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * SHARED CONTRACT WITH THE DESKTOP RENDERER — copy this algorithm VERBATIM.
 *
 * The desktop voice grid must produce the IDENTICAL color for a given `userId`
 * so a person looks the same on phone and desktop. The algorithm is intentionally
 * trivial (no crypto, no float drift) so both platforms agree bit-for-bit.
 *
 *   1. hue = avatarHue(userId):
 *        let hash = 0
 *        for each UTF-16 code unit c of userId, in order:
 *          hash = (hash * 31 + c) | 0          // 32-bit signed wrap (Java String.hashCode style)
 *        hue = ((hash % 360) + 360) % 360       // integer in [0, 360), always non-negative
 *
 *   2. gradient stops (both are CSS/RN `hsl()` strings — RN, react-native-svg AND
 *      the browser all parse `hsl()` identically):
 *        from (top)    = hsl(hue,                       SAT_TOP%,    LIGHT_TOP%)
 *        to   (bottom) = hsl((hue + HUE_SHIFT) % 360,   SAT_BOTTOM%, LIGHT_BOTTOM%)
 *
 *   3. solid fallback  = hsl(hue, SAT_SOLID%, LIGHT_SOLID%)
 *
 *      Tunables (keep in sync across platforms):
 *        SAT_TOP = 55, LIGHT_TOP = 30
 *        HUE_SHIFT = 16, SAT_BOTTOM = 60, LIGHT_BOTTOM = 18
 *        SAT_SOLID = 55, LIGHT_SOLID = 24
 *
 * The values are deliberately mid-saturation and DARK (lightness 18–30%) so the
 * dark-first shell (CLAUDE.md §7) stays calm — never a neon gamer toy — and white
 * avatar initials/photo read cleanly on top. Do not brighten without agreeing the
 * change on both platforms.
 * ────────────────────────────────────────────────────────────────────────────
 */

// Gradient/solid tunables — see the contract above. Kept as named constants so
// the desktop port can diff them 1:1.
const SAT_TOP = 55;
const LIGHT_TOP = 30;
const HUE_SHIFT = 16;
const SAT_BOTTOM = 60;
const LIGHT_BOTTOM = 18;
const SAT_SOLID = 55;
const LIGHT_SOLID = 24;

/**
 * Map a `userId` (any stable string identity) to a hue in [0, 360). Pure integer
 * math with a 32-bit signed wrap so it is reproducible on every JS engine and
 * trivially portable to the desktop renderer (see the file contract).
 */
export function avatarHue(userId: string): number {
  let hash = 0;
  for (let i = 0; i < userId.length; i += 1) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  return ((hash % 360) + 360) % 360;
}

/** The two-stop vertical gradient (top → bottom) for a cameraless tile backdrop. */
export function avatarTileGradient(userId: string): { from: string; to: string } {
  const hue = avatarHue(userId);
  return {
    from: `hsl(${hue}, ${SAT_TOP}%, ${LIGHT_TOP}%)`,
    to: `hsl(${(hue + HUE_SHIFT) % 360}, ${SAT_BOTTOM}%, ${LIGHT_BOTTOM}%)`,
  };
}

/** Flat single-color fallback (same hue) — used where a gradient is overkill. */
export function avatarTileSolid(userId: string): string {
  return `hsl(${avatarHue(userId)}, ${SAT_SOLID}%, ${LIGHT_SOLID}%)`;
}

// Identity-glow tunables — the desktop stage tile's blurred disc
// (`AvatarTile`: `hsl(hue 60% 50%)` at 16% opacity behind the avatar). The colour
// is the person's HUE, never the surface: Koyu Masa keeps the tile itself on the
// neutral `surface` and lets identity show only as this faint light.
const SAT_GLOW = 60;
const LIGHT_GLOW = 50;
/** Peak opacity of the glow at its centre (desktop `opacity-[0.16]`). */
export const AVATAR_GLOW_OPACITY = 0.16;

/**
 * The identity-glow colour for a cameraless stage tile: the user's hue at a
 * mid lightness, drawn at {@link AVATAR_GLOW_OPACITY} over the neutral tile
 * surface. Same hue as {@link avatarHue}, so phone and desktop agree.
 */
export function avatarTileGlow(userId: string): string {
  return `hsl(${avatarHue(userId)}, ${SAT_GLOW}%, ${LIGHT_GLOW}%)`;
}
