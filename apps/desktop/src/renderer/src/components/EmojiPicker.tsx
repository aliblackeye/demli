import { Suspense, lazy, useMemo, useState, type ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@demli/ui";
import type { GroupId } from "@demli/types";
import { useAppTranslation } from "../lib/i18n";
import { useCustomEmojis, useCustomEmojiMap } from "../queries/chat-queries";
import type { EmojiMartCustomCategory, EmojiMartCustomEmoji } from "./EmojiMartPicker";

/**
 * EmojiPicker — the SINGLE emoji-selection surface for the whole app (composer,
 * and any future emoji entry point). Founder principle: one component, reused
 * everywhere — never a second hand-rolled picker.
 *
 * It is a thin, product-aware shell around emoji-mart:
 *  - a Radix Popover for placement + open/close, so it drops into any trigger;
 *  - the emoji-mart engine + dataset, {@link ./EmojiMartPicker code-split} behind
 *    a `React.lazy` boundary so none of its weight is in the main bundle (§27);
 *  - the active server's CUSTOM emoji (M17) fed in as emoji-mart's own `custom`
 *    category, so they search + render alongside the unicode set and, on select,
 *    still insert their `:name:` shortcode exactly as before (§28).
 *
 * `onSelect` receives either a unicode glyph or a `:name:` shortcode — the caller
 * inserts it verbatim (composer) exactly like the picker this replaces.
 */
const EmojiMartPicker = lazy(() => import("./EmojiMartPicker"));

export function EmojiPicker({
  groupId,
  onSelect,
  children,
  align = "end",
  side = "top",
  onOpenChange,
}: {
  /** Server whose custom emoji fill the extra category; null = unicode only. */
  groupId: GroupId | null;
  /** Receives a unicode glyph or a `:name:` shortcode — insert verbatim. */
  onSelect: (text: string) => void;
  children: ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  /**
   * Notified when the popover opens/closes. Lets a caller (the message-row hover
   * toolbar) keep itself visible while the picker is open — the JS replacement
   * for the Safari-unsupported `:has([data-state=open])` selector.
   */
  onOpenChange?: (open: boolean) => void;
}): JSX.Element {
  const { t, i18n } = useAppTranslation();
  const [open, setOpen] = useState(false);

  const handleOpenChange = (next: boolean): void => {
    setOpen(next);
    onOpenChange?.(next);
  };

  // Only a mounted-and-open picker pays for the emoji queries (same gate as the
  // hand-written picker it replaces).
  const { data: emojiMeta } = useCustomEmojis(open ? groupId : null);
  const emojiUrls = useCustomEmojiMap(open ? groupId : null);

  // Build emoji-mart's `custom` categories from the group's emoji + signed URLs.
  // An emoji with no minted URL yet is skipped (it has no image to show) — the
  // same graceful degradation the message renderer uses for a `:name:` miss.
  const custom = useMemo<EmojiMartCustomCategory[] | undefined>(() => {
    const source = emojiMeta?.emojis ?? [];
    if (groupId === null || source.length === 0) return undefined;
    const emojis: EmojiMartCustomEmoji[] = [];
    for (const emoji of source) {
      const src = emojiUrls.get(emoji.name);
      if (src) emojis.push({ id: emoji.name, name: emoji.name, keywords: [emoji.name], skins: [{ src }] });
    }
    if (emojis.length === 0) return undefined;
    return [{ id: "group", name: t("desktop:emoji.customCategory"), emojis }];
  }, [groupId, emojiMeta, emojiUrls, t]);

  const pick = (text: string): void => {
    onSelect(text);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align={align}
        side={side}
        sideOffset={6}
        // Strip the default popover chrome — emoji-mart paints its own themed,
        // rounded, bordered frame, so a second bg/border/shadow would double it.
        className="w-auto border-none bg-transparent p-0 shadow-none"
        aria-label={t("desktop:emoji.title")}
      >
        <Suspense
          fallback={
            <div
              className="h-[420px] w-[352px] rounded-[10px] border border-stroke bg-raised"
              aria-busy="true"
            />
          }
        >
          <EmojiMartPicker onSelect={pick} locale={i18n.language} custom={custom} />
        </Suspense>
      </PopoverContent>
    </Popover>
  );
}
