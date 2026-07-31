import { memo, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { unreadBadgeText } from "@demli/client-core";
import { colors, radius } from "../../theme/theme";
import { UnreadCountBadge } from "./UnreadCountBadge";

/** Fixed rail column width (≈72px per the founder's spec). */
export const RAIL_WIDTH = 72;
/** Per-item cell height — avatar + breathing room for the selection pill. */
const CELL_HEIGHT = 60;
const AVATAR = 48;
const RING = 54;

/**
 * One rail entry: a 48px circular glyph (a server avatar or the Home icon).
 *
 * Two independent signals, matching the founder/UI-overhaul spec:
 *   - SELECTED → an accent 4px left pill + a 2px accent ring around the avatar.
 *   - UNREAD   → a small dot badge on the avatar's corner (neutral, or accent
 *                when a direct @mention is waiting) — this is the "new message"
 *                indicator the founder found missing.
 *
 * Memoized so a selection change re-renders only the two items whose `active`
 * flips — not the whole rail (CLAUDE.md §27). Presentation only; all data lives
 * in ServerRail.
 */
export const ServerRailItem = memo(function ServerRailItem({
  active,
  unread = false,
  mention = false,
  count = 0,
  onPress,
  onLongPress,
  accessibilityLabel,
  children,
}: {
  active: boolean;
  /** Neutral unread waiting → badge (unless a mention upgrades it to accent). */
  unread?: boolean;
  /** Unread includes a direct @mention → accent badge. */
  mention?: boolean;
  /** Counted unread total for this server (#110); 0/absent falls back to "1+". */
  count?: number;
  onPress: () => void;
  onLongPress?: () => void;
  accessibilityLabel: string;
  children: ReactNode;
}) {
  const badgeText = unreadBadgeText(count, unread || mention);

  return (
    <View
      style={{ width: RAIL_WIDTH, height: CELL_HEIGHT, alignItems: "center", justifyContent: "center" }}
    >
      {/* Selection pill (accent) — the active-server indicator. */}
      {active ? (
        <View
          style={{
            position: "absolute",
            left: 0,
            top: (CELL_HEIGHT - 40) / 2,
            width: 4,
            height: 40,
            borderTopRightRadius: 4,
            borderBottomRightRadius: 4,
            backgroundColor: colors.accent,
          }}
        />
      ) : null}

      {/* Accent ring around the selected avatar. */}
      {active ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            width: RING,
            height: RING,
            borderRadius: RING / 2,
            borderWidth: 2,
            borderColor: colors.accent,
          }}
        />
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        accessibilityLabel={accessibilityLabel}
        onPress={onPress}
        onLongPress={onLongPress}
        hitSlop={4}
        style={({ pressed }) => ({
          width: AVATAR,
          height: AVATAR,
          borderRadius: radius.pill,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.surfaceRaised,
          overflow: "hidden",
          opacity: pressed ? 0.7 : 1,
        })}
      >
        {children}
      </Pressable>

      {/* Unread COUNT badge — sits on the avatar's bottom-right corner, outside
          the clipped Pressable so it is never cut off. A 2px app-colored ring
          "cuts" it out of the avatar (the old dot's look), and a mention makes it
          accent. When unread but never counted it honestly reads "1+". */}
      {badgeText ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            right: 6,
            bottom: 2,
            borderRadius: radius.pill,
            borderWidth: 2,
            borderColor: colors.app,
          }}
        >
          <UnreadCountBadge text={badgeText} tone={mention ? "accent" : "neutral"} />
        </View>
      ) : null}
    </View>
  );
});
