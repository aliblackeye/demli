import { useEffect, useMemo, useRef, useState } from "react";
import {
  Keyboard,
  Platform,
  ScrollView,
  View,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from "react-native";
import Animated, {
  FadeIn,
  FadeInDown,
  FadeOut,
  FadeOutDown,
  LinearTransition,
  ReduceMotion,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { Text, TextInput } from "./ui/Text";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  AtSign,
  Ban,
  Check,
  Pencil,
  Plus,
  Reply,
  SendHorizontal,
  Smile,
  Timer,
  X,
} from "lucide-react-native";
import { ATTACHMENT_MAX_PER_MESSAGE, MESSAGE_MAX_LENGTH } from "@demli/config";
import {
  applyMentionInsert,
  applyMentionPick,
  deserializeMentions,
  detectMentionQuery,
  rankMentionCandidates,
  serializeMentions,
  BROADCAST_MENTION_CANDIDATES,
  type MentionCandidate,
  type PendingMention,
  messagePreviewText,
} from "@demli/client-core";
import { useAppTranslation } from "@/lib/i18n";
import { haptics } from "@/lib/haptics";
import type { ChannelId } from "@demli/types";
import { friendlyErrorMessage, getApi } from "../lib/clients";
import {
  notifyComposerIdle,
  notifyComposerTyping,
  sendChatMessage,
} from "../realtime/connection";
import { addAssetsToChannel, takeReadyAttachments } from "../lib/attachments/manager";
import { onMentionInsert } from "../lib/mention-insert";
import { pickAudioAssets, pickMediaAssets } from "../lib/attachments/pickers";
import { formatSlowmodeInterval } from "../lib/slowmode";
import { useAttachmentStore, type DraftAttachment } from "../stores/attachment-store";
import { useAuthStore } from "../stores/auth-store";
import { useChatStore } from "../stores/chat-store";
import { useDraftStore } from "../stores/draft-store";
import { getDraftText } from "../stores/draft-model";
import { Avatar } from "./Avatar";
import { AttachmentTray } from "./attachments/AttachmentTray";
import { AttachmentSheet } from "./AttachmentSheet";
import { EmojiPicker } from "./EmojiPicker";
import { GifPicker } from "./GifPicker";
import { MicButton, RecordingStrip, useVoiceRecorder } from "./VoiceRecorder";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { Touchable } from "./ui/Touchable";
import { toast } from "./ui/Toast";
import { PRESS } from "../theme/motion-presets";
import { toneTo, useReducedMotion } from "../theme/motion";
import { colors, elevation, motion, radius, space, typography } from "../theme/theme";
import { charsLeft, mentionMatchLength } from "./chat/composer-math";

/** Max mention suggestions shown above the input. */
const MENTION_SUGGESTION_LIMIT = 6;
/** Below this many characters left, the counter appears (desktop: last 200). */
const COUNTER_FROM = 200;
/** …and turns pink here. */
const COUNTER_WARN = 20;

/** Stable empty reference so the zustand selector doesn't churn identities. */
const EMPTY_DRAFTS: DraftAttachment[] = [];

/** A DM with someone the viewer blocked: what the composer says instead. */
export interface ComposerBlockedState {
  name: string;
  onUnblock: () => void;
  busy: boolean;
}

/** Seconds remaining until `until` (epoch ms), or 0 when past/absent. */
function remainingSeconds(until: number | undefined, now: number): number {
  if (until === undefined) return 0;
  return Math.max(0, Math.ceil((until - now) / 1000));
}

/**
 * Countdown while a SLOWMODE cooldown is active; ticks each second and
 * auto-clears at 0. Owns its own 1s timer + store subscription so ticking never
 * rerenders the message list (CLAUDE.md §27).
 */
function SlowmodeBanner({
  channelId,
  slowmodeSeconds,
}: {
  channelId: ChannelId;
  slowmodeSeconds?: number;
}) {
  const { t } = useAppTranslation();
  const until = useChatStore((s) => s.slowmodeUntil[channelId]);
  const clearCooldown = useChatStore((s) => s.clearSlowmodeCooldown);
  const [now, setNow] = useState(() => Date.now());

  const remaining = remainingSeconds(until, now);

  useEffect(() => {
    if (until === undefined) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [until]);

  // Drop the cooldown from the store once it elapses (effect, not render).
  useEffect(() => {
    if (until !== undefined && remaining <= 0) clearCooldown(channelId);
  }, [until, remaining, channelId, clearCooldown]);

  if (remaining > 0) {
    return (
      <View
        accessibilityLiveRegion="polite"
        style={{ flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.xs }}
      >
        <Timer size={13} color={colors.warning} />
        <Text type="meta" tone="warning">
          {t("mobile:composer.slowmodeCooldown", { duration: formatSlowmodeInterval(remaining) })}
        </Text>
      </View>
    );
  }

  if (slowmodeSeconds && slowmodeSeconds > 0) {
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.xs }}>
        <Timer size={13} color={colors.fgFaint} />
        <Text type="meta" tone="faint" style={{ fontWeight: "400" }}>
          {t("mobile:composer.slowmodeActive", { duration: formatSlowmodeInterval(slowmodeSeconds) })}
        </Text>
      </View>
    );
  }

  return null;
}

/** The context strip at the top of the field: replying to / editing. */
function ContextStrip({
  icon,
  tone,
  title,
  detail,
  closeLabel,
  onClose,
}: {
  icon: "reply" | "edit";
  tone: "neutral" | "accent";
  title: string;
  detail?: string;
  closeLabel: string;
  onClose: () => void;
}) {
  const Icon = icon === "reply" ? Reply : Pencil;
  const ink = tone === "accent" ? colors.accent : colors.fgMuted;
  return (
    <Animated.View
      entering={FadeIn.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(motion.duration.instant).reduceMotion(ReduceMotion.System)}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        paddingLeft: space.md,
        paddingRight: space.xs,
        paddingTop: space.xs,
      }}
    >
      <Icon size={14} color={ink} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} type="meta" style={{ color: ink, fontWeight: "600" }}>
          {title}
        </Text>
        {detail ? (
          <Text numberOfLines={1} type="meta" tone="faint" style={{ fontWeight: "400" }}>
            {detail}
          </Text>
        ) : null}
      </View>
      <IconButton icon={X} label={closeLabel} size="sm" onPress={onClose} />
    </Animated.View>
  );
}

/**
 * Message composer — the Koyu Masa composer on the phone: a borderless raised
 * field (radius 18) that steps one tone up and gains the inset pill line when
 * focused; the add button on its left, the send button on its right, emoji
 * inside the field. Replying / editing / pending attachments live INSIDE the
 * field, so what you are about to send is all in one place.
 *
 * Drives the same optimistic-send + typing-notification pipeline as desktop
 * (realtime/connection.ts): throttled typing.start on every keystroke,
 * typing.stop on idle/send. Slow mode shows its interval and any active
 * cooldown above the field.
 *
 * Attachments (ADR 0008): "+" opens the photo/video or audio picker; picked
 * files upload through lib/attachments/manager.ts into the tray with a live
 * percentage. Send is enabled with text OR ≥1 ready attachment, and waits
 * (with a hint) while uploads are in flight — what you see is exactly what sends.
 *
 * States: idle · focused · ready to send · uploading · upload failed (chip +
 * line) · replying · editing (✓ saves) · slow mode / cooldown · near the length
 * cap (counter from 200 left, pink from 20) · blocked DM (notice + unblock).
 */
export function Composer({
  channelId,
  slowmodeSeconds,
  allowBroadcast = true,
  bottomReserve = 0,
  blocked,
}: {
  channelId: ChannelId;
  slowmodeSeconds?: number;
  /** Offer `@everyone`/`@here` in the mention picker (false on DMs). */
  allowBroadcast?: boolean;
  /**
   * Extra bottom space to clear the floating voice mini-bar so it never covers
   * the input. Collapsed while the keyboard is open (the bar hides behind it).
   */
  bottomReserve?: number;
  /** DM with a peer the viewer blocked: notice + unblock instead of the field. */
  blocked?: ComposerBlockedState;
}) {
  const { t } = useAppTranslation();
  const reduced = useReducedMotion();
  // Seed from this stream's saved draft (M17 — unsent messages) so a restored
  // draft is on screen at first paint, before the channel-change effect runs.
  const [text, setText] = useState(() =>
    getDraftText(useDraftStore.getState().drafts, channelId),
  );
  const [emojiPickerVisible, setEmojiPickerVisible] = useState(false);
  const [attachSheetVisible, setAttachSheetVisible] = useState(false);
  const [gifPickerVisible, setGifPickerVisible] = useState(false);
  const insets = useSafeAreaInsets();
  const inputRef = useRef<TextInput>(null);

  // Track the keyboard so the voice-bar reserve applies only when it's closed.
  const [keyboardShown, setKeyboardShown] = useState(false);
  useEffect(() => {
    const showEvt = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvt = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const show = Keyboard.addListener(showEvt, () => setKeyboardShown(true));
    const hide = Keyboard.addListener(hideEvt, () => setKeyboardShown(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  const drafts = useAttachmentStore((s) => s.drafts[channelId]) ?? EMPTY_DRAFTS;

  // Field focus → one tone up + the inset pill line (design system "Composer").
  const focus = useSharedValue(0);
  const [focused, setFocused] = useState(false);
  const fieldStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(focus.value, [0, 1], [colors.surfaceRaised, colors.raisedHover]),
  }));

  // @mention autocomplete. Candidates come from the in-memory users directory
  // (fed by the roster loads — reused, not refetched); picked mentions are
  // remembered as `pendingMentions` and rewritten to `<@id>` on send/edit.
  const meId = useAuthStore((s) => s.user?.id);
  const usersDir = useChatStore((s) => s.users);
  const [pendingMentions, setPendingMentions] = useState<PendingMention[]>([]);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  /**
   * Latest caret / edit-mode, readable from the long-lived mention-insert
   * subscription below without re-subscribing on every keystroke (§27).
   */
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const candidates = useMemo<MentionCandidate[]>(() => {
    const roster = Object.values(usersDir)
      .filter((u) => u.id !== meId)
      .map((u) => ({ id: u.id, label: u.displayName || u.username, username: u.username }));
    return allowBroadcast ? [...BROADCAST_MENTION_CANDIDATES, ...roster] : roster;
  }, [usersDir, meId, allowBroadcast]);

  const mentionQuery = useMemo(
    () => detectMentionQuery(text, selection.end),
    [text, selection.end],
  );
  const suggestions = useMemo(
    () =>
      mentionQuery
        ? rankMentionCandidates(mentionQuery.query, candidates, MENTION_SUGGESTION_LIMIT)
        : [],
    [mentionQuery, candidates],
  );

  // Reply draft (ADR 0011 §2) — only shown for THIS channel's stream.
  const replyDraft = useChatStore((s) => s.replyDraft);
  const clearReplyDraft = useChatStore((s) => s.clearReplyDraft);
  const users = useChatStore((s) => s.users);
  const activeReply = replyDraft?.channelId === channelId ? replyDraft : null;
  const replyAuthorName = activeReply
    ? users[activeReply.preview.authorId]?.displayName ??
      users[activeReply.preview.authorId]?.username ??
      t("mobile:chat.unknownAuthor")
    : "";

  // A reply started from the thread (swipe, sheet) puts the caret in the field.
  const replyId = activeReply?.preview.id;
  useEffect(() => {
    if (replyId) inputRef.current?.focus();
  }, [replyId]);

  // Edit draft (Feature A) — prefills the input and switches send → PATCH. Only
  // for THIS channel's stream, and mutually exclusive with a reply.
  const editDraft = useChatStore((s) => s.editDraft);
  const clearEditDraft = useChatStore((s) => s.clearEditDraft);
  const activeEdit = editDraft?.channelId === channelId ? editDraft : null;
  const isEditing = activeEdit !== null;
  /** Same reason as `selectionRef`: read by the mention-insert subscription. */
  const editingRef = useRef(isEditing);
  editingRef.current = isEditing;

  // Seed the input when an edit starts (or switches target); re-runs only when
  // the edited message id changes, so typing into the edit never re-seeds. The
  // stored `<@id>` mentions are shown as `@Name` and remembered so save can
  // re-serialize them.
  useEffect(() => {
    if (!activeEdit) return;
    const { text: seededText, mentions } = deserializeMentions(
      activeEdit.content,
      (id) => usersDir[id]?.displayName ?? usersDir[id]?.username ?? null,
    );
    setText(seededText);
    setPendingMentions(mentions);
    inputRef.current?.focus();
  }, [activeEdit?.messageId]);

  // Restore this stream's saved draft on enter, and on leave flush the just-typed
  // text into the store before the next stream loads (M17). Skipped while an
  // edit is in progress for this stream — the edit owns the input then.
  useEffect(() => {
    const edit = useChatStore.getState().editDraft;
    if (edit?.channelId !== channelId) {
      setText(getDraftText(useDraftStore.getState().drafts, channelId));
    }
    return () => {
      useDraftStore.getState().flush();
    };
  }, [channelId]);

  const cancelEdit = () => {
    clearEditDraft();
    // Leaving edit mode returns to the stream's own saved draft (usually empty).
    setText(getDraftText(useDraftStore.getState().drafts, channelId));
    setPendingMentions([]);
    notifyComposerIdle(channelId);
  };

  const voice = useVoiceRecorder({
    channelId,
    replyTo: activeReply?.preview,
    onSent: () => {
      if (activeReply) clearReplyDraft();
    },
  });

  const readyCount = drafts.filter((d) => d.status === "ready").length;
  const uploadsPending = drafts.some(
    (d) => d.status === "processing" || d.status === "uploading",
  );
  // While editing, only text matters (edit changes content, not attachments).
  const canSend = isEditing
    ? text.trim().length > 0
    : (text.trim().length > 0 || readyCount > 0) && !uploadsPending;
  const showMic = !isEditing && text.trim().length === 0 && readyCount === 0 && !uploadsPending && !voice.recording;
  const left = charsLeft(text, MESSAGE_MAX_LENGTH);

  const sendTone = useSharedValue(canSend ? 1 : 0);
  useEffect(() => {
    sendTone.value = toneTo(canSend, reduced);
  }, [canSend, reduced, sendTone]);
  const sendStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(sendTone.value, [0, 1], [colors.surfaceRaised, colors.accent]),
  }));

  const onChange = (next: string) => {
    setText(next);
    // Drop any picked mention whose token the user edited away, so it is not
    // re-serialized on send (a mention deleted in the input is a mention gone).
    setPendingMentions((prev) => prev.filter((m) => next.includes(m.token)));
    if (next.trim().length > 0) notifyComposerTyping(channelId);
    else notifyComposerIdle(channelId);
    // Persist as a draft (debounced store-side — no file write per keystroke, §27).
    // Not while editing: that text belongs to the edit, not this stream's draft.
    if (!isEditing) useDraftStore.getState().setDraft(channelId, next);
  };

  const onSelectionChange = (
    e: NativeSyntheticEvent<TextInputSelectionChangeEventData>,
  ) => {
    setSelection(e.nativeEvent.selection);
  };

  /** Insert a tapped mention candidate and remember it for send-serialization. */
  const pickMention = (candidate: MentionCandidate) => {
    if (!mentionQuery) return;
    haptics.selection();
    const res = applyMentionPick(text, mentionQuery.start, selection.end, candidate);
    setText(res.text);
    setPendingMentions((prev) => [...prev, res.pending]);
    setSelection({ start: res.caret, end: res.caret });
    if (!isEditing) useDraftStore.getState().setDraft(channelId, res.text);
  };

  /**
   * "Mention" from the user action sheet (lib/mention-insert). Goes through the
   * SHARED `applyMentionInsert` — the same seam the desktop composer uses — so
   * the token, the trailing space and the remembered `pendingMention` are
   * identical to a typed mention and the message serializes to `<@id>` on send.
   *
   * NOT a bare `applyMentionPick` at the caret, which is the bug this replaced:
   * splicing into a caret glued to a word produces `selam@Ali`, and
   * `serializeMentions` refuses to rewrite an `@` that follows a word character.
   * `applyMentionInsert` adds the separating space when, and only when, the
   * preceding character needs one. State setters are read functionally because
   * this subscription outlives any single render.
   */
  useEffect(() => {
    return onMentionInsert(({ userId, label }) => {
      setText((prev) => {
        const caret = Math.min(selectionRef.current.end, prev.length);
        const res = applyMentionInsert(prev, caret, { id: userId, label });
        setPendingMentions((mentions) => [...mentions, res.pending]);
        selectionRef.current = { start: res.caret, end: res.caret };
        setSelection({ start: res.caret, end: res.caret });
        if (!editingRef.current) useDraftStore.getState().setDraft(channelId, res.text);
        return res.text;
      });
    });
  }, [channelId]);

  /**
   * Insert a picked emoji at the caret (from the emoji picker), advancing the
   * tracked selection so a second pick lands after the first.
   */
  const insertEmoji = (emoji: string) => {
    const start = selection.start;
    const end = selection.end;
    const next = text.slice(0, start) + emoji + text.slice(end);
    setText(next);
    const caret = start + emoji.length;
    setSelection({ start: caret, end: caret });
    notifyComposerTyping(channelId);
    if (!isEditing) useDraftStore.getState().setDraft(channelId, next);
  };

  const onAttach = () => {
    const remaining = ATTACHMENT_MAX_PER_MESSAGE - drafts.length;
    if (remaining <= 0) {
      toast({
        title: t("mobile:attachments.limitTitle"),
        description: t("mobile:attachments.maxPerMessage", { max: ATTACHMENT_MAX_PER_MESSAGE }),
        key: "attach-limit",
      });
      return;
    }
    Keyboard.dismiss();
    setAttachSheetVisible(true);
  };

  const onPickMedia = () => {
    const remaining = ATTACHMENT_MAX_PER_MESSAGE - drafts.length;
    void pickMediaAssets(remaining).then((assets) => {
      if (assets.length > 0) addAssetsToChannel(channelId, assets);
    });
  };

  const onPickAudio = () => {
    void pickAudioAssets().then((assets) => {
      if (assets.length > 0) addAssetsToChannel(channelId, assets);
    });
  };

  const onSend = () => {
    if (!canSend) return;
    // Light tap on send — the outgoing-message confirmation touch.
    haptics.light();
    // Rewrite picked @mentions (`@Name`) to their `<@id>` wire form before send.
    const content = serializeMentions(text, pendingMentions).trim();

    // Edit path (Feature A): PATCH the target instead of sending a new message.
    // The `message.updated` broadcast reconciles the cache (adds "(edited)").
    // An unchanged edit is a silent cancel; a failure surfaces as a toast
    // without corrupting the input.
    if (activeEdit) {
      if (content.length === 0) return;
      const { messageId, content: original } = activeEdit;
      if (content !== original.trim()) {
        void getApi()
          .editMessage(messageId, content)
          .catch((err: unknown) =>
            toast({
              title: t("mobile:message.editError"),
              description: friendlyErrorMessage(err),
              variant: "danger",
            }),
          );
      }
      clearEditDraft();
      setText(getDraftText(useDraftStore.getState().drafts, channelId));
      setPendingMentions([]);
      notifyComposerIdle(channelId);
      return;
    }

    const attachments = takeReadyAttachments(channelId);
    if (content.length === 0 && attachments.length === 0) return;
    const reply = activeReply?.preview;
    sendChatMessage(channelId, content, attachments.length > 0 ? attachments : undefined, reply);
    setText("");
    setPendingMentions([]);
    notifyComposerIdle(channelId);
    if (reply) clearReplyDraft();
    // Sent — drop this stream's draft (M17) and cancel any pending debounced write.
    useDraftStore.getState().clearDraft(channelId);
  };

  const bottomPad = space.sm + insets.bottom + (keyboardShown ? 0 : bottomReserve);

  if (blocked) {
    return (
      <View style={{ paddingHorizontal: space.md, paddingTop: space.xs, paddingBottom: bottomPad }}>
        <View
          accessibilityRole="alert"
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: space.md,
            padding: space.md,
            borderRadius: radius.cta,
            borderCurve: "continuous",
            backgroundColor: colors.surface,
          }}
        >
          <Ban size={18} color={colors.fgMuted} />
          <Text type="meta" tone="muted" style={{ flex: 1, fontWeight: "400", lineHeight: 17 }}>
            {t("mobile:composer.blockedNotice", { name: blocked.name })}
          </Text>
          <Button
            label={t("mobile:composer.unblock")}
            variant="secondary"
            size="sm"
            loading={blocked.busy}
            onPress={blocked.onUnblock}
          />
        </View>
      </View>
    );
  }

  return (
    <View
      style={{
        paddingHorizontal: space.md,
        paddingTop: space.xs,
        // Clear the Android gesture nav bar / iOS home indicator (edge-to-edge),
        // plus room for the floating voice mini-bar when a call is live.
        paddingBottom: bottomPad,
        gap: space.xs,
      }}
    >
      <SlowmodeBanner channelId={channelId} slowmodeSeconds={slowmodeSeconds} />
      {suggestions.length > 0 ? (
        <Animated.View
          entering={FadeInDown.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
          exiting={FadeOutDown.duration(motion.duration.instant).reduceMotion(ReduceMotion.System)}
          style={{
            borderRadius: radius.xl,
            borderCurve: "continuous",
            backgroundColor: colors.surface,
            overflow: "hidden",
            paddingVertical: space.xs,
          }}
        >
          <Text type="caption" tone="faint" style={{ paddingHorizontal: space.md, paddingVertical: 4 }}>
            {t("mobile:composer.mentionHeading")}
          </Text>
          <ScrollView keyboardShouldPersistTaps="always" style={{ maxHeight: 220 }}>
            {suggestions.map((c, index) => {
              const label = c.broadcast ? `@${c.label}` : c.label;
              const matched = mentionMatchLength(c.label, mentionQuery?.query ?? "");
              const offset = c.broadcast ? 1 : 0;
              return (
                <Touchable
                  key={c.id}
                  onPress={() => pickMention(c)}
                  // The best match is the one a tap is most likely aimed at.
                  tone={index === 0 ? colors.wash : undefined}
                  pressedTone={colors.washStrong}
                  accessibilityRole="button"
                  accessibilityLabel={t("mobile:composer.mentionInsert", { name: label })}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: space.md,
                    minHeight: 44,
                    marginHorizontal: space.xs,
                    paddingHorizontal: space.sm,
                    borderRadius: radius.lg,
                  }}
                >
                  {c.broadcast ? (
                    <View
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: radius.pill,
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: colors.accentSurface,
                      }}
                    >
                      <AtSign size={15} color={colors.accent} />
                    </View>
                  ) : (
                    // Non-broadcast candidates are built from `usersDir`, so their
                    // id is always a real user id — read the photo back out.
                    <Avatar name={c.label} size={28} uri={usersDir[c.id]?.avatarUrl ?? null} />
                  )}
                  <Text numberOfLines={1} type="ui" tone="default" style={{ flex: 1 }}>
                    {matched > 0 ? (
                      <>
                        <Text style={{ color: colors.fgDisplay, fontWeight: "600" }}>
                          {label.slice(0, matched + offset)}
                        </Text>
                        {label.slice(matched + offset)}
                      </>
                    ) : (
                      label
                    )}
                  </Text>
                  {c.broadcast ? (
                    <Text type="meta" tone="faint" style={{ fontWeight: "400" }}>
                      {c.id === "everyone"
                        ? t("mobile:composer.mentionEveryoneHint")
                        : t("mobile:composer.mentionHereHint")}
                    </Text>
                  ) : c.username ? (
                    <Text numberOfLines={1} type="meta" tone="faint" style={{ fontWeight: "400", maxWidth: "40%" }}>
                      @{c.username}
                    </Text>
                  ) : null}
                </Touchable>
              );
            })}
          </ScrollView>
        </Animated.View>
      ) : null}
      {voice.recording ? (
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space.sm }}>
          <RecordingStrip
            durationMs={voice.durationMs}
            sending={voice.sending}
            onCancel={voice.cancelRecording}
            onSend={voice.sendRecording}
          />
        </View>
      ) : (
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space.sm }}>
          {isEditing ? null : (
            <IconButton
              icon={Plus}
              label={t("mobile:attachments.addTitle")}
              variant="secondary"
              size="lg"
              haptic="light"
              onPress={onAttach}
            />
          )}
          <Animated.View
            layout={reduced ? undefined : LinearTransition.duration(motion.duration.fast)}
            style={[
              {
                flex: 1,
                minHeight: 48,
                borderRadius: radius.cta,
                borderCurve: "continuous",
                overflow: "hidden",
              },
              focused ? elevation.pillInset : null,
              fieldStyle,
            ]}
          >
            {activeReply ? (
              <ContextStrip
                icon="reply"
                tone="neutral"
                title={t("mobile:composer.replyingTo", { name: replyAuthorName })}
                detail={
                  activeReply.preview.deleted
                    ? t("mobile:message.replyDeleted")
                    : messagePreviewText(
                        activeReply.preview.content,
                        (id) => usersDir[id]?.displayName ?? usersDir[id]?.username ?? t("mobile:chat.unknownAuthor"),
                        t("mobile:search.attachmentOnly"),
                      )
                }
                closeLabel={t("mobile:composer.cancelReply")}
                onClose={clearReplyDraft}
              />
            ) : null}
            {activeEdit ? (
              <ContextStrip
                icon="edit"
                tone="accent"
                title={t("mobile:message.editing")}
                closeLabel={t("mobile:message.cancelEdit")}
                onClose={cancelEdit}
              />
            ) : null}
            {isEditing ? null : (
              <View style={{ paddingHorizontal: space.sm, paddingTop: drafts.length > 0 ? space.sm : 0 }}>
                <AttachmentTray channelId={channelId} />
                {uploadsPending ? (
                  <Text type="caption" tone="faint" style={{ paddingTop: space.xs, paddingHorizontal: space.xs }}>
                    {t("mobile:attachments.uploading")}
                  </Text>
                ) : null}
              </View>
            )}
            <View style={{ flexDirection: "row", alignItems: "flex-end" }}>
              <TextInput
                ref={inputRef}
                value={text}
                onChangeText={onChange}
                onSelectionChange={onSelectionChange}
                onFocus={() => {
                  setFocused(true);
                  focus.value = toneTo(true, reduced);
                }}
                onBlur={() => {
                  setFocused(false);
                  focus.value = toneTo(false, reduced);
                }}
                placeholder={t("mobile:composer.placeholder")}
                placeholderTextColor={colors.fgFaint}
                accessibilityLabel={t("mobile:composer.placeholder")}
                multiline
                maxLength={MESSAGE_MAX_LENGTH}
                style={{
                  flex: 1,
                  maxHeight: 132,
                  minHeight: 48,
                  color: colors.fg,
                  fontSize: 16,
                  lineHeight: 22,
                  paddingLeft: space.lg,
                  paddingRight: space.xs,
                  paddingTop: 13,
                  paddingBottom: 13,
                  textAlignVertical: "center",
                }}
              />
              <View style={{ paddingBottom: 6, paddingRight: 6 }}>
                <IconButton
                  icon={Smile}
                  label={t("mobile:emojiPicker.open")}
                  size="md"
                  onPress={() => {
                    Keyboard.dismiss();
                    setEmojiPickerVisible(true);
                  }}
                />
              </View>
            </View>
          </Animated.View>
          {showMic ? (
            <MicButton onPress={voice.startRecording} />
          ) : (
            <Animated.View style={[{ width: 48, height: 48, borderRadius: radius.pill }, sendStyle]}>
              <Touchable
                onPress={onSend}
                disabled={!canSend}
                dimmed={false}
                pressedTone={colors.washStrong}
                pressScale={PRESS.scale.icon}
                accessibilityRole="button"
                accessibilityLabel={isEditing ? t("buttons.save") : t("mobile:composer.send")}
                accessibilityHint={
                  !canSend && uploadsPending ? t("mobile:attachments.uploading") : undefined
                }
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: radius.pill,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {isEditing ? (
                  <Check size={20} color={canSend ? colors.onAccent : colors.fgSubtle} strokeWidth={2.4} />
                ) : (
                  <SendHorizontal size={20} color={canSend ? colors.onAccent : colors.fgSubtle} />
                )}
              </Touchable>
            </Animated.View>
          )}
        </View>
      )}
      {left <= COUNTER_FROM ? (
        <Text
          accessibilityLiveRegion="polite"
          type="caption"
          style={{
            alignSelf: "flex-end",
            paddingRight: space.xs,
            fontVariant: ["tabular-nums"],
            fontSize: typography.size["2xs"],
            color: left <= COUNTER_WARN ? colors.danger : colors.fgFaint,
          }}
        >
          {t("mobile:composer.charsLeft", { count: left })}
        </Text>
      ) : null}
      <EmojiPicker
        visible={emojiPickerVisible}
        onSelect={insertEmoji}
        onClose={() => setEmojiPickerVisible(false)}
      />
      <AttachmentSheet
        visible={attachSheetVisible}
        onClose={() => setAttachSheetVisible(false)}
        onPickMedia={onPickMedia}
        onPickAudio={onPickAudio}
        onPickGif={() => setGifPickerVisible(true)}
      />
      <GifPicker
        visible={gifPickerVisible}
        channelId={channelId}
        onClose={() => setGifPickerVisible(false)}
      />
    </View>
  );
}
