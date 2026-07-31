import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { Text } from "../ui/Text";
import type { User } from "@demli/types";
import { Avatar } from "../Avatar";
import { useChatStore } from "../../stores/chat-store";
import { colors, radius, space } from "../../theme/theme";

/**
 * A person entry (friend / pending request / DM) on the raised surface: a
 * presence-dotted avatar + display name + @username, with optional trailing
 * action buttons. Presence is read through a per-user selector so a presence
 * tick re-renders only the affected row, never the whole list (CLAUDE.md §27).
 */
export function PersonRow({
  user,
  subtitle,
  onPress,
  onLongPress,
  trailing,
  showPresence = true,
}: {
  user: User;
  /** Overrides the default `@username` second line. */
  subtitle?: string;
  onPress?: () => void;
  onLongPress?: () => void;
  trailing?: ReactNode;
  showPresence?: boolean;
}) {
  const presence = useChatStore((s) => s.presence[user.id] ?? "offline");
  const platform = useChatStore((s) => s.presencePlatforms[user.id]);
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
      <Avatar
        name={user.displayName}
        size={44}
        uri={user.avatarUrl}
        presence={showPresence ? presence : undefined}
        platform={showPresence ? platform : undefined}
      />
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: colors.fg, fontSize: 15, fontWeight: "600" }}>
          {user.displayName}
        </Text>
        <Text numberOfLines={1} style={{ color: colors.fgMuted, fontSize: 13 }}>
          {subtitle ?? `@${user.username}`}
        </Text>
      </View>
      {trailing}
    </Pressable>
  );
}
