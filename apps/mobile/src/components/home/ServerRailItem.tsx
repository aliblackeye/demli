import { memo, useEffect, useState, type ReactNode } from "react";
import { View } from "react-native";
import { Image } from "expo-image";
import Animated, {
  ReduceMotion,
  ZoomIn,
  ZoomOut,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { unreadBadgeText } from "@demli/client-core";
import { motionTo, useReducedMotion } from "@/theme/motion";
import { PRESS } from "@/theme/motion-presets";
import { avatarTileSolid } from "@/theme/avatar-color";
import { colors, motion, radius } from "../../theme/theme";
import { Text } from "../ui/Text";
import { Touchable } from "../ui/Touchable";
import { RAIL_PILL, railPillKind } from "./shell-math";
import { UnreadCountBadge } from "./UnreadCountBadge";

/** Fixed rail column width (≈72px per the founder's spec). */
export const RAIL_WIDTH = 72;
/** Per-item cell height — tile + breathing room for the edge pill. */
const CELL_HEIGHT = 56;
/** Rail tile: 48px rounded square (desktop GroupRail: rounded-xl tile). */
export const RAIL_TILE = 48;

/**
 * The rail's edge pill (desktop `RailPill`): a 4px bar on the rail's left edge
 * whose HEIGHT says the state — 36 coral when selected, 8 white when unread, 0
 * otherwise. Height and colour ride the authored position spring, so a
 * selection change reads as the pill growing into its tile while the old one
 * shrinks away; nothing overshoots. Drawn as `scaleY` on the UI thread.
 */
function RailPill({ selected, unread }: { selected: boolean; unread: boolean }) {
  const reduced = useReducedMotion();
  const kind = railPillKind(selected, unread);
  const size = useSharedValue<number>(RAIL_PILL[kind]);
  const coral = useSharedValue(selected ? 1 : 0);

  useEffect(() => {
    size.value = motionTo(RAIL_PILL[kind], "position", { reduced });
    coral.value = motionTo(selected ? 1 : 0, "tone", { reduced });
  }, [kind, selected, reduced, size, coral]);

  const style = useAnimatedStyle(() => ({
    transform: [{ scaleY: size.value / RAIL_PILL.selected }],
    backgroundColor: interpolateColor(coral.value, [0, 1], [colors.fg, colors.accent]),
  }));

  return (
    <Animated.View
      pointerEvents="none"
      importantForAccessibility="no"
      style={[
        {
          position: "absolute",
          left: 0,
          top: (CELL_HEIGHT - RAIL_PILL.selected) / 2,
          width: 4,
          height: RAIL_PILL.selected,
          borderTopRightRadius: radius.pill,
          borderBottomRightRadius: radius.pill,
        },
        style,
      ]}
    />
  );
}

/**
 * A server's rail face: its icon over a seeded-colour tile with its initials.
 * The icon sits ON the initials, so a slow or dead URL degrades to the initials
 * instead of a blank tile; a failed load is remembered per URL (a new icon right
 * after an upload is retried). Same fallback contract as `Avatar`, in the rail's
 * rounded-square shape.
 */
export function ServerTile({ name, iconUrl }: { name: string; iconUrl: string | null | undefined }) {
  const reduced = useReducedMotion();
  const uri = iconUrl?.trim() ? iconUrl.trim() : null;
  const [failed, setFailed] = useState<string | null>(null);
  const showImage = uri !== null && failed !== uri;
  const words = name.trim().split(/\s+/).filter(Boolean);
  const initials =
    words.length === 0
      ? "?"
      : words.length === 1
        ? (words[0] ?? "?").slice(0, 2).toUpperCase()
        : `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`.toUpperCase();
  return (
    <View
      style={{
        width: RAIL_TILE,
        height: RAIL_TILE,
        borderRadius: radius.xl,
        borderCurve: "continuous",
        overflow: "hidden",
        backgroundColor: avatarTileSolid(name),
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text
        selectable={false}
        variant="display"
        style={{ color: colors.fgDisplay, fontSize: 16, fontWeight: "600" }}
      >
        {initials}
      </Text>
      {showImage ? (
        <Image
          source={{ uri }}
          cachePolicy="memory-disk"
          transition={reduced ? 0 : motion.duration.fast}
          contentFit="cover"
          onError={() => setFailed(uri)}
          style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
          accessibilityIgnoresInvertColors
        />
      ) : null}
    </View>
  );
}

/**
 * One rail entry: a 48px rounded-square tile (a server's icon, the Home mark,
 * or a utility glyph).
 *
 * Signals, in the desktop rail's one language:
 *   - SELECTED → the tall coral edge pill.
 *   - UNREAD   → the short white edge pill, plus a count on the tile's corner
 *                (coral when a direct @mention waits). Uncounted unread reads
 *                "1+" — no fake number (`unreadBadgeText`).
 *   - PRESS    → the tile gives (scale .92 on the press spring) — the rail's
 *                tactile "this is a button", transform-only.
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
  accessibilityHint,
  tileTone,
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
  accessibilityHint?: string;
  /** Tile fill under the children (utility tiles); servers paint their own. */
  tileTone?: string;
  children: ReactNode;
}) {
  const badgeText = unreadBadgeText(count, unread || mention);

  return (
    <View
      style={{ width: RAIL_WIDTH, height: CELL_HEIGHT, alignItems: "center", justifyContent: "center" }}
    >
      <RailPill selected={active} unread={unread || mention} />

      <Touchable
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        accessibilityLabel={
          badgeText ? `${accessibilityLabel}, ${badgeText}` : accessibilityLabel
        }
        accessibilityHint={accessibilityHint}
        onPress={onPress}
        onLongPress={onLongPress}
        tone={tileTone}
        pressedTone={tileTone ? colors.raisedHover : undefined}
        pressScale={PRESS.scale.icon}
        hitSlop={4}
        style={{
          width: RAIL_TILE,
          height: RAIL_TILE,
          borderRadius: radius.xl,
          borderCurve: "continuous",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {children}
      </Touchable>

      {/* Unread COUNT — on the tile's bottom-right corner, cut out of the tile
          by a 3px ring of the rail's black. */}
      {badgeText ? (
        <Animated.View
          entering={ZoomIn.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
          exiting={ZoomOut.duration(motion.duration.instant).reduceMotion(ReduceMotion.System)}
          pointerEvents="none"
          style={{
            position: "absolute",
            right: 4,
            bottom: 0,
            borderRadius: radius.pill,
            borderWidth: 3,
            borderColor: colors.rail,
          }}
        >
          <UnreadCountBadge text={badgeText} tone={mention ? "accent" : "neutral"} />
        </Animated.View>
      ) : null}
    </View>
  );
});
