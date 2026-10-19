import type { ReactNode } from "react";
import { View } from "react-native";
import { Text } from "../ui/Text";
import type { User } from "@demli/types";
import { Avatar } from "../Avatar";
import { ShellRow } from "../home/ShellRow";
import { useChatStore } from "../../stores/chat-store";
import { colors, space } from "../../theme/theme";

/**
 * A person entry (friend / pending request): a presence-dotted avatar + display
 * name + @username, with optional trailing actions. Drawn in the shell's one
 * row language ({@link ShellRow}): no fill at rest, a tone change on press.
 *
 * Presence is read through a per-user selector so a presence tick re-renders
 * only the affected row, never the whole list (CLAUDE.md §27).
 */
export function PersonRow({
  user,
  subtitle,
  onPress,
  onLongPress,
  trailing,
  showPresence = true,
  accessibilityHint,
}: {
  user: User;
  /** Overrides the default `@username` second line. */
  subtitle?: string;
  onPress?: () => void;
  onLongPress?: () => void;
  trailing?: ReactNode;
  showPresence?: boolean;
  accessibilityHint?: string;
}) {
  const presence = useChatStore((s) => s.presence[user.id] ?? "offline");
  const platform = useChatStore((s) => s.presencePlatforms[user.id]);
  return (
    <ShellRow
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={!onPress && !onLongPress}
      accessibilityHint={accessibilityHint}
      minHeight={60}
      style={{ paddingVertical: space.sm }}
    >
      <Avatar
        name={user.displayName}
        size={40}
        uri={user.avatarUrl}
        presence={showPresence ? presence : undefined}
        platform={showPresence ? platform : undefined}
      />
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: colors.fg, fontSize: 15, lineHeight: 20, fontWeight: "500" }}>
          {user.displayName}
        </Text>
        <Text numberOfLines={1} style={{ color: colors.fgFaint, fontSize: 13, lineHeight: 18 }}>
          {subtitle ?? `@${user.username}`}
        </Text>
      </View>
      {trailing}
    </ShellRow>
  );
}
