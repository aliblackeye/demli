/**
 * Overlapping avatar stack — the mobile twin of packages/ui `AvatarGroup`:
 * −30% overlap, each avatar wearing the 2px surface ring that separates it
 * from its neighbour, and a "+N" disc when there are more people than fit.
 *
 * Read as ONE image with the caller's label ("Ali, Burak ve 3 kişi daha") —
 * TalkBack should not walk six circles one by one.
 */
import { View } from "react-native";
import { Avatar } from "../Avatar";
import { colors, radius } from "@/theme/theme";
import { Text } from "./Text";

export type StackPerson = { id: string; name: string; avatarUrl: string | null | undefined };

export function AvatarStack({
  people,
  max = 4,
  size = 28,
  ringColor = colors.app,
  label,
}: {
  people: readonly StackPerson[];
  /** Avatars drawn before the "+N" disc. */
  max?: number;
  size?: number;
  /** The surface behind the stack, so the separating rings disappear into it. */
  ringColor?: string;
  /** The whole stack's spoken form. */
  label: string;
}) {
  const shown = people.slice(0, max);
  const rest = people.length - shown.length;
  const overlap = Math.round(size * 0.3);
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      style={{ flexDirection: "row", alignItems: "center", paddingLeft: 2 }}
    >
      {shown.map((p, i) => (
        <View key={p.id} style={{ marginLeft: i === 0 ? 0 : -overlap, zIndex: shown.length - i }}>
          <Avatar name={p.name} uri={p.avatarUrl} size={size} ring ringColor={ringColor} />
        </View>
      ))}
      {rest > 0 ? (
        <View
          style={{
            marginLeft: -overlap,
            width: size + 4,
            height: size + 4,
            borderRadius: radius.pill,
            backgroundColor: ringColor,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <View
            style={{
              width: size,
              height: size,
              borderRadius: radius.pill,
              backgroundColor: colors.surfaceRaised,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text
              selectable={false}
              style={{
                color: colors.fg,
                fontSize: Math.max(10, Math.round(size * 0.36)),
                fontWeight: "600",
                fontVariant: ["tabular-nums"],
              }}
            >
              {`+${rest > 99 ? 99 : rest}`}
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}
