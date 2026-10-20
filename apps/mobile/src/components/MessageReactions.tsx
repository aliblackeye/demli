import { Image, View } from "react-native";
import { SmilePlus } from "lucide-react-native";
import { Text } from "./ui/Text";
import { Touchable } from "./ui/Touchable";
import { parseCustomEmojiShortcode } from "@demli/config";
import type { MessageReactionSummary } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { useCustomEmojiUrlMap } from "./CustomEmojiContext";
import { colors, radius, space } from "../theme/theme";

/**
 * The aggregated reaction pills under a message (ADR 0011 §1) — the Koyu Masa
 * reaction chip: a borderless pill, YOUR reaction in the coral wash with the
 * light coral count, everyone else's in the white wash. Tapping a pill toggles
 * your reaction (add ⇄ remove) through the optimistic pipeline in
 * realtime/connection.ts; press feedback is the tone step, plus a selection
 * tick so the toggle is felt.
 *
 * The trailing "+" pill opens the full picker for this message (the same one
 * the long-press sheet's "more" opens), so adding a new reaction is one tap
 * from where the reactions already are.
 *
 * A `:name:` shortcode (M17 custom emoji) resolves against the surface's emoji
 * map and renders as its image; a unicode emoji — or an unknown/deleted custom
 * name — renders as text (the same graceful fallback the message body uses).
 */
export function MessageReactions({
  reactions,
  onToggle,
  onAdd,
}: {
  reactions: MessageReactionSummary[];
  /** `reactedByMe` is the CURRENT state, so the handler knows which way to toggle. */
  onToggle: (emoji: string, reactedByMe: boolean) => void;
  /** Open the full picker to add a different reaction. */
  onAdd?: () => void;
}) {
  const { t } = useAppTranslation();
  // Stable ReadonlyMap for the whole surface (§27, one provider per screen); an
  // empty map outside a server context, so DM/group-chat reactions fall to text.
  const byName = useCustomEmojiUrlMap();
  if (reactions.length === 0) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs + 2, marginTop: space.xs + 2 }}>
      {reactions.map((r) => {
        const customName = parseCustomEmojiShortcode(r.emoji);
        const customUrl = customName ? byName.get(customName) : undefined;
        const mine = r.reactedByMe;
        return (
          <Touchable
            key={r.emoji}
            onPress={() => onToggle(r.emoji, mine)}
            haptic="selection"
            tone={mine ? colors.accentSurface : colors.wash}
            pressedTone={mine ? colors.accentSurfaceStrong : colors.washStrong}
            accessibilityRole="button"
            accessibilityState={{ selected: mine }}
            accessibilityLabel={t("mobile:message.reactionA11y", {
              emoji: customName ? `:${customName}:` : r.emoji,
              count: r.count,
            })}
            hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 5,
              minHeight: 30,
              paddingHorizontal: space.sm + 2,
              borderRadius: radius.pill,
              borderCurve: "continuous",
            }}
          >
            {customUrl ? (
              <Image
                source={{ uri: customUrl }}
                accessibilityIgnoresInvertColors
                style={{ width: 18, height: 18 }}
                resizeMode="contain"
              />
            ) : (
              <Text style={{ fontSize: 15, lineHeight: 19 }}>{r.emoji}</Text>
            )}
            <Text
              style={{
                fontSize: 12,
                lineHeight: 16,
                fontWeight: "600",
                fontVariant: ["tabular-nums"],
                color: mine ? colors.accentHover : colors.fgMuted,
              }}
            >
              {r.count}
            </Text>
          </Touchable>
        );
      })}
      {onAdd ? (
        <Touchable
          onPress={onAdd}
          tone={colors.wash}
          pressedTone={colors.washStrong}
          accessibilityRole="button"
          accessibilityLabel={t("mobile:message.reactMore")}
          hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
          style={{
            minHeight: 30,
            paddingHorizontal: space.sm + 2,
            borderRadius: radius.pill,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <SmilePlus size={16} color={colors.fgMuted} />
        </Touchable>
      ) : null}
    </View>
  );
}
