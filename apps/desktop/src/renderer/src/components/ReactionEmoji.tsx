import type { ReactNode } from "react";
import { parseCustomEmojiShortcode } from "@demli/config";
import { useCustomEmojiContext, useCustomEmojiUrlMap } from "./CustomEmojiContext";
import { EmojiPicker } from "./EmojiPicker";

/**
 * Desktop reaction-emoji seam (M17 widening).
 *
 * Two small components the shared @demli/app-ui <MessageRow> reads through its
 * services object, so the shared row stays platform-agnostic while the
 * group-scoped custom-emoji coupling (the `:name:` → signed-URL map, the picker's
 * active group) stays here on the desktop side:
 *
 *  - {@link ReactionEmojiGlyph} — renders a reaction's glyph inside its count
 *    badge: a unicode emoji as text, a `:name:` custom emoji as its image.
 *  - {@link ReactionEmojiPickerSlot} — the reaction picker itself, now the FULL
 *    emoji picker (unicode + this group's custom emoji) via the single shared
 *    {@link EmojiPicker} the composer already uses (DRY — never a second picker).
 */

/**
 * A reaction's visual. A `:name:` shortcode (M17 custom emoji) resolves against
 * the active surface's emoji map and renders as its image; an unknown/deleted
 * name — or any unicode emoji — renders as text (the same graceful fallback the
 * message body's custom-emoji token uses).
 *
 * Safety (§28): the only user-derived value is the shortcode name, already bounded
 * to `[a-z0-9_]{2,32}` by {@link parseCustomEmojiShortcode}; the `src` is a signed
 * URL minted by our own API and the alt text is a plain text node.
 */
export function ReactionEmojiGlyph({ emoji }: { emoji: string }): JSX.Element {
  // Hook is called unconditionally (Rules of Hooks); the map is a stable
  // ReadonlyMap reference for the whole channel (§27, one provider per surface).
  const byName = useCustomEmojiUrlMap();
  const name = parseCustomEmojiShortcode(emoji);
  const url = name ? byName.get(name) : undefined;
  if (name && url) {
    return (
      <img
        src={url}
        alt={emoji}
        title={emoji}
        draggable={false}
        loading="lazy"
        className="inline-block h-[1.15em] w-auto max-w-[4em] select-none object-contain"
      />
    );
  }
  return <>{emoji}</>;
}

/**
 * The reaction picker. Reads the surface's custom-emoji group from context AT the
 * row's tree position (null outside a server surface, so a DM simply gets no
 * custom-emoji category, matching the API which rejects a `:name:` reaction with
 * no group). The shared {@link EmojiPicker} already surfaces a Frequently-Used
 * quick row on top of the full unicode set plus the group's custom category.
 */
export function ReactionEmojiPickerSlot({
  onSelect,
  align,
  onOpenChange,
  children,
}: {
  onSelect: (emoji: string) => void;
  align?: "start" | "center" | "end";
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}): JSX.Element {
  const { groupId } = useCustomEmojiContext();
  return (
    <EmojiPicker
      groupId={groupId}
      onSelect={onSelect}
      align={align ?? "start"}
      side="top"
      onOpenChange={onOpenChange}
    >
      {children}
    </EmojiPicker>
  );
}
