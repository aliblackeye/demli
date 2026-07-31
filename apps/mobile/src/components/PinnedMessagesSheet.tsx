import { useState } from "react";
import { ActivityIndicator, FlatList, Modal, Pressable, View } from "react-native";
import { Text } from "./ui/Text";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Pin, PinOff } from "lucide-react-native";
import { PINS_MAX_PER_CHANNEL } from "@demli/config";
import { ApiClientError, friendlyErrorMessage } from "@demli/client-core";
import type { ChannelId, GroupId, PinnedMessage } from "@demli/types";
import { useAppTranslation, type AppTFunction } from "@/lib/i18n";
import { requestMessageJump } from "../lib/message-jump";
import { canPinMessage, useCanManageMessages } from "../lib/pin-permissions";
import { usePins, useTogglePin } from "../queries/chat-queries";
import { useAuthStore } from "../stores/auth-store";
import { useChatStore } from "../stores/chat-store";
import { colors, radius, space, typography } from "../theme/theme";
import { MessageMarkdown } from "./MessageMarkdown";

/**
 * User-facing text for a failed pin/unpin.
 *
 * `PINS_FULL` is deliberately NOT part of `ApiClientErrorCode` (it stays additive
 * server-side), so the code is compared as a runtime string. Everything else
 * collapses to one honest sentence — the user cannot act on the difference.
 */
export function pinErrorText(err: unknown, t: AppTFunction): string {
  const code = err instanceof ApiClientError ? (err.code as string) : null;
  if (code === "PINS_FULL" || code === "CONFLICT") {
    return t("mobile:pins.full", { max: PINS_MAX_PER_CHANNEL });
  }
  if (code === "FORBIDDEN" || code === "NETWORK" || code === "UNAUTHORIZED") {
    return friendlyErrorMessage(err);
  }
  return t("mobile:pins.error");
}

/**
 * The channel's pin board as a bottom sheet (M17) — mobile's answer to the
 * desktop header popover.
 *
 * The list query is `enabled` only while the sheet is VISIBLE (§27), so a
 * channel whose pins are never opened never issues the request; the realtime
 * `message.pinned`/`unpinned` fold already invalidates the cache, so an open
 * sheet updates live. Tapping an entry closes the sheet and asks the thread to
 * scroll to that message through the module-level jump seam.
 */
export function PinnedMessagesSheet({
  visible,
  channelId,
  serverGroupId,
  onClose,
}: {
  visible: boolean;
  channelId: ChannelId;
  /** Server context (roles) — null/undefined for a DM or flat group chat. */
  serverGroupId?: GroupId;
  onClose: () => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();
  const { data: pins, isPending, error } = usePins(channelId, visible);
  // Hoisted once for the whole board (§27) — never per pinned row.
  const canManageMessages = useCanManageMessages(serverGroupId ?? null);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        accessibilityLabel={t("common:buttons.close")}
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" }}
      >
        <Pressable
          onPress={() => {}}
          style={{
            maxHeight: "72%",
            backgroundColor: colors.surface,
            borderTopLeftRadius: radius.lg,
            borderTopRightRadius: radius.lg,
            borderCurve: "continuous",
            borderTopWidth: 1,
            borderColor: colors.stroke,
            paddingBottom: insets.bottom,
          }}
        >
          <View style={{ alignItems: "center", paddingTop: space.sm, paddingBottom: space.xs }}>
            <View
              style={{
                width: 40,
                height: 4,
                borderRadius: radius.pill,
                backgroundColor: colors.strokeStrong,
              }}
            />
          </View>

          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: space.sm,
              paddingHorizontal: space.md,
              paddingBottom: space.sm,
            }}
          >
            <Pin size={16} color={colors.fgFaint} />
            <Text style={{ color: colors.fg, fontSize: 15, fontWeight: "700" }}>
              {t("mobile:pins.title")}
            </Text>
            {pins && pins.length > 0 ? (
              <Text style={{ marginLeft: "auto", color: colors.fgFaint, fontSize: 12 }}>
                {t("mobile:pins.count", { count: pins.length })}
              </Text>
            ) : null}
          </View>

          <View style={{ height: 1, backgroundColor: colors.stroke }} />

          {isPending ? (
            <View style={{ paddingVertical: space.xl, alignItems: "center" }}>
              <ActivityIndicator color={colors.fgFaint} />
            </View>
          ) : error ? (
            <Text
              style={{
                color: colors.danger,
                fontSize: 14,
                textAlign: "center",
                paddingVertical: space.xl,
                paddingHorizontal: space.md,
              }}
            >
              {friendlyErrorMessage(error)}
            </Text>
          ) : (pins?.length ?? 0) === 0 ? (
            <Text
              style={{
                color: colors.fgMuted,
                fontSize: 14,
                textAlign: "center",
                paddingVertical: space.xl,
                paddingHorizontal: space.md,
              }}
            >
              {t("mobile:pins.empty")}
            </Text>
          ) : (
            <FlatList
              data={pins}
              keyExtractor={(pin) => pin.message.id}
              contentContainerStyle={{ paddingBottom: space.md }}
              renderItem={({ item }) => (
                <PinnedRow
                  pin={item}
                  channelId={channelId}
                  serverGroupId={serverGroupId}
                  canManageMessages={canManageMessages}
                  onJump={() => {
                    onClose();
                    requestMessageJump(item.message.id);
                  }}
                />
              )}
            />
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** One entry on the board: author, body, who pinned it, and a gated unpin. */
function PinnedRow({
  pin,
  channelId,
  serverGroupId,
  canManageMessages,
  onJump,
}: {
  pin: PinnedMessage;
  channelId: ChannelId;
  serverGroupId?: GroupId;
  canManageMessages: boolean;
  onJump: () => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const author = useChatStore((s) => s.users[pin.message.authorId]);
  const pinner = useChatStore((s) => s.users[pin.pinnedBy]);
  const currentUserId = useAuthStore((s) => s.user?.id);
  const toggle = useTogglePin(channelId);
  const [error, setError] = useState<string | null>(null);

  const canUnpin = canPinMessage(canManageMessages, pin.message.authorId, currentUserId);
  const name = author?.displayName ?? author?.username ?? t("mobile:chat.unknownAuthor");
  const pinnedByName = pinner?.displayName ?? pinner?.username ?? t("mobile:chat.unknownAuthor");

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: space.sm,
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
        borderBottomWidth: 1,
        borderBottomColor: colors.stroke,
      }}
    >
      <Pressable
        onPress={onJump}
        accessibilityRole="button"
        accessibilityLabel={t("mobile:pins.jumpTo")}
        style={{ flex: 1 }}
      >
        <Text style={{ color: colors.fg, fontSize: 13, fontWeight: "700" }}>{name}</Text>
        <View style={{ marginTop: 2 }}>
          <MessageMarkdown content={pin.message.content} groupId={serverGroupId} />
        </View>
        <Text style={{ marginTop: 4, color: colors.fgFaint, fontSize: typography.size["2xs"] }}>
          {t("mobile:pins.pinnedBy", { name: pinnedByName })}
        </Text>
        {error ? (
          <Text style={{ marginTop: 2, color: colors.danger, fontSize: typography.size["2xs"] }}>{error}</Text>
        ) : null}
      </Pressable>

      {/* §35: no dead affordance — the unpin only exists for someone allowed to. */}
      {canUnpin ? (
        <Pressable
          onPress={() => {
            setError(null);
            toggle.mutate(
              { messageId: pin.message.id, pinned: true },
              { onError: (err) => setError(pinErrorText(err, t)) },
            );
          }}
          disabled={toggle.isPending}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t("mobile:pins.unpin")}
          style={{ padding: space.xs, opacity: toggle.isPending ? 0.5 : 1 }}
        >
          <PinOff size={16} color={colors.fgFaint} />
        </Pressable>
      ) : null}
    </View>
  );
}
