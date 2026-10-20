import { memo } from "react";
import { View } from "react-native";
import { Text } from "../ui/Text";
import { unreadBadgeText } from "@demli/client-core";
import type { User, UserId } from "@demli/types";
import { useAppTranslation } from "../../lib/i18n";
import { dmPreviewText, dmRelativeTime, type LastMessagePreview } from "../../lib/dm-preview";
import { useChatStore } from "../../stores/chat-store";
import { colors, space, typography } from "../../theme/theme";
import { Avatar } from "../Avatar";
import { ShellRow, shellRowInk } from "../home/ShellRow";
import { UnreadCountBadge } from "../home/UnreadCountBadge";

/**
 * A rich Direct-Message row for the Home list: presence-dotted avatar + display
 * name + last-message preview + a compact relative time. Falls back to
 * `@username` when there is no preview yet (the API only attaches one once the
 * DM has a message).
 *
 * Drawn in the shell's one row language ({@link ShellRow}): no fill at rest, a
 * tone change on press, and when messages wait the name and preview lift to
 * full ink, the white edge pip appears and the count sits on the right.
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
    <ShellRow
      unread={unread}
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={!onPress && !onLongPress}
      minHeight={64}
      accessibilityHint={onLongPress ? t("mobile:home.longPressOptionsA11y") : undefined}
      style={{ paddingVertical: space.sm }}
    >
      <Avatar name={user.displayName} size={44} uri={user.avatarUrl} presence={presence} platform={platform} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text
          numberOfLines={1}
          style={{ color: unread ? colors.fgDisplay : colors.fg, fontSize: 15, lineHeight: 20, fontWeight: unread ? "600" : "500" }}
        >
          {user.displayName}
        </Text>
        <Text
          numberOfLines={1}
          style={{ color: shellRowInk({ unread }), fontSize: 13, lineHeight: 18, fontWeight: unread ? "500" : "400" }}
        >
          {subtitle}
        </Text>
      </View>
      <View style={{ alignItems: "flex-end", gap: space.xs }}>
        {time ? (
          <Text
            style={{
              color: unread ? colors.fg : colors.fgFaint,
              fontSize: typography.size["2xs"],
              lineHeight: 14,
              fontWeight: "500",
              fontVariant: ["tabular-nums"],
            }}
          >
            {time}
          </Text>
        ) : null}
        {badgeText ? (
          <UnreadCountBadge text={badgeText} a11yLabel={t("mobile:group.unreadA11y")} />
        ) : null}
      </View>
    </ShellRow>
  );
}

export const DmRow = memo(DmRowImpl);
