/**
 * Colour maths for checking the design tokens — WCAG contrast, alpha
 * compositing, hue distance and colour-vision-deficiency simulation.
 *
 * Used by the token tests (so a palette edit that breaks readability fails the
 * build) and by the UI-kit review page (so the founder sees the measured ratio
 * next to every swatch instead of trusting a claim). Pure: no DOM, no React.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * Parse `#rgb`, `#rrggbb`, `rgba(r, g, b, a)`, `rgb(r g b / a)` — the forms the
 * token files use — and `hsl(h s% l%)` / `hsla(h, s%, l%, a)`, the form the
 * avatar seed colours use. Throws on anything else so a typo cannot pass as black.
 */
export function parseColor(input: string): Rgba {
  const value = input.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(value);
  if (hex) {
    const digits = hex[1] as string;
    const full =
      digits.length === 3
        ? digits
            .split("")
            .map((d) => d + d)
            .join("")
        : digits;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
      a: 1,
    };
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(value);
  if (fn) {
    const parts = (fn[1] as string)
      .replace("/", " ")
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    if (parts.length >= 3 && parts.every((n) => Number.isFinite(n))) {
      const [r, g, b, a = 1] = parts as [number, number, number, number?];
      return { r, g, b, a };
    }
  }
  const hsl = /^hsla?\(([^)]+)\)$/.exec(value);
  if (hsl) {
    const parts = (hsl[1] as string)
      .replace("/", " ")
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((part) => Number.parseFloat(part));
    if (parts.length >= 3 && parts.every((n) => Number.isFinite(n))) {
      const [h, s, l, a = 1] = parts as [number, number, number, number?];
      return { ...hslToRgb(h, s / 100, l / 100), a };
    }
  }
  throw new Error(`unsupported colour: ${input}`);
}

function hslToRgb(h: number, s: number, l: number): Omit<Rgba, "a"> {
  const k = (n: number): number => (n + h / 30) % 12;
  const chroma = s * Math.min(l, 1 - l);
  const channel = (n: number): number =>
    Math.round(255 * (l - chroma * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return { r: channel(0), g: channel(8), b: channel(4) };
}

/** Flatten a translucent colour onto an opaque backdrop (source-over). */
export function composite(top: Rgba, backdrop: Rgba): Rgba {
  const a = top.a;
  return {
    r: Math.round(top.r * a + backdrop.r * (1 - a)),
    g: Math.round(top.g * a + backdrop.g * (1 - a)),
    b: Math.round(top.b * a + backdrop.b * (1 - a)),
    a: 1,
  };
}

function toLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function fromLinear(value: number): number {
  const c = Math.min(1, Math.max(0, value));
  return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
}

/** WCAG 2.x relative luminance of an opaque colour. */
export function luminance({ r, g, b }: Rgba): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/**
 * WCAG contrast ratio. A translucent foreground is composited onto the
 * background first, which is what the eye actually sees.
 */
export function contrastRatio(foreground: string, background: string): number {
  const bg = parseColor(background);
  if (bg.a < 1) throw new Error(`background must be opaque: ${background}`);
  const fg = composite(parseColor(foreground), bg);
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** HSL hue in degrees (0–360). */
export function hue(color: string): number {
  const { r, g, b } = parseColor(color);
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  if (d === 0) return 0;
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return (h * 60 + 360) % 360;
}

/** Shortest angular distance between two hues. */
export function hueDistance(a: string, b: string): number {
  const d = Math.abs(hue(a) - hue(b));
  return Math.min(d, 360 - d);
}

export type VisionType = "normal" | "protan" | "deutan" | "tritan";

/** Machado, Oliveira & Fernandes (2009), severity 1.0, in linear RGB. */
const CVD_MATRICES: Record<VisionType, readonly (readonly [number, number, number])[]> = {
  normal: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritan: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

/** How an opaque colour appears to a viewer with the given colour vision. */
export function simulateVision(color: string, vision: VisionType): Rgba {
  const { r, g, b } = parseColor(color);
  const lin = [toLinear(r), toLinear(g), toLinear(b)] as const;
  const [m0, m1, m2] = CVD_MATRICES[vision] as [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
  ];
  const row = (m: readonly [number, number, number]): number =>
    m[0] * lin[0] + m[1] * lin[1] + m[2] * lin[2];
  return { r: fromLinear(row(m0)), g: fromLinear(row(m1)), b: fromLinear(row(m2)), a: 1 };
}

function toLab({ r, g, b }: Rgba): [number, number, number] {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const x = (0.4124 * lr + 0.3576 * lg + 0.1805 * lb) / 0.95047;
  const y = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
  const z = (0.0193 * lr + 0.1192 * lg + 0.9505 * lb) / 1.08883;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIEDE2000 colour difference. ~2 is "just noticeable", 20+ is "clearly different". */
export function deltaE2000(first: Rgba, second: Rgba): number {
  const [l1, a1, b1] = toLab(first);
  const [l2, a2, b2] = toLab(second);
  const rad = Math.PI / 180;
  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const cMean = (c1 + c2) / 2;
  const g = 0.5 * (1 - Math.sqrt(cMean ** 7 / (cMean ** 7 + 25 ** 7)));
  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1p = Math.hypot(a1p, b1);
  const c2p = Math.hypot(a2p, b2);
  const angle = (x: number, y: number): number => {
    if (x === 0 && y === 0) return 0;
    const t = Math.atan2(y, x) / rad;
    return t < 0 ? t + 360 : t;
  };
  const h1p = angle(a1p, b1);
  const h2p = angle(a2p, b2);
  const dLp = l2 - l1;
  const dCp = c2p - c1p;
  let dhp = h2p - h1p;
  if (c1p * c2p === 0) dhp = 0;
  else if (dhp > 180) dhp -= 360;
  else if (dhp < -180) dhp += 360;
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin((dhp * rad) / 2);
  const lMean = (l1 + l2) / 2;
  const cMeanP = (c1p + c2p) / 2;
  let hMean = h1p + h2p;
  if (c1p * c2p !== 0) {
    hMean = Math.abs(h1p - h2p) > 180 ? (h1p + h2p + 360) / 2 : (h1p + h2p) / 2;
    if (hMean >= 360) hMean -= 360;
  }
  const t =
    1 -
    0.17 * Math.cos((hMean - 30) * rad) +
    0.24 * Math.cos(2 * hMean * rad) +
    0.32 * Math.cos((3 * hMean + 6) * rad) -
    0.2 * Math.cos((4 * hMean - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hMean - 275) / 25) ** 2));
  const rc = 2 * Math.sqrt(cMeanP ** 7 / (cMeanP ** 7 + 25 ** 7));
  const sl = 1 + (0.015 * (lMean - 50) ** 2) / Math.sqrt(20 + (lMean - 50) ** 2);
  const sc = 1 + 0.045 * cMeanP;
  const sh = 1 + 0.015 * cMeanP * t;
  const rt = -Math.sin(2 * dTheta * rad) * rc;
  return Math.sqrt(
    (dLp / sl) ** 2 + (dCp / sc) ** 2 + (dHp / sh) ** 2 + rt * (dCp / sc) * (dHp / sh),
  );
}

/** ΔE2000 between two colours as seen with the given colour vision. */
export function visionDistance(a: string, b: string, vision: VisionType): number {
  return deltaE2000(simulateVision(a, vision), simulateVision(b, vision));
}
