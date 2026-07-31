import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  View,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from "react-native";
import { Text, TextInput } from "./ui/Text";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AtSign, Check, Paperclip, Pencil, Reply, SendHorizontal, Smile, Timer, X } from "lucide-react-native";
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
  replyPreviewText,
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
import { colors, radius, space } from "../theme/theme";

/** Max mention suggestions shown above the input. */
const MENTION_SUGGESTION_LIMIT = 6;

/** Stable empty reference so the zustand selector doesn't churn identities. */
const EMPTY_DRAFTS: DraftAttachment[] = [];

/** Seconds remaining until `until` (epoch ms), or 0 when past/absent. */
function remainingSeconds(until: number | undefined, now: number): number {
  if (until === undefined) return 0;
  return Math.max(0, Math.ceil((until - now) / 1000));
}

/**
 * Amber countdown while a SLOWMODE cooldown is active; ticks each second and
 * auto-clears at 0. Owns its own 1s timer + store subscription so ticking never
 * rerenders the message list (CLAUDE.md §27) — the composer sits below the list.
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
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
        <Timer size={13} color={colors.idle} />
        <Text style={{ color: colors.idle, fontSize: 12, fontWeight: "600" }}>
          {t("mobile:composer.slowmodeCooldown", { duration: formatSlowmodeInterval(remaining) })}
        </Text>
      </View>
    );
  }

  if (slowmodeSeconds && slowmodeSeconds > 0) {
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
        <Timer size={13} color={colors.fgFaint} />
        <Text style={{ color: colors.fgFaint, fontSize: 12 }}>
          {t("mobile:composer.slowmodeActive", { duration: formatSlowmodeInterval(slowmodeSeconds) })}
        </Text>
      </View>
    );
  }

  return null;
}

/**
 * Message composer. Drives the same optimistic-send + typing-notification
 * pipeline as desktop (realtime/connection.ts): throttled typing.start on every
 * keystroke, typing.stop on idle/send. When the channel has slow mode on, a
 * <SlowmodeBanner> shows the interval and any active post-send cooldown.
 *
 * Attachments (ADR 0008): the paperclip opens the photo/video picker or the
 * audio file picker; picked files upload through lib/attachments/manager.ts
 * into the tray above the input. Send is enabled with text OR ≥1 ready
 * attachment, and waits (with a hint) while uploads are still in flight — what
 * you see in the tray is exactly what sends.
 */
export function Composer({
  channelId,
  slowmodeSeconds,
  allowBroadcast = true,
  bottomReserve = 0,
}: {
  channelId: ChannelId;
  slowmodeSeconds?: number;
  /** Offer `@everyone`/`@here` in the mention picker (false on DMs). */
  allowBroadcast?: boolean;
  /**
   * Extra bottom space to clear the floating voice mini-bar so it never covers
   * the input. Collapsed while the keyboard is open (the bar hides behind it),
   * so typing keeps the input snug against the keyboard.
   */
  bottomReserve?: number;
}) {
  const { t } = useAppTranslation();
  // Seed from this stream's saved draft (M17 — unsent messages) so a
  // restored draft is on screen at first paint, before the channel-change effect runs.
  const [text, setText] = useState(() =>
    getDraftText(useDraftStore.getState().drafts, channelId),
  );
  const [emojiPickerVisible, setEmojiPickerVisible] = useState(false);
  const [attachSheetVisible, setAttachSheetVisible] = useState(false);
  const insets = useSafeAreaInsets();

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

  // Edit draft (Feature A) — prefills the input and switches send → PATCH. Only
  // for THIS channel's stream, and mutually exclusive with a reply (the store
  // clears one when the other starts).
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
  }, [activeEdit?.messageId]);

  // Restore this stream's saved draft on enter, and on leave flush the just-typed
  // text into the store before the next stream loads (M17). The store debounces its
  // persist, so this flush is what guarantees a fast channel switch keeps the draft.
  // Skipped while an edit is in progress for this stream — the edit owns the input
  // then (its own effect above seeds it), and edit text is never a channel draft.
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

  const readyCount = drafts.filter((d) => d.status === "ready").length;
  const uploadsPending = drafts.some(
    (d) => d.status === "processing" || d.status === "uploading",
  );
  // While editing, only text matters (edit changes content, not attachments).
  const canSend = isEditing
    ? text.trim().length > 0
    : (text.trim().length > 0 || readyCount > 0) && !uploadsPending;

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
   * `serializeMentions` refuses to rewrite an `@` that follows a word character
   * (it would turn `mail@host` into a ping). The mention silently degraded to
   * plain text — the user believed they had tagged someone and nobody was
   * tagged. `applyMentionInsert` adds the separating space when, and only when,
   * the preceding character needs one. State setters are read functionally
   * because this subscription outlives any single render.
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
   * Insert a picked emoji at the caret (from the emoji picker). The sheet stays
   * open for consecutive picks, so we advance the tracked selection each time —
   * a second pick lands after the first rather than at the original spot. We
   * don't control the TextInput's `selection` prop (it drifts on Android while
   * typing), so the visible caret settles wherever the user next taps.
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
      Alert.alert(
        t("mobile:attachments.limitTitle"),
        t("mobile:attachments.maxPerMessage", { max: ATTACHMENT_MAX_PER_MESSAGE }),
      );
      return;
    }
    // Founder UX: a themed bottom sheet, not the dated Alert options dialog.
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
    // Rewrite picked @mentions (`@Name`) to their `<@id>` wire form before send
    // (shared serializer). Round-trips edit content unchanged when untouched.
    const content = serializeMentions(text, pendingMentions).trim();

    // Edit path (Feature A): PATCH the target instead of sending a new message.
    // The `message.updated` broadcast reconciles the cache (adds "(edited)"), so
    // we just clear the draft. An unchanged edit is a silent cancel; a failure
    // surfaces as an alert without corrupting the input.
    if (activeEdit) {
      if (content.length === 0) return;
      const { messageId, content: original } = activeEdit;
      if (content !== original.trim()) {
        void getApi()
          .editMessage(messageId, content)
          .catch((err: unknown) =>
            Alert.alert(t("mobile:message.editError"), friendlyErrorMessage(err)),
          );
      }
      clearEditDraft();
      // Leaving edit mode returns to this stream's own saved draft (usually empty);
      // the edit never touched it.
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

  return (
    <View
      style={{
        paddingHorizontal: space.md,
        paddingTop: space.sm,
        // Clear the Android gesture nav bar / iOS home indicator (edge-to-edge),
        // plus room for the floating voice mini-bar when a call is live (dropped
        // while the keyboard is up, where the bar hides behind the keyboard).
        paddingBottom: space.sm + insets.bottom + (keyboardShown ? 0 : bottomReserve),
        borderTopWidth: 1,
        borderTopColor: colors.stroke,
        backgroundColor: colors.surface,
        gap: space.xs,
      }}
    >
      <SlowmodeBanner channelId={channelId} slowmodeSeconds={slowmodeSeconds} />
      {activeReply ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: space.sm,
            paddingVertical: space.xs,
          }}
        >
          <Reply size={14} color={colors.fgFaint} />
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={{ color: colors.fgMuted, fontSize: 12 }}>
              {t("mobile:composer.replyingTo", { name: replyAuthorName })}
            </Text>
            {/*
              The quoted line always renders. Dropping it for a caption-less
              image or a deleted target left the bar naming a person and no
              message, which is the state the bar exists to prevent — the same
              gap the desktop composer had, where the quote was missing outright.
            */}
            <Text numberOfLines={1} style={{ color: colors.fgFaint, fontSize: 12 }}>
              {activeReply.preview.deleted
                ? t("mobile:message.replyDeleted")
                : replyPreviewText(
                    activeReply.preview.content,
                    t("mobile:search.attachmentOnly"),
                  )}
            </Text>
          </View>
          <Pressable
            onPress={clearReplyDraft}
            accessibilityRole="button"
            accessibilityLabel={t("mobile:composer.cancelReply")}
            hitSlop={8}
            style={{ padding: 4 }}
          >
            <X size={16} color={colors.fgMuted} />
          </Pressable>
        </View>
      ) : null}
      {activeEdit ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: space.sm,
            paddingVertical: space.xs,
          }}
        >
          <Pencil size={14} color={colors.accent} />
          <Text style={{ flex: 1, color: colors.accent, fontSize: 12, fontWeight: "600" }}>
            {t("mobile:message.editing")}
          </Text>
          <Pressable
            onPress={cancelEdit}
            accessibilityRole="button"
            accessibilityLabel={t("mobile:message.cancelEdit")}
            hitSlop={8}
            style={{ padding: 4 }}
          >
            <X size={16} color={colors.fgMuted} />
          </Pressable>
        </View>
      ) : null}
      <AttachmentTray channelId={channelId} />
      {uploadsPending && (
        <Text style={{ color: colors.fgFaint, fontSize: 12 }}>
          {t("mobile:attachments.uploading")}
        </Text>
      )}
      {suggestions.length > 0 ? (
        <View
          style={{
            borderWidth: 1,
            borderColor: colors.stroke,
            borderRadius: radius.md,
            borderCurve: "continuous",
            backgroundColor: colors.surfaceRaised,
            overflow: "hidden",
            marginBottom: space.xs,
          }}
        >
          <ScrollView keyboardShouldPersistTaps="always" style={{ maxHeight: 208 }}>
            {suggestions.map((c) => (
              <Pressable
                key={c.id}
                onPress={() => pickMention(c)}
                accessibilityRole="button"
                accessibilityLabel={t("mobile:composer.mentionInsert", {
                  name: c.broadcast ? `@${c.label}` : c.label,
                })}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: space.sm,
                  paddingHorizontal: space.md,
                  paddingVertical: space.sm,
                  backgroundColor: pressed ? colors.surface : "transparent",
                })}
              >
                {c.broadcast ? (
                  <View
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 14,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: colors.accentSurface,
                    }}
                  >
                    <AtSign size={16} color={colors.accent} />
                  </View>
                ) : (
                  // Non-broadcast candidates are built from `usersDir` (see
                  // `candidates` above), so their id is always a real user id —
                  // read the photo back out rather than widening the shared
                  // `MentionCandidate` contract that desktop also consumes.
                  <Avatar name={c.label} size={28} uri={usersDir[c.id]?.avatarUrl ?? null} />
                )}
                <Text
                  numberOfLines={1}
                  style={{ flex: 1, color: colors.fg, fontSize: 14, fontWeight: "600" }}
                >
                  {c.broadcast ? `@${c.label}` : c.label}
                </Text>
                {c.broadcast ? (
                  <Text style={{ color: colors.fgFaint, fontSize: 12 }}>
                    {c.id === "everyone"
                      ? t("mobile:composer.mentionEveryoneHint")
                      : t("mobile:composer.mentionHereHint")}
                  </Text>
                ) : c.username ? (
                  <Text numberOfLines={1} style={{ color: colors.fgFaint, fontSize: 12 }}>
                    @{c.username}
                  </Text>
                ) : null}
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space.sm }}>
        {isEditing ? null : (
          <>
            <Pressable
              onPress={onAttach}
              accessibilityLabel={t("mobile:attachments.addTitle")}
              style={({ pressed }) => ({
                width: 44,
                height: 44,
                borderRadius: radius.lg,
                borderCurve: "continuous",
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: colors.surfaceRaised,
                opacity: pressed ? 0.85 : 1,
              })}
            >
              <Paperclip size={20} color={colors.fgMuted} />
            </Pressable>
            <Pressable
              onPress={() => {
                Keyboard.dismiss();
                setEmojiPickerVisible(true);
              }}
              accessibilityLabel={t("mobile:emojiPicker.open")}
              style={({ pressed }) => ({
                width: 44,
                height: 44,
                borderRadius: radius.lg,
                borderCurve: "continuous",
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: colors.surfaceRaised,
                opacity: pressed ? 0.85 : 1,
              })}
            >
              <Smile size={20} color={colors.fgMuted} />
            </Pressable>
          </>
        )}
        <TextInput
          value={text}
          onChangeText={onChange}
          onSelectionChange={onSelectionChange}
          placeholder={t("mobile:composer.placeholder")}
          placeholderTextColor={colors.fgFaint}
          multiline
          maxLength={MESSAGE_MAX_LENGTH}
          style={{
            flex: 1,
            maxHeight: 120,
            minHeight: 44,
            color: colors.fg,
            fontSize: 15,
            backgroundColor: colors.surfaceRaised,
            borderRadius: radius.lg,
            borderCurve: "continuous",
            paddingHorizontal: space.md,
            paddingTop: space.sm,
            paddingBottom: space.sm,
          }}
        />
        <Pressable
          onPress={onSend}
          disabled={!canSend}
          style={({ pressed }) => ({
            width: 44,
            height: 44,
            borderRadius: radius.lg,
            borderCurve: "continuous",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: canSend ? colors.accent : colors.surfaceRaised,
            opacity: pressed ? 0.85 : 1,
          })}
        >
          {isEditing ? (
            <Check size={20} color={canSend ? colors.onAccent : colors.fgFaint} />
          ) : (
            <SendHorizontal size={20} color={canSend ? colors.onAccent : colors.fgFaint} />
          )}
        </Pressable>
      </View>
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
      />
    </View>
  );
}
