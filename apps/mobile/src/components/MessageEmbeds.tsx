import { memo, useState } from "react";
import { Linking, View, useWindowDimensions } from "react-native";
import { Text } from "./ui/Text";
import { Touchable } from "./ui/Touchable";
import { useReducedMotion } from "../theme/motion";
import { Image } from "expo-image";
import type { MessageEmbed } from "@demli/types";
import { capEmbeds, displayHost, isHttpUrl } from "./link-embed";
import { colors, motion, radius, space } from "../theme/theme";

/**
 * Link-preview cards (M17) — mobile mirror of the desktop
 * LinkEmbedCard. Rendered below a message's text from the server-unfurled
 * `MessageEmbed[]` as a borderless Koyu Masa card (surface tone, radius 16,
 * press = one surface step up). title/description/siteName render as PLAIN `<Text>` (never
 * markup — §28); the card opens its URL only when http(s) (§28); a broken image
 * collapses to a text-only card (§26 — no broken-image state). At most
 * {@link capEmbeds} (3) cards per message.
 */

/** Reserved image height — a fixed box so the async image load never reflows the row. */
const IMAGE_HEIGHT = 168;

/** Open only validated http/https links; swallow failures (nothing to surface). */
function openLink(url: string): void {
  if (!isHttpUrl(url)) return;
  void Linking.openURL(url).catch(() => {
    /* no-op: the OS could not handle the URL */
  });
}

const LinkEmbedCard = memo(function LinkEmbedCard({ embed }: { embed: MessageEmbed }) {
  const { width } = useWindowDimensions();
  const reduced = useReducedMotion();
  const [imageBroken, setImageBroken] = useState(false);
  const clickable = isHttpUrl(embed.url);
  const imageUrl =
    embed.imageUrl !== null && isHttpUrl(embed.imageUrl) && !imageBroken ? embed.imageUrl : null;
  const linkLabel = embed.title ?? embed.siteName ?? displayHost(embed.url);
  // Same width budget as an attachment tile: the screen minus the avatar column.
  const cardWidth = Math.max(200, Math.min(360, width - 84));

  return (
    <Touchable
      onPress={clickable ? () => openLink(embed.url) : undefined}
      disabled={!clickable}
      dimmed={false}
      tone={colors.surface}
      pressedTone={colors.surfaceRaised}
      accessibilityRole={clickable ? "link" : undefined}
      accessibilityLabel={clickable ? linkLabel : undefined}
      accessibilityHint={clickable ? displayHost(embed.url) : undefined}
      style={{
        width: cardWidth,
        borderRadius: radius.xl,
        borderCurve: "continuous",
        overflow: "hidden",
        paddingVertical: space.md,
        paddingHorizontal: space.md + 2,
        gap: 4,
      }}
    >
      <Text numberOfLines={1} type="caption" tone="faint">
        {embed.siteName ?? displayHost(embed.url)}
      </Text>
      {embed.title ? (
        <Text
          numberOfLines={2}
          style={{
            color: clickable ? colors.accentHover : colors.fg,
            fontSize: 14,
            lineHeight: 19,
            fontWeight: "600",
          }}
        >
          {embed.title}
        </Text>
      ) : null}
      {embed.description ? (
        <Text numberOfLines={3} style={{ color: colors.fgMuted, fontSize: 13, lineHeight: 18 }}>
          {embed.description}
        </Text>
      ) : null}
      {imageUrl ? (
        // Reserved box (no reflow when the bytes land); the picture fades in on
        // the fast step, instantly under reduced motion.
        <Image
          source={{ uri: imageUrl }}
          contentFit="cover"
          transition={reduced ? 0 : motion.duration.fast}
          onError={() => setImageBroken(true)}
          accessibilityIgnoresInvertColors
          style={{
            marginTop: space.xs + 2,
            width: "100%",
            height: IMAGE_HEIGHT,
            borderRadius: radius.lg,
            backgroundColor: colors.wash,
          }}
        />
      ) : null}
    </Touchable>
  );
});

/**
 * The stack of link-preview cards under a message (capped at 3). Memoized: an
 * unchanged `embeds` reference (the fold preserves it for untouched messages)
 * skips this subtree entirely (§27).
 */
export const MessageEmbeds = memo(function MessageEmbeds({ embeds }: { embeds: MessageEmbed[] }) {
  const visible = capEmbeds(embeds);
  return (
    <View style={{ marginTop: space.xs + 2, gap: space.xs + 2 }}>
      {visible.map((embed, i) => (
        <LinkEmbedCard key={`${embed.url}-${i}`} embed={embed} />
      ))}
    </View>
  );
});
