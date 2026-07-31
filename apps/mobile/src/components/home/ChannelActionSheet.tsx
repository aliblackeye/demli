import type { ReactNode } from "react";
import { Modal, Pressable, View } from "react-native";
import { Text } from "../ui/Text";
import {
  BellOff,
  Check,
  ChevronDown,
  ChevronUp,
  FolderInput,
  MessageSquare,
  PhoneOff,
  Volume2,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  channelPlacementMenuItems,
  voiceMenuRoomAction,
  type ChannelPlacementMenuItem,
} from "@demli/client-core";
import type { ChannelId, ChannelKind } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { useChatStore } from "@/stores/chat-store";
import { useVoiceStore } from "@/stores/voice-store";
import { colors, radius, space } from "../../theme/theme";

/** The channel row a long press opened this sheet for. */
export interface ChannelSheetTarget {
  channelId: ChannelId;
  name: string;
  kind: ChannelKind;
  /**
   * Placement facts as of the moment the menu opened (M18). A phone has no
   * drag-and-drop sidebar, so this menu is the ONLY way to reorder a channel or
   * move it between categories — which is why these are computed by the list
   * (which holds the sidebar model) and handed down, rather than re-derived here.
   */
  placement?: {
    /** Viewer is the server owner OR holds MANAGE_CHANNELS. */
    canManageChannels: boolean;
    /** There is a channel above this one inside its own bucket. */
    canMoveUp: boolean;
    /** There is a channel below this one inside its own bucket. */
    canMoveDown: boolean;
    /** At least one other bucket exists to move into. */
    hasOtherBuckets: boolean;
  };
}

/** One tappable row — the same shape as {@link MessageActionSheet}'s entries. */
function SheetRow({
  icon,
  label,
  danger,
  onPress,
}: {
  icon: ReactNode;
  label: string;
  danger?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        minHeight: 44,
        paddingVertical: space.md,
        paddingHorizontal: space.sm,
        borderRadius: radius.md,
        borderCurve: "continuous",
        backgroundColor: pressed ? colors.surfaceRaised : "transparent",
      })}
    >
      {icon}
      <Text
        style={{ color: danger ? colors.danger : colors.fg, fontSize: 15, fontWeight: "600" }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Long-press sheet for a channel row — mobile's parity of the desktop channel
 * context menu, on the same OTA-safe RN `Modal` pattern as
 * {@link MessageActionSheet} (no native sheet module).
 *
 * Both kinds get "Mark as read" and the notification-mute entry. A VOICE channel
 * additionally gets its two room gestures spelled out, because since M20 a voice
 * channel is a room WITH a conversation and the row's tap can only be one of
 * them:
 *
 *   - "Open chat (without joining)" — the keyboard/menu path to what the row's
 *     chat icon does. Reading is a real capability (visibility is the whole
 *     access rule, ADR 0007), so it gets more than one way in (§35).
 *   - Join / Disconnect — mirrors the live session, decided by the SHARED
 *     `voiceMenuRoomAction` rule rather than a second copy of "am I in this one".
 *
 * Disconnect deliberately lives here and not on the row: a "leave" sitting a few
 * pixels from the thing you tap to read would be a mis-tap that ends a call.
 */
export function ChannelActionSheet({
  target,
  onOpenChat,
  onJoinVoice,
  onMute,
  onMove,
  onMoveToCategory,
  onClose,
}: {
  /** The long-pressed channel, or null when the sheet is closed. */
  target: ChannelSheetTarget | null;
  /** Open this channel's conversation WITHOUT touching the voice engine. */
  onOpenChat: (target: ChannelSheetTarget) => void;
  /** Connect to this voice channel's room (voice targets only). */
  onJoinVoice: (target: ChannelSheetTarget) => void;
  /** Hand off to the notification-mute sheet for this channel. */
  onMute: (target: ChannelSheetTarget) => void;
  /** Shift this channel one slot inside its own bucket (M18). */
  onMove?: (target: ChannelSheetTarget, direction: "up" | "down") => void;
  /** Open the destination picker for a cross-bucket move (M18). */
  onMoveToCategory?: (target: ChannelSheetTarget) => void;
  onClose: () => void;
}) {
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();
  const markChannelRead = useChatStore((s) => s.markChannelRead);
  const leaveVoice = useVoiceStore((s) => s.leave);
  const voiceRoomId = useVoiceStore((s) => s.roomId);
  const voiceStatus = useVoiceStore((s) => s.status);

  const isVoice = target?.kind === "voice";
  // Which room entry to offer, read against the live engine at open time.
  const roomAction = target
    ? voiceMenuRoomAction(target.channelId, { voiceRoomId, voiceStatus })
    : "join";

  // WHICH placement entries this viewer may see is the SHARED rule's call, not
  // this component's: a member without MANAGE_CHANNELS gets an empty list and
  // therefore no rows at all, rather than rows the API would refuse (§35).
  const placementItems: ChannelPlacementMenuItem[] = target?.placement
    ? channelPlacementMenuItems(target.placement)
    : [];

  const run = (fn: () => void) => {
    fn();
    onClose();
  };

  return (
    <Modal
      visible={target !== null}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
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
          {/* Grab handle. */}
          <View
            style={{
              alignSelf: "center",
              width: 36,
              height: 4,
              borderRadius: radius.pill,
              backgroundColor: colors.strokeStrong,
              marginBottom: space.xs,
            }}
          />

          <Text
            numberOfLines={1}
            variant="display"
            style={{
              color: colors.fg,
              fontSize: 16,
              fontWeight: "800",
              paddingHorizontal: space.sm,
              paddingBottom: space.xs,
            }}
          >
            {target?.name ?? ""}
          </Text>

          {target && isVoice ? (
            <>
              <SheetRow
                icon={<MessageSquare size={20} color={colors.fgMuted} />}
                label={t("mobile:channel.openChatWithoutJoining")}
                onPress={() => run(() => onOpenChat(target))}
              />
              {roomAction === "leave" ? (
                <SheetRow
                  icon={<PhoneOff size={20} color={colors.danger} />}
                  label={t("mobile:channel.disconnect")}
                  danger
                  onPress={() => run(leaveVoice)}
                />
              ) : (
                <SheetRow
                  icon={<Volume2 size={20} color={colors.fgMuted} />}
                  label={t("mobile:channel.joinVoice")}
                  onPress={() => run(() => onJoinVoice(target))}
                />
              )}
              <View
                style={{ height: 1, backgroundColor: colors.stroke, marginVertical: space.xs }}
              />
            </>
          ) : null}

          {target ? (
            <>
              {/* Applies to every channel that has a message stream — which since
                  M20 includes voice channels. */}
              <SheetRow
                icon={<Check size={20} color={colors.fgMuted} />}
                label={t("mobile:channel.markRead")}
                onPress={() => run(() => markChannelRead(target.channelId))}
              />
              <SheetRow
                icon={<BellOff size={20} color={colors.fgMuted} />}
                label={t("mobile:mute.muteNotifications")}
                onPress={() => run(() => onMute(target))}
              />
            </>
          ) : null}

          {/* Placement (M18). Below the everyday entries because reordering is a
              management act, not something you reach for mid-conversation. */}
          {target && placementItems.length > 0 ? (
            <>
              <View
                style={{ height: 1, backgroundColor: colors.stroke, marginVertical: space.xs }}
              />
              {placementItems.map((item) => {
                if (item === "moveUp" || item === "moveDown") {
                  return (
                    <SheetRow
                      key={item}
                      icon={
                        item === "moveUp" ? (
                          <ChevronUp size={20} color={colors.fgMuted} />
                        ) : (
                          <ChevronDown size={20} color={colors.fgMuted} />
                        )
                      }
                      label={
                        item === "moveUp"
                          ? t("mobile:category.moveUp")
                          : t("mobile:category.moveDown")
                      }
                      onPress={() =>
                        run(() => onMove?.(target, item === "moveUp" ? "up" : "down"))
                      }
                    />
                  );
                }
                return (
                  <SheetRow
                    key={item}
                    icon={<FolderInput size={20} color={colors.fgMuted} />}
                    label={t("mobile:category.moveToCategory")}
                    onPress={() => run(() => onMoveToCategory?.(target))}
                  />
                );
              })}
            </>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
