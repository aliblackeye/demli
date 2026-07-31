import { cn } from "@demli/ui";
import type { MarkdownSlots } from "@demli/app-ui";
import { MENTION_EVERYONE, MENTION_HERE } from "@demli/protocol";
import type { GroupId } from "@demli/types";
import { useAppTranslation } from "../lib/i18n";
import { useAuthStore } from "../stores/auth-store";
import { useChatStore } from "../stores/chat-store";
import { ProfileCard } from "./ProfileCard";
import { useCustomEmojiUrlMap } from "./CustomEmojiContext";

/**
 * Desktop slot implementations for the shared {@link MessageMarkdown} (Phase 1).
 * The pure markdown structure lives in @demli/app-ui; these two tokens keep
 * their store/profile-card coupling — and their fine-grained per-token
 * subscriptions (§27) — here on the desktop side, handed to the shared renderer
 * via {@link markdownSlots}.
 */

/**
 * A `<@id>` mention pill. Resolves the display name from the users directory at
 * render (the content stores only the id, so a rename reflects everywhere). A
 * user mention is clickable — it opens the profile card (reusing the same
 * ProfileCard the avatars use). `@everyone`/`@here` render as a static broadcast
 * pill. A mention of the current user gets a stronger tint ("this is about you").
 */
function MentionPill({ id, groupId }: { id: string; groupId?: GroupId }): JSX.Element {
  const { t } = useAppTranslation();
  const meId = useAuthStore((s) => s.user?.id);
  // Subscribe to only THIS user's directory entry: unrelated user updates keep
  // the same reference and never re-render the pill (CLAUDE.md §27).
  const user = useChatStore((s) => s.users[id]);

  const isBroadcast = id === MENTION_EVERYONE || id === MENTION_HERE;
  const mentionsMe = !isBroadcast && meId === id;
  const label = isBroadcast
    ? `@${id}`
    : `@${user?.displayName ?? user?.username ?? t("desktop:chat.unknownUser")}`;

  const className = cn(
    "mx-[1px] rounded px-1 py-[1px] font-medium text-accent transition-colors",
    mentionsMe ? "bg-accent/25 hover:bg-accent/35" : "bg-accent/15 hover:bg-accent/25",
  );

  if (isBroadcast) {
    return (
      <span className={cn(className, "cursor-default")} data-mention="broadcast">
        {label}
      </span>
    );
  }

  return (
    <ProfileCard userId={id} groupId={groupId}>
      <button
        type="button"
        className={cn(
          className,
          "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
        )}
        data-mention="user"
      >
        {label}
      </button>
    </ProfileCard>
  );
}

/**
 * A `:name:` custom-emoji shortcode (M17). Resolves the name against the active
 * surface's emoji map; an unknown name (never uploaded, or since deleted) falls
 * back to the LITERAL `:name:` text, so a deleted emoji degrades to plain text
 * instead of leaving a broken image in the scrollback.
 *
 * Safety (§28): the only thing taken from user content is `name`, which the
 * tokenizer already bounded to `[a-z0-9_]{2,32}`. The `src` is a signed URL
 * minted by our own API — never anything embedded in the message — and the alt
 * text is a plain text node.
 */
function CustomEmojiToken({ name }: { name: string }): JSX.Element {
  const url = useCustomEmojiUrlMap().get(name);
  if (!url) return <span>{`:${name}:`}</span>;
  return (
    <img
      src={url}
      alt={`:${name}:`}
      title={`:${name}:`}
      draggable={false}
      loading="lazy"
      // Sized to the line box (not a fixed px) so an emoji sits on the text
      // baseline at any font size and never changes the row height.
      className="mx-[1px] inline-block h-[1.375em] w-auto max-w-[6em] select-none object-contain align-[-0.3em]"
    />
  );
}

/**
 * Stable slot object handed to {@link MarkdownSlotsProvider} once at the app root.
 * Module-level so its identity never changes — the shared renderer's `memo` stays
 * intact and each token keeps its own independent subscription/re-render.
 */
export const markdownSlots: MarkdownSlots = {
  Mention: MentionPill,
  Emoji: CustomEmojiToken,
};
