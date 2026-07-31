import { memo } from "react";
import { Pressable, View } from "react-native";
import { Text } from "../ui/Text";
import { unreadBadgeText } from "@demli/client-core";
import type { User, UserId } from "@demli/types";
import { useAppTranslation } from "../../lib/i18n";
import { dmPreviewText, dmRelativeTime, type LastMessagePreview } from "../../lib/dm-preview";
import { useChatStore } from "../../stores/chat-store";
import { colors, radius, space, typography } from "../../theme/theme";
import { Avatar } from "../Avatar";
import { UnreadCountBadge } from "../home/UnreadCountBadge";

/**
 * A rich Direct-Message row for the Home list (mobile redesign):
 * presence-dotted avatar + display name + last-message preview + a compact
 * relative time. Falls back to `@username` when there is no preview yet (the API
 * only attaches one once the DM has a message).
 *
 * Presence is read through a per-user selector so a presence tick re-renders only
 * the affected row, never the whole list (CLAUDE.md §27); the component is
 * memoized so an unrelated list update (another row's message) skips it too.
 */
function DmRowImpl({
  user,
  preview,
  meId,
  unread = false,
  unreadCount = 0,
  onPress,
  onLongPress,
}: {
  user: User;
  preview?: LastMessagePreview | null;
  meId: UserId | null;
  /** Unread messages waiting on this DM (bolds the name + shows a trailing badge). */
  unread?: boolean;
  /** Counted unread total (#110); 0/absent with `unread` falls back to "1+". */
  unreadCount?: number;
  onPress?: () => void;
  onLongPress?: () => void;
}) {
  const { t } = useAppTranslation();
  const presence = useChatStore((s) => s.presence[user.id] ?? "offline");
  const platform = useChatStore((s) => s.presencePlatforms[user.id]);
  const badgeText = unreadBadgeText(unreadCount, unread);

  const previewText = dmPreviewText(preview, user.displayName, meId, t);
  const subtitle = previewText ?? `@${user.username}`;
  const time = preview ? dmRelativeTime(preview.createdAt, t) : "";

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={!onPress && !onLongPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        paddingHorizontal: space.lg,
        paddingVertical: space.md,
        borderRadius: radius.md,
        borderCurve: "continuous",
        backgroundColor: pressed ? colors.surfaceRaised : colors.surface,
      })}
    >
      <Avatar name={user.displayName} size={46} uri={user.avatarUrl} presence={presence} platform={platform} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: colors.fg, fontSize: 15, fontWeight: unread ? "800" : "600" }}>
          {user.displayName}
        </Text>
        <Text
          numberOfLines={1}
          style={{ color: unread ? colors.fg : colors.fgMuted, fontSize: 13, fontWeight: unread ? "600" : "400" }}
        >
          {subtitle}
        </Text>
      </View>
      <View style={{ alignItems: "flex-end", gap: 5 }}>
        {time ? (
          <Text style={{ color: colors.fgFaint, fontSize: typography.size["2xs"], fontVariant: ["tabular-nums"] }}>{time}</Text>
        ) : null}
        {badgeText ? (
          <UnreadCountBadge text={badgeText} a11yLabel={t("mobile:group.unreadA11y")} />
        ) : null}
      </View>
    </Pressable>
  );
}

export const DmRow = memo(DmRowImpl);
