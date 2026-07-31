/**
 * emoji-mart picker body (M17 → package migration).
 *
 * The heavy part of the emoji experience — the emoji-mart engine plus its
 * ~430 KB unicode dataset — lives HERE and nowhere else, so it can be code-split
 * behind {@link ./EmojiPicker.EmojiPicker}'s `React.lazy` boundary: the main
 * renderer bundle carries none of it, and the chunk (engine + data + the tiny
 * Turkish i18n) is fetched only the first time a user opens an emoji surface (§27,
 * "split heavy features lazily").
 *
 * Behaviour preserved from the hand-written picker it replaces:
 *  - selecting a unicode emoji inserts its glyph (skin tone already applied);
 *  - selecting a server custom emoji inserts its `:name:` shortcode, which the
 *    message renderer resolves back into an image — so what travels the wire
 *    stays plain text (§28);
 *  - skin-tone choice + "frequently used" persist across sessions (emoji-mart
 *    writes them to localStorage on its own).
 *
 * Theme: emoji-mart is skinned to "Demli Voice v2" purely through its documented
 * CSS custom properties (no forked CSS). The `--rgb-*` triplets and border tokens
 * below ARE the desktop `@theme` palette values (globals.css) — CSS custom
 * properties inherit through emoji-mart's shadow DOM, so setting them on the host
 * wrapper repaints the whole picker with the app's accent / surface / text / edge.
 */
import Picker from "@emoji-mart/react";
import data from "@emoji-mart/data";
import trI18n from "@emoji-mart/data/i18n/tr.json";
import type { CSSProperties } from "react";

/** One server custom emoji, in emoji-mart's `custom` shape. */
export interface EmojiMartCustomEmoji {
  /** The `:name:` shortcode — used as emoji-mart id AND round-tripped on select. */
  id: string;
  name: string;
  keywords?: string[];
  /** Signed image URL(s); emoji-mart renders `skins[0].src`. */
  skins: { src: string }[];
}

/** A named group of custom emoji (rendered as its own picker category). */
export interface EmojiMartCustomCategory {
  id: string;
  name: string;
  emojis: EmojiMartCustomEmoji[];
}

/** The subset of emoji-mart's selection object we read (loose by design). */
interface EmojiMartSelection {
  /** For a unicode emoji: the glyph with skin tone applied. Absent for custom. */
  native?: string;
  /** emoji-mart id — for a custom emoji this is our `:name:` shortcode. */
  id: string;
}

/**
 * Demli Voice v2 skin for emoji-mart. The `--rgb-*` variables are comma-separated
 * RGB triplets (emoji-mart consumes them as `rgb(var(--rgb-*))`); the border
 * variables take a full colour, so they reference the hairline tokens directly.
 * The triplet values mirror the SINGLE palette source in
 * apps/desktop/src/renderer/src/styles/globals.css `@theme` — change the palette
 * there and update these four in lockstep.
 */
const DEMLI_THEME = {
  "--rgb-accent": "255, 140, 26" /* --color-accent      #ff8c1a */,
  "--rgb-background": "46, 19, 11" /* --color-raised      #2e130b (popover surface) */,
  "--rgb-input": "26, 8, 6" /* --color-app         #1a0806 (inset search field) */,
  "--rgb-color": "248, 238, 212" /* --color-fg          #f8eed4 (text) */,
  "--color-border": "var(--color-stroke)" /* cream hairline */,
  "--color-border-over": "var(--color-stroke-strong)",
  "--border-radius": "10px" /* = --tc-radius (popover roundness) */,
  "--font-family": "inherit",
} as CSSProperties;

export interface EmojiMartPickerProps {
  /** Receives a unicode glyph or a `:name:` shortcode — insert verbatim. */
  onSelect: (text: string) => void;
  /** Active app locale; drives emoji-mart's own strings (Turkish when "tr"). */
  locale: string;
  /** Server custom emoji as an extra category, or undefined for none. */
  custom?: EmojiMartCustomCategory[];
}

export default function EmojiMartPicker({
  onSelect,
  locale,
  custom,
}: EmojiMartPickerProps): JSX.Element {
  return (
    // The wrapper carries the theme vars; emoji-mart's shadow DOM inherits them.
    <div style={DEMLI_THEME}>
      <Picker
        data={data}
        custom={custom}
        // English is emoji-mart's built-in default; only Turkish needs an override.
        i18n={locale === "tr" ? trI18n : undefined}
        theme="dark"
        set="native"
        previewPosition="none"
        skinTonePosition="search"
        navPosition="top"
        perLine={8}
        maxFrequentRows={2}
        autoFocus={false}
        onEmojiSelect={(emoji: EmojiMartSelection) => {
          // Unicode → the glyph (skin tone baked in); custom → its `:name:`.
          onSelect(emoji.native ?? `:${emoji.id}:`);
        }}
      />
    </div>
  );
}
