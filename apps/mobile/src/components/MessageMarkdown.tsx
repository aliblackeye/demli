import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import { Image, Linking, Platform, View } from "react-native";
import { Text } from "./ui/Text";
import { router } from "expo-router";
import {
  hasMarkdown,
  parseMessageMarkdown,
  type MarkdownBlock,
  type MarkdownInline,
} from "@demli/client-core";
import { MENTION_EVERYONE, MENTION_HERE } from "@demli/protocol";
import { useAppTranslation } from "@/lib/i18n";
import { useAuthStore } from "../stores/auth-store";
import { useChatStore } from "../stores/chat-store";
import { colors, radius, space } from "../theme/theme";
import { useCustomEmojiUrlMap } from "./CustomEmojiContext";

/**
 * Renders a message body from the SHARED markdown tokenizer (@demli/client-core)
 * with React Native `<Text>`. The desktop app renders the SAME tokens with DOM
 * spans, so a message formats identically on both platforms (ADR 0002 parity).
 *
 * Safety (CLAUDE.md §28): every token value goes into a `<Text>` node — never any
 * HTML — so content stays escaped. Links are auto-linked http(s) only and open via
 * `Linking`; spoilers stay covered until tapped. This subsumes the old linkify
 * (URLs are now `link` tokens), so tappable URLs keep working inside formatting.
 * A `mention` token resolves its display name from the users directory at render
 * and draws a highlighted pill; a user mention taps through to their profile.
 */

const BASE_STYLE: { color: string; fontSize: number; lineHeight: number } = {
  color: colors.fg,
  fontSize: 15,
  lineHeight: 21,
};
/**
 * Inline custom-emoji box. Matches the body line height (21) so an emoji sits in
 * the text run without ever growing the row — RN cannot size an inline image in
 * `em`, so the constant is derived from BASE_STYLE by hand and must move with it.
 */
const EMOJI_SIZE = 20;
const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

/** Server context so a tapped mention opens the profile with that server's roles. */
const MentionGroupContext = createContext<string | undefined>(undefined);

/** A `<@id>` mention pill (RN). Resolves the name from the directory at render. */
function MentionText({ id }: { id: string }): JSX.Element {
  const { t } = useAppTranslation();
  const groupId = useContext(MentionGroupContext);
  const meId = useAuthStore((s) => s.user?.id);
  const user = useChatStore((s) => s.users[id]);

  const isBroadcast = id === MENTION_EVERYONE || id === MENTION_HERE;
  const mentionsMe = !isBroadcast && meId === id;
  const label = isBroadcast
    ? `@${id}`
    : `@${user?.displayName ?? user?.username ?? t("mobile:chat.unknownAuthor")}`;

  // Koyu Masa mention chip: coral wash + the light coral ink; a mention of YOU
  // takes the stronger wash so it is found at a glance in a busy thread.
  const style = {
    color: colors.accentHover,
    fontWeight: "500" as const,
    backgroundColor: mentionsMe ? colors.accentSurfaceStrong : colors.accentSurface,
  };

  if (isBroadcast) return <Text style={style}>{label}</Text>;

  return (
    <Text
      onPress={() =>
        router.push({
          pathname: "/user/[userId]",
          params: groupId ? { userId: id, groupId } : { userId: id },
        })
      }
      suppressHighlighting
      style={style}
    >
      {label}
    </Text>
  );
}

/** Open only validated http/https links; swallow failures (nothing to surface). */
function openLink(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  void Linking.openURL(url).catch(() => {
    /* no-op: the OS could not handle the URL */
  });
}

/** Concatenate the plain text of an inline subtree (spoiler cover text). */
function flattenInline(nodes: MarkdownInline[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case "text":
        case "code":
        case "link":
          return n.value;
        case "mention":
          return `@${n.id}`;
        case "emoji":
          // Spoiler cover text is PLAIN text, so an emoji contributes its
          // shortcode — the same characters the author typed.
          return `:${n.name}:`;
        case "break":
          return "\n";
        default:
          return flattenInline(n.children);
      }
    })
    .join("");
}

/** A ||spoiler|| — covered text that reveals its formatted content on tap. */
function Spoiler({ children, plain }: { children: ReactNode; plain: string }): JSX.Element {
  const { t } = useAppTranslation();
  const [revealed, setRevealed] = useState(false);
  if (revealed) {
    return <Text style={{ backgroundColor: colors.wash, borderRadius: 3 }}>{children}</Text>;
  }
  return (
    <Text
      onPress={() => setRevealed(true)}
      suppressHighlighting
      accessibilityRole="button"
      accessibilityLabel={t("mobile:message.spoilerReveal")}
      // An opaque raised block: the words are present (for the reveal) but the
      // ink is transparent, so nothing shows through until the tap.
      style={{ backgroundColor: colors.surfaceRaised, color: "transparent", borderRadius: 3 }}
    >
      {plain}
    </Text>
  );
}

/**
 * A `:name:` custom-emoji shortcode (M17). Resolves the name against the screen's
 * emoji map; an unknown name (never uploaded, or since deleted) falls back to the
 * LITERAL `:name:` text, so a deleted emoji degrades to plain text instead of
 * leaving a broken image in the scrollback.
 *
 * Rendered as an `<Image>` INSIDE a `<Text>` — the RN way to keep a glyph on the
 * text baseline and flowing with the words. It is deliberately sized to the body
 * line height, so a message row never changes height because of an emoji.
 *
 * Safety (§28): the only user-derived value is `name`, which the tokenizer has
 * already bounded to `[a-z0-9_]{2,32}`. The `uri` is a signed URL minted by our
 * own API — never anything embedded in the message.
 */
function CustomEmojiText({ name }: { name: string }): JSX.Element {
  const url = useCustomEmojiUrlMap().get(name);
  if (!url) return <Text>{`:${name}:`}</Text>;
  return (
    <Text accessibilityLabel={`:${name}:`}>
      <Image
        source={{ uri: url }}
        accessibilityIgnoresInvertColors
        style={{ width: EMOJI_SIZE, height: EMOJI_SIZE }}
        resizeMode="contain"
      />
    </Text>
  );
}

/** Render one inline node (recursively) as nested `<Text>`. */
function renderInline(node: MarkdownInline, key: number): ReactNode {
  switch (node.type) {
    case "text":
      return <Text key={key}>{node.value}</Text>;
    case "mention":
      return <MentionText key={key} id={node.id} />;
    case "emoji":
      return <CustomEmojiText key={key} name={node.name} />;
    case "break":
      return <Text key={key}>{"\n"}</Text>;
    case "strong":
      return (
        <Text key={key} style={{ fontWeight: "700", color: colors.fg }}>
          {renderInlineList(node.children)}
        </Text>
      );
    case "em":
      return (
        <Text key={key} style={{ fontStyle: "italic" }}>
          {renderInlineList(node.children)}
        </Text>
      );
    case "strike":
      return (
        <Text key={key} style={{ textDecorationLine: "line-through" }}>
          {renderInlineList(node.children)}
        </Text>
      );
    case "code":
      return (
        <Text
          key={key}
          style={{ fontFamily: MONO, fontSize: 13.5, backgroundColor: colors.surface, color: colors.fg }}
        >
          {" "}
          {node.value}
          {" "}
        </Text>
      );
    case "link":
      return (
        <Text
          key={key}
          onPress={() => openLink(node.href)}
          suppressHighlighting
          style={{ color: colors.accent, textDecorationLine: "underline" }}
        >
          {node.value}
        </Text>
      );
    case "spoiler":
      return <Spoiler key={key} plain={flattenInline(node.children)}>{renderInlineList(node.children)}</Spoiler>;
    default:
      return null;
  }
}

function renderInlineList(nodes: MarkdownInline[]): ReactNode {
  return nodes.map((n, i) => renderInline(n, i));
}

/** Render one block node. `append` renders inline after a paragraph's text. */
function renderBlock(
  block: MarkdownBlock,
  key: number,
  base: typeof BASE_STYLE,
  append?: ReactNode,
): ReactNode {
  switch (block.type) {
    case "paragraph":
      return (
        <Text key={key} style={base}>
          {renderInlineList(block.children)}
          {append}
        </Text>
      );
    case "blockquote":
      return (
        <View
          key={key}
          style={{
            borderLeftWidth: 3,
            borderLeftColor: colors.strokeStrong,
            borderRadius: 2,
            paddingLeft: space.sm + 2,
          }}
        >
          <Text style={{ ...base, color: colors.fgMuted }}>
            {renderInlineList(block.children)}
          </Text>
        </View>
      );
    case "codeBlock":
      return (
        <View
          key={key}
          style={{
            backgroundColor: colors.surface,
            borderRadius: radius.md,
            borderCurve: "continuous",
            paddingHorizontal: space.md,
            paddingVertical: space.sm,
          }}
        >
          <Text style={{ fontFamily: MONO, fontSize: 13, lineHeight: 19, color: colors.fg }}>
            {block.value}
          </Text>
        </View>
      );
    default:
      return null;
  }
}

/**
 * Message body with the shared markdown subset. `append` is an inline node (the
 * "(edited)" marker) placed after the last line of text. A plain-text message
 * (no markup, no URL) takes the single-`<Text>` fast path — identical to the
 * pre-markdown rendering.
 */
export function MessageMarkdown({
  content,
  append,
  groupId,
  color,
}: {
  content: string;
  append?: ReactNode;
  /** Server context so a mention taps through to a role-aware profile. */
  groupId?: string;
  /**
   * Body ink override — the thread draws a sending row faint and a failed one
   * muted. Mentions, links and code keep their own colours.
   */
  color?: string;
}): JSX.Element {
  const blocks = useMemo(
    () => (hasMarkdown(content) ? parseMessageMarkdown(content) : null),
    [content],
  );
  const base = useMemo(() => (color ? { ...BASE_STYLE, color } : BASE_STYLE), [color]);

  if (blocks === null) {
    return (
      <Text style={base}>
        {content}
        {append}
      </Text>
    );
  }

  const lastIndex = blocks.length - 1;
  const appendInline = append !== undefined && blocks[lastIndex]?.type === "paragraph";
  return (
    <MentionGroupContext.Provider value={groupId}>
      <View style={{ gap: 4 }}>
        {blocks.map((block, i) =>
          renderBlock(block, i, base, appendInline && i === lastIndex ? append : undefined),
        )}
        {append !== undefined && !appendInline ? <Text style={base}>{append}</Text> : null}
      </View>
    </MentionGroupContext.Provider>
  );
}
