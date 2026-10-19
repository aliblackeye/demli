import { useEffect } from "react";
import { Animated as RNAnimated, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  interpolate,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
  Extrapolation,
  ReduceMotion,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { AlertCircle, Clock, Pin, Reply, RotateCcw } from "lucide-react-native";
import { Text } from "./ui/Text";
import { useAppTranslation } from "@/lib/i18n";
import { haptics } from "@/lib/haptics";
import type {
  Attachment,
  ChannelId,
  MessageEmbed,
  MessageReactionSummary,
  UserId,
} from "@demli/types";
import { Avatar } from "./Avatar";
import { Button } from "./ui/Button";
import { CLEAR, Touchable } from "./ui/Touchable";
import { withAlpha } from "./ui/kit-math";
import { MessageAttachments } from "./attachments/MessageAttachments";
import { MessageEmbeds } from "./MessageEmbeds";
import { MessageMarkdown } from "./MessageMarkdown";
import { MessageReactions } from "./MessageReactions";
import { formatClock } from "./chat/thread-rows";
import { useChatStore } from "../stores/chat-store";
import { PRESS } from "../theme/motion-presets";
import { colors, motion, radius, space, typography } from "../theme/theme";
import { motionTo, useArrivalStyle, useReducedMotion } from "../theme/motion";

export type DeliveryState = "sent" | "sending" | "failed";

/** The quoted-message preview shown above a reply (ADR 0011 §2). */
export interface ReplyPreviewProps {
  /** Resolved author name of the quoted message (from the users directory). */
  authorName: string;
  /** The quoted author's photo for the connector's mini avatar (null = initials). */
  authorAvatarUrl?: string | null;
  /** Trimmed quoted content; ignored when `deleted`. */
  content: string;
  /** Quoted message is soft-deleted → render the "deleted" stub. */
  deleted: boolean;
  /** Tap to scroll to the target, when it is on a loaded page. */
  onPress?: () => void;
}

/** The avatar column: 40px avatar, the content hangs 12px to its right. */
const AVATAR = 40;
const GUTTER = space.md;
/** How far a swipe must travel before letting go replies. */
const SWIPE_REPLY_AT = 56;
/** The mention row's tint — a whisper of coral, the desktop `accent/6%`. */
const MENTION_TINT = withAlpha(colors.accent, 0.06);
/** Hold the jump flash this long before it fades out on the arrival step. */
const FLASH_HOLD_MS = 600;

/**
 * One chat row on the Koyu Masa thread: avatar + author + time + content. No
 * bubble and no border — rows are separated by rhythm, and a press is a tone
 * change only (founder rule: nothing lifts or bounces).
 *
 * Coral appears on a row only when it concerns YOU: a message that mentions you
 * carries a coral edge and tint, a reply target you jumped to flashes coral and
 * fades, your own reactions are coral pills.
 *
 * Gestures, each on its own target so they can never be confused:
 *  - long press the row → the message action sheet (react / reply / copy / …);
 *  - swipe the row RIGHT → reply (the icon fills in at the threshold, with a
 *    tick of haptics; vertical movement fails the swipe first, so scrolling the
 *    thread is untouched). Screen readers get the same as a named action;
 *  - tap / long press the avatar or the name → the profile / the user menu.
 *
 * Optimistic rows: a sending body is drawn faint, a queued one says so calmly,
 * a failed one shows the reason with Retry / Discard (§26 — a failed send never
 * corrupts the list).
 *
 * Presence for the avatar dot is read HERE, per author, so a presence tick
 * re-renders only the rows of that author — never the whole thread (§27).
 */
export function MessageBubble({
  authorId,
  authorName,
  authorAvatarUrl,
  authorColor,
  content,
  createdAt,
  edited = false,
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
  onReply,
  onPressAuthor,
  onLongPressAuthor,
  onToggleReaction,
  onAddReaction,
  mentionGroupId,
  mentioned = false,
  pinned = false,
  highlighted = false,
  queueNote,
  failureNote,
  canRetry = true,
  arriving = false,
}: {
  /** Whose message — drives the avatar's live presence dot. */
  authorId?: UserId;
  authorName: string;
  authorAvatarUrl?: string | null;
  /** Author's highest colored role (ADR 0007), or omit for the default color. */
  authorColor?: string | null;
  content: string;
  createdAt: string;
  /** Message was edited (row's `updatedAt` set) → render the "(edited)" marker. */
  edited?: boolean;
  delivery?: DeliveryState;
  /**
   * Continuation row (audit B1): hide the avatar/name/timestamp header so
   * consecutive same-author messages read as one group.
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
  /** Swipe right (or the screen-reader action) starts a reply to this message. */
  onReply?: () => void;
  /** Tap the author avatar OR name to open their profile (audit A2). */
  onPressAuthor?: () => void;
  /**
   * Long-press the author avatar OR name to open the USER action sheet. A
   * separate target from the row's long press: the row acts on the MESSAGE,
   * this one on the PERSON ("delete message" and "ban user" never share a gesture).
   */
  onLongPressAuthor?: () => void;
  /** Toggle a reaction (add ⇄ remove) from a pill tap. */
  onToggleReaction?: (emoji: string, reactedByMe: boolean) => void;
  /** The trailing "+ emoji" pill after existing reactions → the full picker. */
  onAddReaction?: () => void;
  /** Server context threaded into a tapped mention's profile (server channels). */
  mentionGroupId?: string;
  /** This message mentions the current user → coral edge + tint. */
  mentioned?: boolean;
  /** Message is on the channel's pin board (M17) → small marker above the text. */
  pinned?: boolean;
  /** A jump (reply quote, pin board) just landed here → a coral flash that fades. */
  highlighted?: boolean;
  /** Offline queue (M17): calm "waiting to send" line — not a failure. */
  queueNote?: string;
  /** Localized failure reason for a `failed` row (falls back to the generic copy). */
  failureNote?: string;
  /** False when retrying is pointless (the channel is gone) — §35, no dead button. */
  canRetry?: boolean;
  /**
   * This message landed moments ago → play the "arrival" motion. Derived by
   * ChatThread from the message's own timestamp (never from mount), so a row
   * scrolling back into the FlatList window does not replay it.
   */
  arriving?: boolean;
}) {
  const { t, i18n } = useAppTranslation();
  const reduced = useReducedMotion();
  const failed = delivery === "failed";
  const sending = delivery === "sending";
  // Only a header row draws the avatar, so only a header row subscribes.
  const presence = useChatStore((s) => (grouped || !authorId ? undefined : s.presence[authorId]));
  // Fade + settle for a just-arrived row. Frozen at mount and a no-op for every
  // historical message, so scrolling a long thread costs nothing extra.
  const arrivalStyle = useArrivalStyle(arriving);

  // ── Jump flash ────────────────────────────────────────────────────────────
  const flash = useSharedValue(0);
  useEffect(() => {
    if (!highlighted) return;
    flash.value = 1;
    flash.value = withDelay(
      FLASH_HOLD_MS,
      withTiming(0, {
        duration: motion.duration.arrival * 2,
        reduceMotion: reduced ? ReduceMotion.Always : ReduceMotion.System,
      }),
    );
  }, [highlighted, reduced, flash]);
  const baseTint = mentioned ? MENTION_TINT : CLEAR;
  const tintStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(flash.value, [0, 1], [baseTint, colors.accentSurfaceStrong]),
  }));

  // ── Swipe to reply ────────────────────────────────────────────────────────
  const dx = useSharedValue(0);
  const armed = useSharedValue(false);
  const tick = () => haptics.selection();
  const fireReply = () => onReply?.();
  const swipe = Gesture.Pan()
    .enabled(onReply !== undefined)
    // Only a rightward drag can start it; anything vertical fails it first, so
    // the thread's own scroll keeps every vertical gesture.
    .activeOffsetX(18)
    .failOffsetX(-12)
    .failOffsetY([-12, 12])
    .onUpdate((e) => {
      "worklet";
      const x = Math.max(0, e.translationX);
      // Past the threshold the row resists (quarter speed): it is armed, and
      // pulling further adds nothing.
      dx.value = x <= SWIPE_REPLY_AT ? x : SWIPE_REPLY_AT + (x - SWIPE_REPLY_AT) * 0.25;
      const next = x >= SWIPE_REPLY_AT;
      if (next !== armed.value) {
        armed.value = next;
        if (next) scheduleOnRN(tick);
      }
    })
    .onEnd(() => {
      "worklet";
      if (armed.value) scheduleOnRN(fireReply);
    })
    .onFinalize(() => {
      "worklet";
      armed.value = false;
      dx.value = motionTo(0, "position", { reduced });
    });
  const slideStyle = useAnimatedStyle(() => ({ transform: [{ translateX: dx.value }] }));
  const replyIconStyle = useAnimatedStyle(() => {
    const p = interpolate(dx.value, [8, SWIPE_REPLY_AT], [0, 1], Extrapolation.CLAMP);
    return {
      opacity: p,
      transform: [{ scale: 0.6 + 0.4 * p }],
      backgroundColor: p >= 1 ? colors.accentSurfaceStrong : colors.surface,
    };
  });

  const time = formatClock(createdAt, i18n.language);
  const bodyColor = failed ? colors.fgMuted : sending ? colors.fgFaint : colors.fg;

  const a11yActions = [
    ...(onLongPress ? [{ name: "longpress", label: t("mobile:chat.actionsA11y") }] : []),
    ...(onReply ? [{ name: "reply", label: t("mobile:message.reply") }] : []),
  ];

  return (
    <RNAnimated.View style={arrivalStyle}>
      <View>
        {/* The reply glyph waiting behind the row's left edge. */}
        {onReply ? (
          <Animated.View
            pointerEvents="none"
            style={[
              {
                position: "absolute",
                left: space.lg,
                top: 0,
                bottom: 0,
                justifyContent: "center",
              },
            ]}
          >
            <Animated.View
              style={[
                {
                  width: 32,
                  height: 32,
                  borderRadius: radius.pill,
                  alignItems: "center",
                  justifyContent: "center",
                },
                replyIconStyle,
              ]}
            >
              <Reply size={16} color={colors.accent} />
            </Animated.View>
          </Animated.View>
        ) : null}
        <GestureDetector gesture={swipe}>
          <Animated.View style={[slideStyle, tintStyle]}>
            <Touchable
              onLongPress={
                onLongPress
                  ? () => {
                      // Medium tap when the action menu opens (context-menu convention).
                      haptics.medium();
                      onLongPress();
                    }
                  : undefined
              }
              disabled={!onLongPress && !onReply}
              dimmed={false}
              delayLongPress={260}
              // The wash waits a beat, so a finger that starts a SCROLL never
              // flashes every row it lands on (the Android list-ripple delay).
              unstable_pressDelay={110}
              pressedTone={colors.wash}
              accessibilityHint={onLongPress ? t("mobile:chat.rowHint") : undefined}
              accessibilityActions={a11yActions}
              onAccessibilityAction={(e) => {
                if (e.nativeEvent.actionName === "longpress") onLongPress?.();
                if (e.nativeEvent.actionName === "reply") onReply?.();
              }}
              style={{
                flexDirection: "row",
                gap: GUTTER,
                paddingLeft: space.lg - 2,
                paddingRight: space.lg,
                // A new author group opens with breathing room; continuation rows
                // sit snug beneath the first message of the run (audit B1).
                paddingTop: grouped ? 2 : space.md,
                paddingBottom: 3,
                // Always laid out (transparent at rest) so the mention edge never
                // changes the row's width.
                borderLeftWidth: 2,
                borderLeftColor: mentioned ? colors.accent : "transparent",
              }}
            >
              {grouped ? (
                <View style={{ width: AVATAR }} />
              ) : (
                <View style={{ width: AVATAR, paddingTop: reply ? 22 : 0 }}>
                  <Touchable
                    onPress={onPressAuthor}
                    onLongPress={onLongPressAuthor}
                    disabled={!onPressAuthor && !onLongPressAuthor}
                    dimmed={false}
                    tone={CLEAR}
                    pressedTone={CLEAR}
                    pressScale={PRESS.scale.icon}
                    accessibilityRole={onPressAuthor ? "button" : undefined}
                    accessibilityLabel={onPressAuthor ? t("mobile:userProfile.openA11y") : undefined}
                    accessibilityHint={onLongPressAuthor ? t("mobile:userMenu.moreActions") : undefined}
                    hitSlop={4}
                    style={{ borderRadius: radius.pill }}
                  >
                    <Avatar name={authorName} size={AVATAR} presence={presence} uri={authorAvatarUrl} />
                  </Touchable>
                </View>
              )}
              <View style={{ flex: 1, minWidth: 0 }}>
                {reply ? <ReplyLine reply={reply} /> : null}
                {grouped ? null : (
                  <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm, marginBottom: 1 }}>
                    <Touchable
                      onPress={onPressAuthor}
                      onLongPress={onLongPressAuthor}
                      disabled={!onPressAuthor && !onLongPressAuthor}
                      dimmed={false}
                      tone={CLEAR}
                      pressedTone={colors.wash}
                      accessibilityRole={onPressAuthor ? "button" : undefined}
                      accessibilityLabel={onPressAuthor ? t("mobile:userProfile.openA11y") : undefined}
                      accessibilityHint={onLongPressAuthor ? t("mobile:userMenu.moreActions") : undefined}
                      hitSlop={6}
                      style={{ flexShrink: 1, borderRadius: radius.sm, marginHorizontal: -3, paddingHorizontal: 3 }}
                    >
                      <Text
                        numberOfLines={1}
                        style={{
                          color: authorColor ?? colors.fgDisplay,
                          fontSize: 15,
                          lineHeight: 20,
                          fontWeight: "600",
                        }}
                      >
                        {authorName}
                      </Text>
                    </Touchable>
                    <Text
                      style={{
                        flexShrink: 0,
                        color: colors.fgFaint,
                        fontSize: typography.size["2xs"],
                        fontVariant: ["tabular-nums"],
                      }}
                    >
                      {time}
                    </Text>
                    {sending && !queueNote ? (
                      <Text style={{ flexShrink: 0, color: colors.fgFaint, fontSize: typography.size["2xs"] }}>
                        {t("mobile:message.sending")}
                      </Text>
                    ) : null}
                  </View>
                )}
                {pinned ? (
                  <View
                    style={{ flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 2 }}
                    accessibilityLabel={t("mobile:message.pinnedMarker")}
                  >
                    <Pin size={11} color={colors.accent} />
                    <Text type="caption" tone="faint">
                      {t("mobile:message.pinnedMarker")}
                    </Text>
                  </View>
                ) : null}
                {content.length > 0 ? (
                  <MessageMarkdown
                    content={content}
                    groupId={mentionGroupId}
                    color={bodyColor}
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
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 5, marginTop: 3 }}>
                    <Clock size={12} color={colors.fgFaint} />
                    <Text type="caption" tone="faint" style={{ flexShrink: 1 }}>
                      {queueNote}
                    </Text>
                  </View>
                ) : null}
                {reactions && reactions.length > 0 && onToggleReaction ? (
                  <MessageReactions
                    reactions={reactions}
                    onToggle={onToggleReaction}
                    onAdd={onAddReaction}
                  />
                ) : null}
                {failed ? (
                  <View accessibilityRole="alert" style={{ marginTop: space.xs, gap: space.sm }}>
                    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
                      <AlertCircle size={14} color={colors.danger} style={{ marginTop: 1 }} />
                      <Text type="meta" tone="danger" style={{ flexShrink: 1, fontWeight: "400" }}>
                        {failureNote ?? t("mobile:message.failed")}
                      </Text>
                    </View>
                    <View style={{ flexDirection: "row", gap: space.sm }}>
                      {canRetry ? (
                        <Button
                          label={t("buttons.retry")}
                          icon={RotateCcw}
                          variant="secondary"
                          size="sm"
                          haptic="light"
                          onPress={onRetry}
                        />
                      ) : null}
                      <Button label={t("mobile:message.discard")} variant="danger" size="sm" onPress={onDiscard} />
                    </View>
                  </View>
                ) : null}
              </View>
            </Touchable>
          </Animated.View>
        </GestureDetector>
      </View>
    </RNAnimated.View>
  );
}

/**
 * The quoted line above a reply: a thin elbow from the avatar column into the
 * quote, the quoted author's mini avatar, name and first line. Tapping it jumps
 * to the original (and flashes it) when that message is loaded.
 */
function ReplyLine({ reply }: { reply: ReplyPreviewProps }) {
  const { t } = useAppTranslation();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", height: 20, marginBottom: 2 }}>
      {/* The elbow starts at the avatar's centre line and turns into the quote. */}
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: -(AVATAR / 2 + GUTTER) - 1,
          top: 9,
          width: AVATAR / 2 + GUTTER - 4,
          height: 12,
          borderLeftWidth: 2,
          borderTopWidth: 2,
          borderTopLeftRadius: 6,
          borderColor: colors.strokeStrong,
        }}
      />
      <Touchable
        onPress={reply.onPress}
        disabled={!reply.onPress}
        dimmed={false}
        tone={CLEAR}
        pressedTone={colors.wash}
        accessibilityRole={reply.onPress ? "button" : undefined}
        accessibilityLabel={`${t("mobile:message.replyTo", { name: reply.authorName })}: ${
          reply.deleted ? t("mobile:message.replyDeleted") : reply.content
        }`}
        hitSlop={{ top: 8, bottom: 8 }}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          flexShrink: 1,
          borderRadius: radius.sm,
          paddingRight: 4,
        }}
      >
        <Avatar name={reply.authorName} size={16} uri={reply.authorAvatarUrl ?? null} />
        <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: typography.size.sm, lineHeight: 16 }}>
          <Text style={{ fontWeight: "600", color: colors.fgMuted }}>{reply.authorName}</Text>
          {"  "}
          {reply.deleted ? (
            <Text style={{ color: colors.fgFaint, fontStyle: "italic" }}>{t("mobile:message.replyDeleted")}</Text>
          ) : (
            <Text style={{ color: colors.fgFaint }}>{reply.content}</Text>
          )}
        </Text>
      </Touchable>
    </View>
  );
}
