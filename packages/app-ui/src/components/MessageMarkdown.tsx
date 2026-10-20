import { createContext, memo, useContext, useMemo, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import {
  hasMarkdown,
  parseMessageMarkdown,
  type MarkdownBlock,
  type MarkdownInline,
} from "@demli/client-core";
import type { GroupId } from "@demli/types";
import { useTranslation } from "@demli/i18n";
import { cn } from "@demli/ui";
import { openExternalUrl } from "../platform/external-link";

/**
 * Shared, PURE message-body renderer (Phase 1, tek-kaynak UI).
 *
 * Renders a message from the SHARED markdown tokenizer (@demli/client-core)
 * into DOM spans. The mobile app renders the SAME tokens with `<Text>`, so a
 * message formats identically on every surface (ADR 0002 parity). This module
 * owns only the STATELESS structure — paragraphs, blockquotes, code, emphasis,
 * links, spoilers — and delegates the two STORE-COUPLED inline tokens (a `<@id>`
 * mention pill, which resolves a display name + opens a profile card, and a
 * `:name:` custom-emoji, which resolves a signed image URL) to slots supplied by
 * the surface. That keeps the auth/chat-store/profile-card coupling out of the
 * shared layer while the fine-grained per-token store subscriptions (§27) stay
 * exactly where they were — inside the surface's slot components.
 *
 * Safety (CLAUDE.md §28): every token value goes into a React TEXT node (never
 * `dangerouslySetInnerHTML`), so content stays escaped and un-injectable. Links
 * are auto-linked http(s) only and open in the OS browser through the shared
 * `openExternalUrl` seam (the desktop window denies `window.open` outright);
 * spoilers stay hidden until clicked.
 */

/**
 * Surface-supplied renderers for the two store-coupled inline tokens. Desktop
 * passes its store-bound MentionPill / CustomEmojiToken; web (Phase 4) supplies
 * its own. Absent (no provider) → the tokens degrade to plain text.
 */
export interface MarkdownSlots {
  /** A `<@id>` mention — desktop supplies the users-directory pill + profile card. */
  Mention: ComponentType<{ id: string; groupId?: GroupId }>;
  /** A `:name:` custom emoji — desktop supplies the emoji-map-bound image. */
  Emoji: ComponentType<{ name: string }>;
}

const MarkdownSlotsContext = createContext<MarkdownSlots | null>(null);

/** Provides the mention/emoji token renderers to every {@link MessageMarkdown} below. */
export function MarkdownSlotsProvider({
  slots,
  children,
}: {
  slots: MarkdownSlots;
  children: ReactNode;
}): JSX.Element {
  return <MarkdownSlotsContext.Provider value={slots}>{children}</MarkdownSlotsContext.Provider>;
}

/**
 * Server context for mention pills so a tapped user mention can render that
 * server's roles in the profile card (matches how message avatars pass
 * `profileGroupId`). Undefined outside a server surface (DM / group chat).
 */
const MarkdownGroupContext = createContext<GroupId | undefined>(undefined);

/**
 * Open an auto-linked message link in the user's OS browser.
 *
 * Goes through the shared {@link openExternalUrl} helper, NOT `window.open`: on
 * desktop the window-open handler is an unconditional deny (so an embedded
 * third-party frame cannot use it as a url launcher), and the helper routes to
 * the validated preload verb there while keeping plain `window.open` on web.
 * Non-http(s) hrefs are refused by the helper.
 */
function openExternal(e: React.MouseEvent, href: string): void {
  e.preventDefault();
  openExternalUrl(href);
}

/** A ||spoiler|| — a covered block that reveals its content on click. */
function Spoiler({ children }: { children: React.ReactNode }): JSX.Element {
  const { t } = useTranslation(["common", "desktop"]);
  const [revealed, setRevealed] = useState(false);
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={revealed ? undefined : t("desktop:chat.spoilerReveal")}
      onClick={(e) => {
        if (!revealed) {
          e.stopPropagation();
          setRevealed(true);
        }
      }}
      onKeyDown={(e) => {
        if (!revealed && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          setRevealed(true);
        }
      }}
      className={cn(
        // Covered = an opaque raised block (the text is transparent, so nothing
        // shows through); revealed = the faint wash it keeps as a reminder.
        "rounded-[4px] px-0.5 transition-colors motion-hover",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        revealed
          ? "bg-wash"
          : "cursor-pointer select-none bg-raised text-transparent hover:bg-raised-hover",
      )}
    >
      {children}
    </span>
  );
}

/**
 * A `<@id>` mention token. Delegates to the surface's Mention slot (which owns
 * the store subscription + profile card); without a provider it degrades to the
 * literal `@id` text so the shared renderer never crashes on a missing seam.
 */
function MentionSlot({ id }: { id: string }): JSX.Element {
  const slots = useContext(MarkdownSlotsContext);
  const groupId = useContext(MarkdownGroupContext);
  const Mention = slots?.Mention;
  if (!Mention) return <span>{`@${id}`}</span>;
  return <Mention id={id} groupId={groupId} />;
}

/**
 * A `:name:` custom-emoji token. Delegates to the surface's Emoji slot; without a
 * provider it degrades to the literal `:name:` text (same fallback the desktop
 * emoji token uses for an unknown/deleted name).
 */
function EmojiSlot({ name }: { name: string }): JSX.Element {
  const slots = useContext(MarkdownSlotsContext);
  const Emoji = slots?.Emoji;
  if (!Emoji) return <span>{`:${name}:`}</span>;
  return <Emoji name={name} />;
}

/** Render one inline node (recursively). `key` is positional and stable per render. */
function renderInline(node: MarkdownInline, key: number): React.ReactNode {
  switch (node.type) {
    case "text":
      return <span key={key}>{node.value}</span>;
    case "mention":
      return <MentionSlot key={key} id={node.id} />;
    case "emoji":
      return <EmojiSlot key={key} name={node.name} />;
    case "break":
      return <br key={key} />;
    case "strong":
      return <strong key={key} className="font-semibold text-fg">{renderInlineList(node.children)}</strong>;
    case "em":
      return <em key={key}>{renderInlineList(node.children)}</em>;
    case "strike":
      return <s key={key} className="opacity-90">{renderInlineList(node.children)}</s>;
    case "spoiler":
      return <Spoiler key={key}>{renderInlineList(node.children)}</Spoiler>;
    case "code":
      return (
        <code
          key={key}
          // A white wash, not a surface tone: it must stay visible on the row at
          // rest (base) AND hovered (surface), which share no single safe tone.
          className="rounded-[5px] bg-wash-strong px-1 py-[1px] font-mono text-[0.85em] text-fg"
        >
          {node.value}
        </code>
      );
    case "link":
      return (
        <a
          key={key}
          href={node.href}
          onClick={(e) => openExternal(e, node.href)}
          className="rounded-sm text-accent underline-offset-2 transition-colors motion-hover hover:text-accent-hover hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {node.value}
        </a>
      );
    default:
      return null;
  }
}

function renderInlineList(nodes: MarkdownInline[]): React.ReactNode {
  return nodes.map((n, i) => renderInline(n, i));
}

/** Render one block node. `append` (if given) renders inline after a paragraph's text. */
function renderBlock(block: MarkdownBlock, key: number, append?: React.ReactNode): React.ReactNode {
  switch (block.type) {
    case "paragraph":
      return (
        <p key={key} className="whitespace-pre-wrap break-words">
          {renderInlineList(block.children)}
          {append}
        </p>
      );
    case "blockquote":
      return (
        <blockquote
          key={key}
          // The bar is the quote's only marker, so it is a functional line
          // (Koyu Masa keeps lines only where they carry meaning).
          className="my-0.5 border-l-[3px] border-fg-subtle/60 pl-3 text-fg-muted whitespace-pre-wrap break-words"
        >
          {renderInlineList(block.children)}
        </blockquote>
      );
    case "codeBlock":
      return (
        <pre
          key={key}
          className="my-1 max-w-full overflow-x-auto rounded-lg bg-wash px-3 py-2.5 font-mono text-[0.82em] leading-[1.5] text-fg"
        >
          <code>{block.value}</code>
        </pre>
      );
    default:
      return null;
  }
}

export const MessageMarkdown = memo(function MessageMarkdown({
  content,
  className,
  append,
  groupId,
}: {
  content: string;
  /** Colour/state classes from the row (dimmed while sending, danger on failure). */
  className?: string;
  /** Inline node appended after the message text — the "(edited)" marker. */
  append?: React.ReactNode;
  /** Server context so a mention pill's profile card can show server roles. */
  groupId?: GroupId;
}): JSX.Element {
  const blocks = useMemo(
    () => (hasMarkdown(content) ? parseMessageMarkdown(content) : null),
    [content],
  );

  // Fast path: a plain-text message renders as a single element, byte-identical
  // to the pre-markdown rendering (no token walk, no extra nodes) — §27 perf. A
  // message with a mention always has `<@`, so it never takes this path.
  if (blocks === null) {
    return (
      <p className={cn("select-text whitespace-pre-wrap break-words text-sm leading-[1.45]", className)}>
        {content}
        {append}
      </p>
    );
  }

  // Append the trailing marker inline after the LAST paragraph when possible;
  // otherwise it renders on its own line after the final block.
  const lastIndex = blocks.length - 1;
  const appendInline = append !== undefined && blocks[lastIndex]?.type === "paragraph";
  return (
    <MarkdownGroupContext.Provider value={groupId}>
      <div className={cn("select-text space-y-0.5 text-sm leading-[1.45]", className)}>
        {blocks.map((block, i) =>
          renderBlock(block, i, appendInline && i === lastIndex ? append : undefined),
        )}
        {append !== undefined && !appendInline ? append : null}
      </div>
    </MarkdownGroupContext.Provider>
  );
});
