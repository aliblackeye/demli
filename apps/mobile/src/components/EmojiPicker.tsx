import { useMemo, useState } from "react";
import {
  FlatList,
  Image,
  Modal,
  Pressable,
  useWindowDimensions,
  View,
} from "react-native";
import { Text } from "./ui/Text";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppTranslation } from "@/lib/i18n";
import { EMOJI_CATEGORIES, type EmojiCategoryId } from "../lib/emoji-data";
import { useCustomEmojis } from "../queries/chat-queries";
import { colors, radius, space } from "../theme/theme";
import { useCustomEmojiContext } from "./CustomEmojiContext";

/** Grid density — 8 columns reads well from ~360dp up without cramping the glyphs. */
const COLUMNS = 8;

/**
 * A JS-only unicode emoji picker (audit ref #3) presented as a bottom sheet. The
 * composer opens it; a tap inserts the glyph at the caret and keeps the sheet up
 * so several can be added in a row, closed via the grabber / a
 * backdrop tap. No native emoji-keyboard module is pulled in, so it stays
 * OTA-safe; one shared FlatList renders the active category's glyphs, and only
 * the visible column of category tabs stays mounted (CLAUDE.md §27).
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
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [categoryId, setCategoryId] = useState<EmojiCategoryId | "custom">(
    EMOJI_CATEGORIES[0]!.id,
  );

  // The server's custom emoji (M17). The screen's provider supplies the group;
  // outside a server surface it is null and the tab is not offered at all (§35 —
  // an empty tab that can never fill is a dead affordance).
  const { groupId, byName } = useCustomEmojiContext();
  const { data: emojiMeta } = useCustomEmojis(visible ? groupId : null);
  const customEmojis = emojiMeta?.emojis ?? [];
  const hasCustom = groupId !== null && customEmojis.length > 0;
  const activeId = categoryId === "custom" && !hasCustom ? EMOJI_CATEGORIES[0]!.id : categoryId;

  const active = useMemo(
    () => EMOJI_CATEGORIES.find((c) => c.id === activeId) ?? EMOJI_CATEGORIES[0]!,
    [activeId],
  );

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

  // Cell size from the live width so the grid fills the sheet edge-to-edge at any
  // screen size (the sheet spans the full width minus its horizontal padding).
  const cell = Math.floor((width - space.md * 2) / COLUMNS);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        accessibilityLabel={t("common:buttons.close")}
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" }}
      >
        {/* Sheet — its own Pressable swallows taps so they don't dismiss it. */}
        <Pressable
          onPress={() => {}}
          style={{
            height: "58%",
            backgroundColor: colors.surface,
            borderTopLeftRadius: radius.lg,
            borderTopRightRadius: radius.lg,
            borderCurve: "continuous",
            borderTopWidth: 1,
            borderColor: colors.stroke,
            paddingBottom: insets.bottom,
          }}
        >
          {/* Grabber. */}
          <View style={{ alignItems: "center", paddingTop: space.sm, paddingBottom: space.xs }}>
            <View
              style={{ width: 40, height: 4, borderRadius: radius.pill, backgroundColor: colors.strokeStrong }}
            />
          </View>

          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              paddingHorizontal: space.md,
              paddingBottom: space.xs,
            }}
          >
            <Text style={{ color: colors.fg, fontSize: 15, fontWeight: "700" }}>
              {t("mobile:emojiPicker.title")}
            </Text>
            <Pressable
              onPress={onClose}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t("common:buttons.close")}
            >
              <Text style={{ color: colors.accent, fontSize: 14, fontWeight: "600" }}>
                {t("common:buttons.close")}
              </Text>
            </Pressable>
          </View>

          {/* Category tabs. */}
          <View style={{ flexDirection: "row", paddingHorizontal: space.sm, paddingBottom: space.xs, gap: 2 }}>
            {hasCustom ? (
              <Pressable
                onPress={() => setCategoryId("custom")}
                accessibilityRole="button"
                accessibilityState={{ selected: activeId === "custom" }}
                accessibilityLabel={t("mobile:emojiPicker.category.custom")}
                style={{
                  flex: 1,
                  alignItems: "center",
                  paddingVertical: space.xs,
                  borderRadius: radius.sm,
                  borderCurve: "continuous",
                  backgroundColor:
                    categoryId === "custom" ? colors.surfaceRaised : "transparent",
                }}
              >
                <Text
                  style={{
                    color: colors.fg,
                    fontSize: 14,
                    fontWeight: "700",
                    opacity: categoryId === "custom" ? 1 : 0.55,
                  }}
                >
                  {":)"}
                </Text>
              </Pressable>
            ) : null}
            {EMOJI_CATEGORIES.map((category) => {
              const selected = category.id === activeId;
              return (
                <Pressable
                  key={category.id}
                  onPress={() => setCategoryId(category.id)}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={categoryLabel[category.id]}
                  style={{
                    flex: 1,
                    alignItems: "center",
                    paddingVertical: space.xs,
                    borderRadius: radius.sm,
                    borderCurve: "continuous",
                    backgroundColor: selected ? colors.surfaceRaised : "transparent",
                  }}
                >
                  <Text style={{ fontSize: 20, opacity: selected ? 1 : 0.55 }}>{category.icon}</Text>
                </Pressable>
              );
            })}
          </View>

          <View style={{ height: 1, backgroundColor: colors.stroke }} />

          {activeId === "custom" ? (
            // A custom emoji inserts its `:name:` SHORTCODE, not a URL — the
            // message stays plain text over the wire and the renderer resolves
            // the image at paint (§28).
            <FlatList
              key="custom"
              data={customEmojis}
              keyExtractor={(emoji) => emoji.id}
              numColumns={COLUMNS}
              keyboardShouldPersistTaps="always"
              contentContainerStyle={{ paddingHorizontal: space.md, paddingVertical: space.sm }}
              renderItem={({ item }) => {
                const url = byName.get(item.name);
                return (
                  <Pressable
                    onPress={() => {
                      onSelect(`:${item.name}:`);
                      onClose();
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`:${item.name}:`}
                    style={({ pressed }) => ({
                      width: cell,
                      height: cell,
                      alignItems: "center",
                      justifyContent: "center",
                      borderRadius: radius.sm,
                      backgroundColor: pressed ? colors.surfaceRaised : "transparent",
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
              }}
            />
          ) : (
          <FlatList
            key={active.id}
            data={active.emojis}
            keyExtractor={(emoji, i) => `${emoji}-${i}`}
            numColumns={COLUMNS}
            keyboardShouldPersistTaps="always"
            initialNumToRender={64}
            contentContainerStyle={{ paddingHorizontal: space.md, paddingVertical: space.sm }}
            renderItem={({ item }) => (
              <Pressable
                // Founder UX: picking an emoji CLOSES the sheet — the 58%-tall
                // panel hides the composer, so staying open means you can't see
                // what you just inserted. One emoji per open beats blind typing.
                onPress={() => {
                  onSelect(item);
                  onClose();
                }}
                accessibilityRole="button"
                accessibilityLabel={t("mobile:emojiPicker.insert", { emoji: item })}
                style={({ pressed }) => ({
                  width: cell,
                  height: cell,
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: radius.sm,
                  backgroundColor: pressed ? colors.surfaceRaised : "transparent",
                })}
              >
                <Text style={{ fontSize: 26 }}>{item}</Text>
              </Pressable>
            )}
          />
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
