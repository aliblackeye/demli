import { useEffect, useState } from "react";
import { View } from "react-native";
import { Copy, Pencil, Pin, PinOff, Reply, SmilePlus, Trash2 } from "lucide-react-native";
import { replyPreviewText } from "@demli/client-core";
import { Text } from "./ui/Text";
import { Touchable } from "./ui/Touchable";
import { Sheet } from "./ui/Sheet";
import { ActionDivider, ActionRow } from "./ui/ActionSheet";
import { Button } from "./ui/Button";
import { PRESS } from "../theme/motion-presets";
import { Avatar } from "./Avatar";
import { useAppTranslation } from "@/lib/i18n";
import { colors, radius, space } from "../theme/theme";

/** What the sheet shows of the message it acts on. */
export interface MessageSheetPreview {
  authorName: string;
  authorAvatarUrl: string | null | undefined;
  content: string;
}

/**
 * The long-press message action sheet (ADR 0011, M14 W6) — mobile's action
 * pattern in place of desktop's hover toolbar, on the kit's draggable Sheet
 * (spring open, drag/flick to dismiss, back button, reduced motion).
 *
 * Top to bottom: WHICH message (author + first lines, so you never act on the
 * wrong one), the quick reactions (the ones you already left are coral and a
 * tap removes them), then the actions. Delete does not fire from the menu: it
 * turns the same sheet into a confirm step showing the message once more, with
 * the destructive button last — one surface, no system alert.
 *
 * Every affordance here is fully wired (CLAUDE.md §35 — no dead buttons). Copy,
 * pin, edit and delete render only when the caller passes their handler (the
 * caller owns the permission rules).
 */
export function MessageActionSheet({
  visible,
  preview,
  emojis,
  myReactions,
  onReact,
  onMore,
  onReply,
  onCopy,
  onTogglePin,
  pinned = false,
  onEdit,
  onDelete,
  onClose,
}: {
  visible: boolean;
  /** The message being acted on; the sheet's header. */
  preview: MessageSheetPreview | null;
  /** The fixed REACTION_EMOJI palette from @demli/config. */
  emojis: readonly string[];
  /** Emoji the viewer already reacted with on this message (drawn selected). */
  myReactions?: ReadonlySet<string>;
  onReact: (emoji: string) => void;
  /** Open the FULL emoji picker (all unicode + this surface's custom emoji). */
  onMore?: () => void;
  onReply: () => void;
  /** Copy the message text to the clipboard — passed only when it has text (B2). */
  onCopy?: () => void;
  /** Pin / unpin (M17) — passed ONLY when the viewer is allowed to (§35). */
  onTogglePin?: () => void;
  /** Whether the target is currently pinned — flips the row's label and icon. */
  pinned?: boolean;
  /** Edit the message — passed only for the viewer's own messages. */
  onEdit?: () => void;
  /** Delete the message, AFTER the in-sheet confirm — own messages only. */
  onDelete?: () => void;
  onClose: () => void;
}) {
  const { t } = useAppTranslation();
  const [confirming, setConfirming] = useState(false);
  // Closing resets to the menu, so the next open never starts on a left-over
  // confirm. (Not keyed on `preview`: that object is rebuilt on every thread
  // render, and a message arriving mid-confirm must not throw the step away.
  // The card that slides out is the frozen copy, so this reset is invisible.)
  useEffect(() => {
    if (!visible) setConfirming(false);
  }, [visible]);

  const snippet = preview ? replyPreviewText(preview.content, t("mobile:search.attachmentOnly")) : "";

  const header = preview ? (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: space.md,
        marginHorizontal: space.xs,
        marginBottom: space.sm,
        padding: space.md,
        borderRadius: radius.xl,
        borderCurve: "continuous",
        backgroundColor: colors.surface,
      }}
    >
      <Avatar name={preview.authorName} size={28} uri={preview.authorAvatarUrl} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text type="label" tone="default" numberOfLines={1} style={{ fontWeight: "600" }}>
          {preview.authorName}
        </Text>
        <Text type="meta" tone="muted" numberOfLines={confirming ? 6 : 2} style={{ fontWeight: "400", lineHeight: 17 }}>
          {snippet}
        </Text>
      </View>
    </View>
  ) : null;

  if (confirming && onDelete) {
    return (
      <Sheet
        visible={visible}
        onClose={onClose}
        title={t("mobile:message.deleteConfirmTitle")}
        description={t("mobile:message.deleteConfirmBody")}
        contentPadding={space.sm}
        footer={
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <Button
              label={t("buttons.cancel")}
              variant="secondary"
              onPress={() => setConfirming(false)}
              style={{ flex: 1 }}
            />
            <Button
              label={t("buttons.delete")}
              variant="danger"
              icon={Trash2}
              haptic="medium"
              onPress={onDelete}
              style={{ flex: 1 }}
            />
          </View>
        }
      >
        {header}
      </Sheet>
    );
  }

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      accessibilityLabel={t("mobile:chat.actionsA11y")}
      contentPadding={space.sm}
    >
      {header}
      {/* Quick reactions — one tap reacts (or un-reacts) and closes. */}
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          paddingHorizontal: space.xs,
          paddingBottom: space.sm,
        }}
      >
        {emojis.map((emoji) => {
          const mine = myReactions?.has(emoji) ?? false;
          return (
            <Touchable
              key={emoji}
              onPress={() => onReact(emoji)}
              haptic="selection"
              tone={mine ? colors.accentSurface : colors.surface}
              pressedTone={mine ? colors.accentSurfaceStrong : colors.surfaceRaised}
              pressScale={PRESS.scale.icon}
              accessibilityRole="button"
              accessibilityState={{ selected: mine }}
              accessibilityLabel={t("mobile:message.reactWith", { emoji })}
              style={{
                width: 44,
                height: 44,
                borderRadius: radius.pill,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text style={{ fontSize: 22, lineHeight: 28 }}>{emoji}</Text>
            </Touchable>
          );
        })}
        {onMore ? (
          <Touchable
            onPress={onMore}
            tone={colors.surface}
            pressedTone={colors.surfaceRaised}
            pressScale={PRESS.scale.icon}
            accessibilityRole="button"
            accessibilityLabel={t("mobile:message.reactMore")}
            style={{
              width: 44,
              height: 44,
              borderRadius: radius.pill,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <SmilePlus size={20} color={colors.fgMuted} />
          </Touchable>
        ) : null}
      </View>

      <ActionRow
        icon={<Reply size={20} color={colors.fgMuted} />}
        label={t("mobile:message.reply")}
        onPress={onReply}
      />
      {onCopy ? (
        <ActionRow
          icon={<Copy size={20} color={colors.fgMuted} />}
          label={t("mobile:message.copyText")}
          onPress={onCopy}
        />
      ) : null}
      {onTogglePin ? (
        <ActionRow
          icon={
            pinned ? (
              <PinOff size={20} color={colors.fgMuted} />
            ) : (
              <Pin size={20} color={colors.fgMuted} />
            )
          }
          label={pinned ? t("mobile:pins.unpin") : t("mobile:pins.pin")}
          onPress={onTogglePin}
        />
      ) : null}
      {onEdit ? (
        <ActionRow
          icon={<Pencil size={20} color={colors.fgMuted} />}
          label={t("mobile:message.edit")}
          onPress={onEdit}
        />
      ) : null}
      {onDelete ? (
        <>
          <ActionDivider />
          <ActionRow
            icon={<Trash2 size={20} color={colors.danger} />}
            label={t("mobile:message.delete")}
            labelColor={colors.danger}
            onPress={() => setConfirming(true)}
          />
        </>
      ) : null}
    </Sheet>
  );
}
