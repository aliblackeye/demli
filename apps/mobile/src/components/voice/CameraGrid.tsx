import { useMemo, useState } from "react";
import type { LayoutChangeEvent, ViewStyle } from "react-native";
import { ScrollView, View } from "react-native";
import { useAppTranslation } from "@/lib/i18n";
import { space } from "@/theme/theme";
import { ParticipantTile, type ParticipantTileData } from "./ParticipantTile";

const GAP = space.sm;

/** Columns for the FILL regime (≤ 4 tiles), driven by count + container shape. */
function columnsFor(count: number, isLandscape: boolean): number {
  if (count <= 1) return 1;
  if (count === 2) return isLandscape ? 2 : 1; // portrait: stacked 50/50; landscape: side-by-side
  return 2; // 3–4 → 2×2
}

/** Split `items` into rows of at most `cols`. */
function chunk<T>(items: T[], cols: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += cols) rows.push(items.slice(i, i + cols));
  return rows;
}

/**
 * The unified, screen-FILLING participant grid — the main content of a voice room
 * Every participant is an EQUAL tile regardless of camera state
 * (see {@link ParticipantTile}); there is no leftover black area and no cramped
 * side strip of cameraless people.
 *
 * Two regimes, chosen by count + container orientation (`useWindowDimensions` is
 * not enough — we size to the actual video area via onLayout, so it stays correct
 * beside the status strip/controls and on rotation):
 *
 *  - FILL (≤ 4 tiles): rows share the height with `flex`, tiles share each row's
 *    width — the grid fills the area EXACTLY, no scroll. 1 → full-bleed; 2 →
 *    portrait stacks 50/50, landscape splits 50/50; 3–4 → 2×2 (a partial last row
 *    is centered so tiles stay equal-sized). Aspect follows the area — no forced 4:3.
 *  - SCROLL (≥ 5 tiles): a regular grid (2 cols portrait / 3 landscape) whose tiles
 *    fill the viewport height across a few rows, then scroll vertically. All tiles
 *    equal size.
 *
 * Tapping a tile promotes it to the focus stage (founder requirement #1) via
 * `onTilePress`.
 */
export function ParticipantGrid({
  tiles,
  onTilePress,
}: {
  tiles: ParticipantTileData[];
  onTilePress?: (identity: string) => void;
}) {
  const { t } = useAppTranslation();
  const [size, setSize] = useState({ w: 0, h: 0 });
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize((prev) => (prev.w === width && prev.h === height ? prev : { w: width, h: height }));
  };

  const count = tiles.length;
  const isLandscape = size.w > size.h;
  const fill = count <= 4;

  // Column count + the SINGLE tile-style object every tile shares. Keyed on the
  // participant COUNT (a primitive) and container size — NOT the `tiles` array —
  // so an active-speaker tick (which swaps the array ref) never rebuilds the style
  // object, keeping the memoized tiles stable (§27).
  const cols = size.w <= 0 ? 0 : fill ? columnsFor(count, isLandscape) : isLandscape ? 3 : 2;
  const tileStyle = useMemo<ViewStyle | null>(() => {
    if (size.w <= 0) return null;
    if (fill) {
      // FILL: fixed width; height comes from the row's flex stretch.
      return { width: (size.w - GAP * (cols - 1)) / cols };
    }
    // SCROLL: fixed width AND height (fills the viewport across a few rows).
    const visibleRows = isLandscape ? 2 : 3;
    return {
      width: (size.w - GAP * (cols - 1)) / cols,
      height: (size.h - GAP * (visibleRows - 1)) / visibleRows,
    };
  }, [size.w, size.h, fill, cols, isLandscape]);

  const renderTile = (tile: ParticipantTileData) => (
    <ParticipantTile
      key={tile.identity}
      identity={tile.identity}
      userId={tile.userId}
      track={tile.track}
      name={tile.name}
      avatarUrl={tile.avatarUrl}
      isLocal={tile.isLocal}
      muted={tile.muted}
      speaking={tile.speaking}
      showName
      onSelect={onTilePress}
      accessibilityLabel={t("mobile:voice.focus.focusCamera", { name: tile.name })}
      style={tileStyle ?? undefined}
    />
  );

  return (
    <View style={{ flex: 1 }} onLayout={onLayout}>
      {!tileStyle ? null : fill ? (
        // FILL: exact tiling, no scroll. Rows flex the height evenly; each tile has
        // a fixed width and stretches to the row height (default row cross-stretch).
        <View style={{ flex: 1, gap: GAP }}>
          {chunk(tiles, cols).map((row, i) => (
            <View
              key={i}
              style={{ flex: 1, flexDirection: "row", gap: GAP, justifyContent: "center" }}
            >
              {row.map(renderTile)}
            </View>
          ))}
        </View>
      ) : (
        // SCROLL: fixed-size tiles filling the viewport height across a few rows.
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{
            flexDirection: "row",
            flexWrap: "wrap",
            gap: GAP,
            justifyContent: "center",
          }}
          showsVerticalScrollIndicator={false}
        >
          {tiles.map(renderTile)}
        </ScrollView>
      )}
    </View>
  );
}
