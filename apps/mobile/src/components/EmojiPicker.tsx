import { useEffect, useMemo, useRef, useState } from "react";
import { Image, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { Text } from "./ui/Text";
import { Sheet } from "./ui/Sheet";
import { Touchable } from "./ui/Touchable";
import { useAppTranslation } from "@/lib/i18n";
import { haptics } from "@/lib/haptics";
import { EMOJI_CATEGORIES, type EmojiCategoryId } from "../lib/emoji-data";
import { useCustomEmojis } from "../queries/chat-queries";
import { colors, radius, space } from "../theme/theme";
import { useCustomEmojiContext } from "./CustomEmojiContext";

/** Grid density — 8 columns reads well from ~360dp up without cramping the glyphs. */
const COLUMNS = 8;
const SHEET_PADDING = space.sm;

type TabId = EmojiCategoryId | "custom";

/**
 * The JS-only emoji picker (audit ref #3) on the kit's draggable Sheet: the
 * composer opens it to insert, the message sheet's "more" opens it to react.
 * Picking CLOSES it (founder UX: the panel covers the composer, so staying
 * open means you cannot see what you inserted).
 *
 * The category bar sits at the bottom, where the thumb already is (the phone
 * keyboard's own emoji layout); switching category returns the grid to the
 * top. The server's custom emoji get their own first tab, only when the
 * server has any (§35 — an empty tab that can never fill is a dead affordance).
 *
 * No native emoji module is pulled in (OTA-safe). One category renders at a
 * time, its cells are plain Pressables with a wash on press — a few hundred
 * cheap views, not a few hundred animated ones (§27).
 */
export function EmojiPicker({
  visible,
  onSelect,
  onClose,
}: {
  visible: boolean;
  onSelect: (emoji: string) => void;
  onClose: () => void;
}) {
  const { t } = useAppTranslation();
  const { width } = useWindowDimensions();
  const scrollRef = useRef<ScrollView>(null);
  const [categoryId, setCategoryId] = useState<TabId>(EMOJI_CATEGORIES[0]!.id);

  // The server's custom emoji (M17). The screen's provider supplies the group;
  // outside a server surface it is null and the tab is not offered at all.
  const { groupId, byName } = useCustomEmojiContext();
  const { data: emojiMeta } = useCustomEmojis(visible ? groupId : null);
  const customEmojis = emojiMeta?.emojis ?? [];
  const hasCustom = groupId !== null && customEmojis.length > 0;
  const activeId: TabId = categoryId === "custom" && !hasCustom ? EMOJI_CATEGORIES[0]!.id : categoryId;

  const active = useMemo(
    () => EMOJI_CATEGORIES.find((c) => c.id === activeId) ?? EMOJI_CATEGORIES[0]!,
    [activeId],
  );

  // A new category starts at its top.
  useEffect(() => {
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [activeId]);

  // Explicit literal-key lookup (not a `t(dynamic)`) so the typed catalog stays
  // compile-checked — each category's accessible name.
  const categoryLabel: Record<EmojiCategoryId, string> = {
    smileys: t("mobile:emojiPicker.category.smileys"),
    gestures: t("mobile:emojiPicker.category.gestures"),
    hearts: t("mobile:emojiPicker.category.hearts"),
    animals: t("mobile:emojiPicker.category.animals"),
    food: t("mobile:emojiPicker.category.food"),
    activities: t("mobile:emojiPicker.category.activities"),
    travel: t("mobile:emojiPicker.category.travel"),
    objects: t("mobile:emojiPicker.category.objects"),
    symbols: t("mobile:emojiPicker.category.symbols"),
  };

  // Cells fill the sheet edge to edge at any width.
  const cell = Math.floor((width - SHEET_PADDING * 2) / COLUMNS);

  const pick = (value: string) => {
    haptics.selection();
    onSelect(value);
    onClose();
  };

  const tabs: { id: TabId; label: string; glyph: string }[] = [
    ...(hasCustom ? [{ id: "custom" as const, label: t("mobile:emojiPicker.category.custom"), glyph: "✦" }] : []),
    ...EMOJI_CATEGORIES.map((c) => ({ id: c.id, label: categoryLabel[c.id], glyph: c.icon })),
  ];

  const activeTitle = activeId === "custom" ? t("mobile:emojiPicker.category.custom") : categoryLabel[active.id];

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={t("mobile:emojiPicker.title")}
      snapPoints={["62%"]}
      contentPadding={SHEET_PADDING}
      scrollRef={scrollRef}
      footer={
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="always"
          contentContainerStyle={{ gap: 2 }}
          accessibilityRole="tablist"
        >
          {tabs.map((tab) => {
            const selected = tab.id === activeId;
            return (
              <Touchable
                key={tab.id}
                onPress={() => setCategoryId(tab.id)}
                tone={selected ? colors.accentSurface : undefined}
                pressedTone={selected ? colors.accentSurfaceStrong : colors.wash}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                accessibilityLabel={tab.label}
                style={{
                  width: 44,
                  height: 40,
                  borderRadius: radius.lg,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text
                  style={{
                    fontSize: tab.id === "custom" ? 16 : 20,
                    color: selected ? colors.accent : colors.fgMuted,
                    opacity: selected ? 1 : 0.6,
                  }}
                >
                  {tab.glyph}
                </Text>
              </Touchable>
            );
          })}
        </ScrollView>
      }
    >
      <Text type="caption" tone="faint" style={{ paddingHorizontal: space.xs, paddingBottom: space.xs }}>
        {activeTitle}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
        {activeId === "custom"
          ? // A custom emoji inserts its `:name:` SHORTCODE, not a URL — the
            // message stays plain text over the wire and the renderer resolves
            // the image at paint (§28).
            customEmojis.map((item) => {
              const url = byName.get(item.name);
              return (
                <Pressable
                  key={item.id}
                  onPress={() => pick(`:${item.name}:`)}
                  accessibilityRole="button"
                  accessibilityLabel={`:${item.name}:`}
                  style={({ pressed }) => ({
                    width: cell,
                    height: cell,
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: radius.lg,
                    backgroundColor: pressed ? colors.washStrong : "transparent",
                  })}
                >
                  {url ? (
                    <Image
                      source={{ uri: url }}
                      accessibilityIgnoresInvertColors
                      style={{ width: 28, height: 28 }}
                      resizeMode="contain"
                    />
                  ) : (
                    <Text numberOfLines={1} style={{ color: colors.fgFaint, fontSize: 9 }}>
                      :{item.name}:
                    </Text>
                  )}
                </Pressable>
              );
            })
          : active.emojis.map((item, i) => (
              <Pressable
                key={`${item}-${i}`}
                onPress={() => pick(item)}
                accessibilityRole="button"
                accessibilityLabel={t("mobile:emojiPicker.insert", { emoji: item })}
                style={({ pressed }) => ({
                  width: cell,
                  height: cell,
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: radius.lg,
                  backgroundColor: pressed ? colors.washStrong : "transparent",
                })}
              >
                <Text style={{ fontSize: 26, lineHeight: 32 }}>{item}</Text>
              </Pressable>
            ))}
      </View>
    </Sheet>
  );
}
