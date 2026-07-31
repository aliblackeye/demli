import { Image, Pressable, View } from "react-native";
import { Text } from "./ui/Text";
import { parseCustomEmojiShortcode } from "@demli/config";
import type { MessageReactionSummary } from "@demli/types";
import { useCustomEmojiUrlMap } from "./CustomEmojiContext";
import { colors, radius, space } from "../theme/theme";

/**
 * The aggregated reaction pills under a message (ADR 0011 §1). One pill per
 * distinct emoji showing `emoji count`; the viewer's own reactions are accent-
 * highlighted. Tapping a pill toggles the viewer's reaction (add ⇄ remove) via
 * the optimistic pipeline in realtime/connection.ts — never a dead affordance.
 *
 * A `:name:` shortcode (M17 custom emoji) resolves against the surface's emoji
 * map and renders as its image; a unicode emoji — or an unknown/deleted custom
 * name — renders as text (the same graceful fallback the message body uses).
 */
export function MessageReactions({
  reactions,
  onToggle,
}: {
  reactions: MessageReactionSummary[];
  /** `reactedByMe` is the CURRENT state, so the handler knows which way to toggle. */
  onToggle: (emoji: string, reactedByMe: boolean) => void;
}) {
  // Stable ReadonlyMap for the whole surface (§27, one provider per screen); an
  // empty map outside a server context, so DM/group-chat reactions fall to text.
  const byName = useCustomEmojiUrlMap();
  if (reactions.length === 0) return null;
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        gap: space.xs,
        marginTop: space.xs,
      }}
    >
      {reactions.map((r) => {
        const customName = parseCustomEmojiShortcode(r.emoji);
        const customUrl = customName ? byName.get(customName) : undefined;
        return (
          <Pressable
            key={r.emoji}
            onPress={() => onToggle(r.emoji, r.reactedByMe)}
            accessibilityRole="button"
            accessibilityState={{ selected: r.reactedByMe }}
            accessibilityLabel={`${r.emoji} ${r.count}`}
            hitSlop={4}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: space.xs,
              paddingHorizontal: space.sm,
              paddingVertical: 3,
              borderRadius: radius.pill,
              borderCurve: "continuous",
              borderWidth: 1,
              borderColor: r.reactedByMe ? colors.accent : colors.stroke,
              backgroundColor: r.reactedByMe ? colors.accentSurface : colors.surfaceRaised,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            {customUrl ? (
              <Image
                source={{ uri: customUrl }}
                accessibilityIgnoresInvertColors
                style={{ width: 16, height: 16 }}
                resizeMode="contain"
              />
            ) : (
              <Text style={{ fontSize: 13 }}>{r.emoji}</Text>
            )}
            <Text
              style={{
                fontSize: 12,
                fontWeight: "600",
                color: r.reactedByMe ? colors.accent : colors.fgMuted,
              }}
            >
              {r.count}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
