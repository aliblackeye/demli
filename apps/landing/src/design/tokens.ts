/**
 * Koyu Masa design system v1 — önerilen tokenlar (onay turu).
 * Entegrasyonda packages/app-ui/tokens.css'e iner; showcase bu sabitlerle
 * basılır. Kaynak: docs/design-system/demli-design-system.md
 */

export const T = {
  accent: "#ff8464",
  accentStrong: "#ffa48c",
  accentDeep: "#e8624a",
  accentSoft: "rgba(255,132,100,0.12)",
  glow: "rgba(255,132,100,0.24)",
  gold: "#eab30a",
  success: "#22c55e",
  danger: "#ff6fb5",
  dangerSoft: "rgba(255,111,181,0.12)",
} as const;

/** Konum değiştiren her şeyin yayı (landing'den ölçülü). */
export const SPRING = { type: "spring", damping: 60, stiffness: 500, mass: 1 } as const;
