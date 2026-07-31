import { Image, type ImageStyle, type StyleProp } from "react-native";

/**
 * The Demli mark, at one of three FIXED steps mirroring the desktop surfaces:
 *   sm 40 — rail Home tile / panel headers (desktop GroupRail home entry),
 *   md 56 — auth screens (desktop AuthScreen `size-14`),
 *   lg 96 — splash-scale hero moments (desktop BootSplash).
 *
 * The size union is deliberate: free-px logos are how a brand drifts into five
 * subtly different marks per screen. Need a new size? Add a step here, next to
 * the desktop mapping, not a number at a call site.
 *
 * The asset is generated — `apps/mobile/assets/brand-mark.png` is declared in
 * assets/brand/brand-manifest.json and rendered by `pnpm gen:icons` from the
 * single master (assets/brand/logo.png); `pnpm test:brand` guards the drift.
 * Transparent background: the plate's own rounded corners do the rounding, so
 * no borderRadius/overflow cropping is needed (desktop demli-logo.svg pattern).
 */
const SIZES = { sm: 40, md: 56, lg: 96 } as const;

export type BrandMarkSize = keyof typeof SIZES;

// Metro resolves bundled assets ONLY through require() — the standard RN asset
// escape hatch, same as the sound sources in sounds/ringtone.ts.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const BRAND_MARK = require("../../assets/brand-mark.png") as number;

export function BrandMark({
  size = "md",
  style,
}: {
  size?: BrandMarkSize;
  /** Layout-only overrides (margins etc.) — never width/height. */
  style?: StyleProp<ImageStyle>;
}) {
  const px = SIZES[size];
  return (
    <Image
      source={BRAND_MARK}
      style={[{ width: px, height: px }, style]}
      accessibilityIgnoresInvertColors
      accessible={false}
    />
  );
}
