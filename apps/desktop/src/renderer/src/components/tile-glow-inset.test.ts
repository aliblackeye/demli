/**
 * A speaking/active tile's glow is drawn INSIDE the tile, never outside it.
 *
 * The tiles live in scroll containers — the voice grid (`overflow-y-auto` once
 * the participants stop fitting) and the camera/Watch-Party panel. A box that
 * scrolls has to clip, and CSS will not let it clip on one axis only: setting
 * `overflow-y: auto` computes `overflow-x` to `auto` as well, so the container
 * clips on all four sides.
 *
 * So an OUTSET glow gets sheared off — flat along the grid's top edge and down
 * the outermost columns, which is exactly what the founder photographed
 * (2026-07-28: "kenarlıklar sıkıntı oluyor watch partyde falan griddeyken
 * gradyanlı parlayan borderlar kırpılıyor").
 *
 * Padding the container does not fix it: padding is INSIDE the scrollport, so
 * tiles scroll into it and bleed over the toolbar instead of being cut. Drawing
 * the glow inside the border box is the only version with nothing left to clip,
 * and it holds at every tile count, container and window width.
 *
 * The near-black elevation drop stays outset on purpose — it is what stops the
 * tiles looking pasted onto the stage, and clipping a black shadow against a
 * black stage is imperceptible. So this test does not ban outset shadows; it
 * bans outset COLOUR: the accent and online rings/halos that are the actual
 * "parlayan border".
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Every tile that renders inside the stage grid or the scrollable panel. */
const TILES = [
  "AvatarTile.tsx",
  "CameraTile.tsx",
  "LocalCameraTile.tsx",
  "ScreenShareTile.tsx",
] as const;

/** The colour tokens that make up the visible glow (vs. the black drop shadow). */
const GLOW_TOKENS = ["--color-accent", "--color-online", "--color-stroke-strong"];

function sourceOf(file: string): string {
  return readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), "utf8");
}

/** Every `shadow-[…]` arbitrary value in the file, split into its comma layers. */
function shadowLayers(source: string): string[] {
  const layers: string[] = [];
  for (const m of source.matchAll(/shadow-\[([^\]]+)\]/g)) {
    layers.push(...(m[1] ?? "").split(",").map((l) => l.trim()));
  }
  return layers;
}

describe("tile glow is inset so a scroll container cannot clip it", () => {
  it.each(TILES)("%s draws no OUTSET coloured shadow", (file) => {
    const offenders = shadowLayers(sourceOf(file)).filter(
      (layer) => GLOW_TOKENS.some((t) => layer.includes(t)) && !layer.startsWith("inset"),
    );
    expect(
      offenders,
      "these shadow layers paint colour outside the tile, where a scrolling " +
        "container clips them — prefix each with `inset_`",
    ).toEqual([]);
  });

  it.each(TILES)("%s pairs every ring with ring-inset", (file) => {
    const source = sourceOf(file);
    // Tailwind's ring utilities are outset by default; `ring-inset` flips them.
    // Check per class-string so a ring in one state cannot borrow another's inset.
    const offenders: string[] = [];
    for (const m of source.matchAll(/"([^"]*\bring-\d[^"]*)"/g)) {
      const cls = m[1] ?? "";
      // A bare `focus-visible:ring-2` is inset via `focus-visible:ring-inset`,
      // so compare within the same variant prefix.
      for (const ring of cls.matchAll(/(?:([a-z-]+):)?ring-\d/g)) {
        const variant = ring[1] ? `${ring[1]}:` : "";
        if (!cls.includes(`${variant}ring-inset`)) offenders.push(`${file}: ${cls}`);
      }
    }
    expect(offenders, "an outset ring is clipped on the grid's edge tiles").toEqual([]);
  });

  it("AvatarTile still glows when speaking (the fix did not delete the signal)", () => {
    // Guards the opposite failure: satisfying the rules above by removing the
    // glow altogether would leave a voice room with no speaking indicator.
    const source = sourceOf("AvatarTile.tsx");
    expect(source).toMatch(/inset_0_0_0_2px_var\(--color-accent\)/);
    expect(source).toMatch(/inset_0_0_\d+px_-?\d+px_var\(--color-accent\)/);
  });

  it("keeps a ring-offset off the tiles", () => {
    // `ring-offset-*` pushes the ring FURTHER outside the border box, so it
    // reintroduces exactly the clipping this file exists to prevent.
    for (const file of TILES) {
      expect(sourceOf(file), `${file} must not use ring-offset`).not.toMatch(/ring-offset-/);
    }
  });
});
