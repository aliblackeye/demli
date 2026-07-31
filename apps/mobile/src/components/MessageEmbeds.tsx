import { memo, useState } from "react";
import { Linking, Pressable, View } from "react-native";
import { Text } from "./ui/Text";
import { Image } from "expo-image";
import type { MessageEmbed } from "@demli/types";
import { capEmbeds, displayHost, isHttpUrl } from "./link-embed";
import { colors, radius, space, typography } from "../theme/theme";

/**
 * Link-preview cards (M17) — mobile mirror of the desktop
 * LinkEmbedCard. Rendered below a message's text from the server-unfurled
 * `MessageEmbed[]`. title/description/siteName render as PLAIN `<Text>` (never
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
  const [imageBroken, setImageBroken] = useState(false);
  const clickable = isHttpUrl(embed.url);
  const imageUrl =
    embed.imageUrl !== null && isHttpUrl(embed.imageUrl) && !imageBroken ? embed.imageUrl : null;
  const linkLabel = embed.title ?? embed.siteName ?? displayHost(embed.url);

  return (
    <Pressable
      onPress={clickable ? () => openLink(embed.url) : undefined}
      disabled={!clickable}
      accessibilityRole={clickable ? "link" : undefined}
      accessibilityLabel={clickable ? linkLabel : undefined}
      style={{
        borderRadius: radius.sm,
        borderCurve: "continuous",
        overflow: "hidden",
        borderWidth: 1,
        borderColor: colors.stroke,
        borderLeftWidth: 3,
        borderLeftColor: colors.accent,
        backgroundColor: colors.surface,
        paddingVertical: space.sm,
        paddingHorizontal: space.md,
        gap: 3,
      }}
    >
      {embed.siteName ? (
        <Text
          numberOfLines={1}
          style={{ color: colors.fgFaint, fontSize: typography.size["2xs"], fontWeight: "600" }}
        >
          {embed.siteName}
        </Text>
      ) : null}
      {embed.title ? (
        <Text
          numberOfLines={2}
          style={{
            color: clickable ? colors.accent : colors.fg,
            fontSize: 14,
            fontWeight: "700",
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
        <Image
          source={{ uri: imageUrl }}
          contentFit="cover"
          transition={80}
          onError={() => setImageBroken(true)}
          style={{
            marginTop: space.xs,
            width: "100%",
            height: IMAGE_HEIGHT,
            borderRadius: radius.sm,
            backgroundColor: colors.surfaceRaised,
          }}
        />
      ) : null}
    </Pressable>
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
    <View style={{ marginTop: space.xs, gap: space.xs }}>
      {visible.map((embed, i) => (
        <LinkEmbedCard key={`${embed.url}-${i}`} embed={embed} />
      ))}
    </View>
  );
});
