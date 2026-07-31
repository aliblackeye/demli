import { Animated, Pressable, View } from "react-native";
import { Text } from "./ui/Text";
import { Pin, Reply } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { haptics } from "@/lib/haptics";
import type {
  Attachment,
  ChannelId,
  MessageEmbed,
  MessageReactionSummary,
  PresenceStatus,
} from "@demli/types";
import { Avatar } from "./Avatar";
import { Button } from "./Button";
import { MessageAttachments } from "./attachments/MessageAttachments";
import { MessageEmbeds } from "./MessageEmbeds";
import { MessageMarkdown } from "./MessageMarkdown";
import { MessageReactions } from "./MessageReactions";
import { colors, radius, space, typography } from "../theme/theme";
import { useArrivalStyle } from "../theme/motion";

export type DeliveryState = "sent" | "sending" | "failed";

/** The quoted-message preview shown above a reply (ADR 0011 §2). */
export interface ReplyPreviewProps {
  /** Resolved author name of the quoted message (from the users directory). */
  authorName: string;
  /** Trimmed quoted content; ignored when `deleted`. */
  content: string;
  /** Quoted message is soft-deleted → render the "deleted" stub. */
  deleted: boolean;
  /** Tap to scroll to the target, when it is on a loaded page. */
  onPress?: () => void;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * One chat row: avatar + author + timestamp + content. Optimistic rows dim while
 * "sending" and turn into a retry/discard affordance on "failed" (CLAUDE.md §26
 * — failed sends must not corrupt the list).
 *
 * Message body is rendered by {@link MessageMarkdown} from the SHARED tokenizer
 * (@demli/client-core) — bold/italic/strike/code/spoiler/quote
 * with auto-linked URLs, formatting identically to desktop (ADR 0002 parity).
 *
 * Message enrichment (ADR 0011): a reply renders its quoted-message preview
 * above the author row; aggregated reaction pills render below the content; and
 * a long-press opens the action sheet (react / reply / edit / delete). Long-press
 * is the action gesture, so the content is not `selectable` — the sheet, not OS
 * text-select, is how you act on a message.
 *
 * Grouping (audit B1): when `grouped`, this is a continuation of the same
 * author's run — the avatar/name/timestamp header is hidden and the row hangs
 * under the same author column with tighter spacing, mirroring the desktop
 * MessageRow's `isContinuation` compaction.
 */
export function MessageBubble({
  authorName,
  authorAvatarUrl,
  authorColor,
  content,
  createdAt,
  edited = false,
  presence,
  delivery = "sent",
  grouped = false,
  onRetry,
  onDiscard,
  channelId,
  attachments,
  embeds,
  reactions,
  reply,
  onLongPress,
  onPressAuthor,
  onLongPressAuthor,
  onToggleReaction,
  mentionGroupId,
  mentioned = false,
  pinned = false,
  queueNote,
  failureNote,
  canRetry = true,
  arriving = false,
}: {
  authorName: string;
  authorAvatarUrl?: string | null;
  /** Author's highest colored role (ADR 0007), or omit for the default color. */
  authorColor?: string | null;
  content: string;
  createdAt: string;
  /** Message was edited (row's `updatedAt` set) → render the "(edited)" marker. */
  edited?: boolean;
  presence?: PresenceStatus;
  delivery?: DeliveryState;
  /**
   * Continuation row (audit B1): hide the avatar/name/timestamp header and
   * tighten the vertical gap so consecutive same-author messages read as one
   * group. The first message of a run passes `false` and keeps the full header.
   */
  grouped?: boolean;
  onRetry?: () => void;
  onDiscard?: () => void;
  /** Required when the message carries attachments (signed-URL scope). */
  channelId?: ChannelId;
  /** Attachment metadata (ADR 0008) — tiles render below the text. */
  attachments?: Attachment[];
  /** Link-preview cards (M17) — rendered below the text/attachments. */
  embeds?: MessageEmbed[];
  /** Aggregated reaction summary (ADR 0011 §1) — pills render below the content. */
  reactions?: MessageReactionSummary[];
  /** Quoted-message preview when this message is a reply (ADR 0011 §2). */
  reply?: ReplyPreviewProps;
  /** Long-press opens the action sheet; omitted for outbox / system rows. */
  onLongPress?: () => void;
  /**
   * Tap the author avatar OR name to open their profile (audit A2). Omitted for
   * rows where the author is unresolvable. The avatar/name become their own
   * Pressables so this never conflicts with the row's long-press action sheet.
   */
  onPressAuthor?: () => void;
  /**
   * Long-press the author avatar OR name to open the USER action sheet (the
   * mobile twin of desktop's right-click-on-a-name menu). Deliberately a
   * separate gesture target from the row's own long-press: the bubble's long
   * press acts on the MESSAGE, this one acts on the PERSON, and conflating them
   * would make "delete message" and "ban user" the same gesture.
   */
  onLongPressAuthor?: () => void;
  /** Toggle a reaction (add ⇄ remove) from a pill tap. */
  onToggleReaction?: (emoji: string, reactedByMe: boolean) => void;
  /** Server context threaded into a tapped mention's profile (server channels). */
  mentionGroupId?: string;
  /** This message mentions the current user → subtle accent-wash emphasis. */
  mentioned?: boolean;
  /** Message is on the channel's pin board (M17) → small marker above the text. */
  pinned?: boolean;
  /**
   * Offline queue (M17): "waiting to send" line for a `queued` row. It is NOT a
   * failure — the message simply has not left the device yet — so it renders as
   * a calm faint note, never in the danger box.
   */
  queueNote?: string;
  /** Localized failure reason for a `failed` row (falls back to the generic copy). */
  failureNote?: string;
  /**
   * False when retrying is pointless (the channel is gone), which hides the
   * Retry button — §35: never show a button that cannot work.
   */
  canRetry?: boolean;
  /**
   * This message landed moments ago → play the "arrival" motion. Derived by
   * ChatThread from the message's own timestamp (never from mount), so a row
   * scrolling back into the FlatList window does not replay it.
   */
  arriving?: boolean;
}) {
  const { t } = useAppTranslation();
  const failed = delivery === "failed";
  // Fade + settle for a just-arrived row. Frozen at mount and a no-op (a plain
  // resting style, zero animations scheduled) for every historical message, so
  // scrolling a long thread costs nothing extra.
  const arrivalStyle = useArrivalStyle(arriving);
  return (
    <Animated.View style={arrivalStyle}>
    <Pressable
      // Medium tap when the action menu opens (context-menu convention).
      onLongPress={
        onLongPress
          ? () => {
              haptics.medium();
              onLongPress();
            }
          : undefined
      }
      disabled={!onLongPress}
      delayLongPress={260}
      style={{
        flexDirection: "row",
        gap: space.md,
        paddingHorizontal: space.lg,
        // A full top gap separates a new author group; continuation rows sit
        // snug beneath the first message of the run (audit B1).
        paddingTop: grouped ? 2 : space.sm,
        paddingBottom: 2,
        opacity: delivery === "sending" ? 0.6 : 1,
        // "This message mentions you" emphasis — a faint accent wash + left bar.
        backgroundColor: mentioned ? colors.accentSurface : undefined,
        borderLeftWidth: mentioned ? 2 : 0,
        borderLeftColor: colors.accent,
      }}
    >
      {grouped ? (
        // Spacer keeps continuation content hanging under the author column.
        <View style={{ width: 38 }} />
      ) : (
        <Pressable
          onPress={onPressAuthor}
          onLongPress={onLongPressAuthor}
          disabled={!onPressAuthor && !onLongPressAuthor}
          accessibilityRole={onPressAuthor ? "button" : undefined}
          accessibilityLabel={onPressAuthor ? t("mobile:userProfile.openA11y") : undefined}
          accessibilityHint={onLongPressAuthor ? t("mobile:userMenu.moreActions") : undefined}
          hitSlop={4}
        >
          <Avatar name={authorName} size={38} presence={presence} uri={authorAvatarUrl} />
        </Pressable>
      )}
      <View style={{ flex: 1, gap: 2 }}>
        {reply ? (
          <Pressable
            onPress={reply.onPress}
            disabled={!reply.onPress}
            accessibilityRole={reply.onPress ? "button" : undefined}
            style={{ flexDirection: "row", alignItems: "center", gap: space.xs, marginBottom: 1 }}
          >
            <Reply size={12} color={colors.fgFaint} />
            <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 12, color: colors.fgMuted }}>
              <Text style={{ fontWeight: "600", color: colors.fgMuted }}>{reply.authorName}</Text>
              {"  "}
              {reply.deleted ? (
                <Text style={{ color: colors.fgFaint, fontStyle: "italic" }}>
                  {t("mobile:message.replyDeleted")}
                </Text>
              ) : (
                <Text style={{ color: colors.fgFaint }}>{reply.content}</Text>
              )}
            </Text>
          </Pressable>
        ) : null}
        {grouped ? null : (
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Pressable
              onPress={onPressAuthor}
              onLongPress={onLongPressAuthor}
              disabled={!onPressAuthor && !onLongPressAuthor}
              accessibilityRole={onPressAuthor ? "button" : undefined}
              accessibilityLabel={onPressAuthor ? t("mobile:userProfile.openA11y") : undefined}
              accessibilityHint={onLongPressAuthor ? t("mobile:userMenu.moreActions") : undefined}
              hitSlop={4}
              style={{ flexShrink: 1 }}
            >
              <Text
                numberOfLines={1}
                style={{ color: authorColor ?? colors.fg, fontSize: 14, fontWeight: "700" }}
              >
                {authorName}
              </Text>
            </Pressable>
            <Text style={{ flexShrink: 0, color: colors.fgFaint, fontSize: typography.size["2xs"] }}>
              {formatTime(createdAt)}
            </Text>
            {delivery === "sending" ? (
              <Text style={{ flexShrink: 0, color: colors.fgFaint, fontSize: typography.size["2xs"] }}>
                {`· ${t("mobile:message.sending")}`}
              </Text>
            ) : null}
          </View>
        )}
        {pinned ? (
          <View
            style={{ flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 2 }}
            accessibilityLabel={t("mobile:pins.title")}
          >
            <Pin size={11} color={colors.fgFaint} />
            <Text style={{ color: colors.fgFaint, fontSize: typography.size["2xs"], fontWeight: "600" }}>
              {t("mobile:pins.title")}
            </Text>
          </View>
        ) : null}
        {content.length > 0 ? (
          <MessageMarkdown
            content={content}
            groupId={mentionGroupId}
            append={
              edited ? (
                <Text style={{ color: colors.fgFaint, fontSize: typography.size["2xs"] }}>
                  {"  "}
                  {t("mobile:message.edited")}
                </Text>
              ) : undefined
            }
          />
        ) : null}
        {channelId && attachments && attachments.length > 0 ? (
          <MessageAttachments
            channelId={channelId}
            attachments={attachments}
            muted={delivery !== "sent"}
          />
        ) : null}
        {embeds && embeds.length > 0 ? <MessageEmbeds embeds={embeds} /> : null}
        {queueNote ? (
          <Text style={{ marginTop: 2, color: colors.fgFaint, fontSize: typography.size["2xs"] }}>{queueNote}</Text>
        ) : null}
        {reactions && reactions.length > 0 && onToggleReaction ? (
          <MessageReactions reactions={reactions} onToggle={onToggleReaction} />
        ) : null}
        {failed ? (
          <View
            style={{
              marginTop: space.xs,
              gap: space.sm,
              borderRadius: radius.sm,
              borderCurve: "continuous",
              backgroundColor: colors.dangerSurface,
              padding: space.sm,
            }}
          >
            <Text style={{ color: colors.danger, fontSize: 12 }}>
              {failureNote ?? t("mobile:message.failed")}
            </Text>
            <View style={{ flexDirection: "row", gap: space.sm }}>
              {canRetry ? (
                <Button
                  label={t("buttons.retry")}
                  variant="ghost"
                  onPress={onRetry}
                  style={{ minHeight: 34, flex: 1 }}
                />
              ) : null}
              <Button
                label={t("mobile:message.discard")}
                variant="danger"
                onPress={onDiscard}
                style={{ minHeight: 34, flex: 1 }}
              />
            </View>
          </View>
        ) : null}
      </View>
    </Pressable>
    </Animated.View>
  );
}
