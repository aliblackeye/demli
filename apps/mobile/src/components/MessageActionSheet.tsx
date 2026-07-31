import { Modal, Pressable, View } from "react-native";
import { Text } from "./ui/Text";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Copy, Pencil, Pin, PinOff, Reply, SmilePlus, Trash2 } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { colors, radius, space } from "../theme/theme";

/**
 * The long-press message action sheet (ADR 0011, M14 W6) — mobile's action
 * pattern in place of desktop's hover buttons. A bottom sheet with the
 * `REACTION_EMOJI` palette (tap → toggle that reaction), a Reply action, plus
 * Edit + Delete on the viewer's OWN messages (Feature A) — the desktop hover
 * dropdown's parity on mobile.
 *
 * Every affordance here is fully wired (CLAUDE.md §35 — no dead buttons). Edit
 * and Delete are shown only when the caller passes `onEdit`/`onDelete` (own
 * messages); the palette is plain unicode, so no native emoji picker is pulled
 * in and the sheet stays OTA-safe.
 */
export function MessageActionSheet({
  visible,
  emojis,
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
  /** The fixed REACTION_EMOJI palette from @demli/config. */
  emojis: readonly string[];
  onReact: (emoji: string) => void;
  /**
   * Open the FULL emoji picker (all unicode + this surface's custom emoji) to
   * react with anything beyond the quick palette (M17 widening). Passed by the
   * caller, which owns the shared EmojiPicker and the current message target.
   */
  onMore?: () => void;
  onReply: () => void;
  /** Copy the message text to the clipboard — passed only when it has text (B2). */
  onCopy?: () => void;
  /**
   * Pin / unpin (M17). Passed ONLY when the viewer is allowed to (author ∨
   * MANAGE_MESSAGES ∨ owner; anyone in a DM / flat group chat) — §35: an
   * unauthorized member must never see an item that would only 403.
   */
  onTogglePin?: () => void;
  /** Whether the target is currently pinned — flips the item's label and icon. */
  pinned?: boolean;
  /** Edit the message — passed only for the viewer's own messages. */
  onEdit?: () => void;
  /** Delete the message — passed only for the viewer's own messages (author-only for now). */
  onDelete?: () => void;
  onClose: () => void;
}) {
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        accessibilityLabel={t("common:buttons.close")}
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" }}
      >
        {/* Card. Its own Pressable swallows taps so they don't dismiss the sheet. */}
        <Pressable
          onPress={() => {}}
          style={{
            backgroundColor: colors.surface,
            borderTopLeftRadius: radius.lg,
            borderTopRightRadius: radius.lg,
            borderCurve: "continuous",
            borderTopWidth: 1,
            borderColor: colors.stroke,
            paddingTop: space.md,
            paddingBottom: space.md + insets.bottom,
            paddingHorizontal: space.md,
            gap: space.xs,
          }}
        >
          {/* Emoji palette — one tap reacts and closes. */}
          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              paddingVertical: space.sm,
            }}
          >
            {emojis.map((emoji) => (
              <Pressable
                key={emoji}
                onPress={() => onReact(emoji)}
                accessibilityRole="button"
                accessibilityLabel={t("mobile:message.reactWith", { emoji })}
                hitSlop={4}
                style={({ pressed }) => ({
                  width: 36,
                  height: 36,
                  borderRadius: radius.pill,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: pressed ? colors.surfaceRaised : "transparent",
                })}
              >
                <Text style={{ fontSize: 24 }}>{emoji}</Text>
              </Pressable>
            ))}
            {/* Open the full picker (all unicode + custom) to react with anything. */}
            {onMore ? (
              <Pressable
                onPress={onMore}
                accessibilityRole="button"
                accessibilityLabel={t("mobile:message.reactMore")}
                hitSlop={4}
                style={({ pressed }) => ({
                  width: 36,
                  height: 36,
                  borderRadius: radius.pill,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: pressed ? colors.surfaceRaised : colors.surfaceRaised,
                })}
              >
                <SmilePlus size={22} color={colors.fgMuted} />
              </Pressable>
            ) : null}
          </View>

          <View style={{ height: 1, backgroundColor: colors.stroke, marginVertical: space.xs }} />

          {/* Reply action. */}
          <Pressable
            onPress={onReply}
            accessibilityRole="button"
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: space.md,
              paddingVertical: space.md,
              paddingHorizontal: space.sm,
              borderRadius: radius.md,
              borderCurve: "continuous",
              backgroundColor: pressed ? colors.surfaceRaised : "transparent",
            })}
          >
            <Reply size={20} color={colors.fgMuted} />
            <Text style={{ color: colors.fg, fontSize: 15, fontWeight: "600" }}>
              {t("mobile:message.reply")}
            </Text>
          </Pressable>

          {/* Copy text — shown only when the message has text content (B2). */}
          {onCopy ? (
            <Pressable
              onPress={onCopy}
              accessibilityRole="button"
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: space.md,
                paddingVertical: space.md,
                paddingHorizontal: space.sm,
                borderRadius: radius.md,
                borderCurve: "continuous",
                backgroundColor: pressed ? colors.surfaceRaised : "transparent",
              })}
            >
              <Copy size={20} color={colors.fgMuted} />
              <Text style={{ color: colors.fg, fontSize: 15, fontWeight: "600" }}>
                {t("mobile:message.copyText")}
              </Text>
            </Pressable>
          ) : null}

          {/* Pin / unpin (M17) — shown only to someone allowed to pin here. */}
          {onTogglePin ? (
            <Pressable
              onPress={onTogglePin}
              accessibilityRole="button"
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: space.md,
                paddingVertical: space.md,
                paddingHorizontal: space.sm,
                borderRadius: radius.md,
                borderCurve: "continuous",
                backgroundColor: pressed ? colors.surfaceRaised : "transparent",
              })}
            >
              {pinned ? (
                <PinOff size={20} color={colors.fgMuted} />
              ) : (
                <Pin size={20} color={colors.fgMuted} />
              )}
              <Text style={{ color: colors.fg, fontSize: 15, fontWeight: "600" }}>
                {pinned ? t("mobile:pins.unpin") : t("mobile:pins.pin")}
              </Text>
            </Pressable>
          ) : null}

          {/* Edit — own messages only (author-only server-side). */}
          {onEdit ? (
            <Pressable
              onPress={onEdit}
              accessibilityRole="button"
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: space.md,
                paddingVertical: space.md,
                paddingHorizontal: space.sm,
                borderRadius: radius.md,
                borderCurve: "continuous",
                backgroundColor: pressed ? colors.surfaceRaised : "transparent",
              })}
            >
              <Pencil size={20} color={colors.fgMuted} />
              <Text style={{ color: colors.fg, fontSize: 15, fontWeight: "600" }}>
                {t("mobile:message.edit")}
              </Text>
            </Pressable>
          ) : null}

          {/* Delete — own messages only (confirm handled by the caller). */}
          {onDelete ? (
            <Pressable
              onPress={onDelete}
              accessibilityRole="button"
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: space.md,
                paddingVertical: space.md,
                paddingHorizontal: space.sm,
                borderRadius: radius.md,
                borderCurve: "continuous",
                backgroundColor: pressed ? colors.surfaceRaised : "transparent",
              })}
            >
              <Trash2 size={20} color={colors.danger} />
              <Text style={{ color: colors.danger, fontSize: 15, fontWeight: "600" }}>
                {t("mobile:message.delete")}
              </Text>
            </Pressable>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
