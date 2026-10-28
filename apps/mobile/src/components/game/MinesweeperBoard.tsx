/**
 * Minesweeper Flags game board — React Native port of the desktop board.
 *
 * Server-authoritative: every cell state is a projection of server frames.
 * Tapping a cell fires a REST mutation; the result arrives via realtime
 * as a game.move_result event. The board is 16×16 with cells sized to
 * fill the available width (minus padding), keeping the same proportions
 * as the desktop 28px grid.
 */

import { useCallback, useMemo, useState } from "react";
import { Pressable, View, useWindowDimensions } from "react-native";
import { Bomb, Flag, Trophy } from "lucide-react-native";
import type { WireClientCellState } from "@demli/protocol";
import type { UserId } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { Text } from "@/components/ui/Text";
import { Touchable } from "@/components/ui/Touchable";
import { useGameStore, GRID_ROWS, GRID_COLS, type ActiveGame } from "@/stores/game-store";
import { useChatStore } from "@/stores/chat-store";
import { useGameMove } from "@/queries/game-queries";
import { colors, radius, space } from "@/theme/theme";

function useUserName(id: UserId | undefined): string {
  return useChatStore((s) => {
    if (!id) return "?";
    const u = s.users[id];
    return u?.displayName || u?.username || "?";
  });
}

const ADJACENT_COLORS: Record<number, string> = {
  1: "#2563eb",
  2: "#15803d",
  3: "#dc2626",
  4: "#7e22ce",
  5: "#92400e",
  6: "#0d9488",
  7: "#404040",
  8: "#737373",
};

const P1_COLOR = "#3b82f6";
const P2_COLOR = "#ef4444";

function Cell({
  state,
  row,
  col,
  cellSize,
  isMyTurn,
  isFinished,
  isLastChanged,
  onReveal,
}: {
  state: WireClientCellState;
  row: number;
  col: number;
  cellSize: number;
  isMyTurn: boolean;
  isFinished: boolean;
  isLastChanged: boolean;
  onReveal: (row: number, col: number) => void;
}) {
  const handlePress = useCallback(() => {
    if (state.kind !== "hidden" || !isMyTurn || isFinished) return;
    onReveal(row, col);
  }, [state.kind, isMyTurn, isFinished, row, col, onReveal]);

  const box = { width: cellSize, height: cellSize };
  const center = { alignItems: "center" as const, justifyContent: "center" as const };

  if (state.kind === "hidden") {
    return (
      <Pressable
        onPress={handlePress}
        disabled={!isMyTurn || isFinished}
        style={({ pressed }) => [
          box,
          center,
          {
            backgroundColor: pressed && isMyTurn && !isFinished
              ? "rgba(16,185,129,0.5)"
              : "rgba(16,185,129,0.35)",
            borderWidth: 0.5,
            borderColor: "rgba(6,78,59,0.4)",
            opacity: !isMyTurn || isFinished ? 0.7 : 1,
          },
        ]}
      />
    );
  }

  if (state.kind === "flagged") {
    const isSeat1 = state.owner === 1;
    return (
      <View
        style={[
          box,
          center,
          {
            backgroundColor: isSeat1 ? "rgba(59,130,246,0.25)" : "rgba(239,68,68,0.25)",
            borderWidth: 0.5,
            borderColor: "rgba(115,115,115,0.3)",
          },
        ]}
      >
        <Flag
          size={Math.round(cellSize * 0.5)}
          color={isSeat1 ? P1_COLOR : P2_COLOR}
          fill={isSeat1 ? P1_COLOR : P2_COLOR}
        />
      </View>
    );
  }

  return (
    <View
      style={[
        box,
        center,
        {
          backgroundColor: isLastChanged ? "rgba(64,64,64,0.6)" : "rgba(38,38,38,0.6)",
          borderWidth: 0.5,
          borderColor: "rgba(64,64,64,0.3)",
        },
      ]}
    >
      {state.adjacentMines > 0 && (
        <Text
          style={{
            fontSize: Math.round(cellSize * 0.4),
            fontWeight: "700",
            color: ADJACENT_COLORS[state.adjacentMines] ?? "#a3a3a3",
          }}
        >
          {state.adjacentMines}
        </Text>
      )}
    </View>
  );
}

function ScoreBar({ game, cellSize }: { game: ActiveGame; cellSize: number }) {
  const { t } = useAppTranslation();
  const p1Name = useUserName(game.players["1"]);
  const p2Name = useUserName(game.players["2"]);
  const s1 = game.scores["1"] ?? 0;
  const s2 = game.scores["2"] ?? 0;

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: space.sm,
        paddingVertical: space.xs,
        borderRadius: radius.md,
        backgroundColor: "rgba(38,38,38,0.6)",
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1 }}>
        <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: P1_COLOR }} />
        <Text
          numberOfLines={1}
          style={{
            color: colors.fg,
            fontSize: 13,
            fontWeight: game.currentTurn === 1 ? "700" : "400",
            maxWidth: 80,
          }}
        >
          {p1Name}
        </Text>
        <Text style={{ color: P1_COLOR, fontSize: 14, fontWeight: "700", fontVariant: ["tabular-nums"] }}>
          {s1}
        </Text>
        {game.currentTurn === 1 && !game.winner && (
          <Text style={{ color: "#93c5fd", fontSize: 9, textTransform: "uppercase", letterSpacing: 1 }}>
            {t("games.turn")}
          </Text>
        )}
      </View>

      <Text style={{ color: colors.fgSubtle, fontSize: 11, fontVariant: ["tabular-nums"] }}>
        {game.minesToWin} {t("games.toWin")}
      </Text>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1, justifyContent: "flex-end" }}>
        {game.currentTurn === 2 && !game.winner && (
          <Text style={{ color: "#fca5a5", fontSize: 9, textTransform: "uppercase", letterSpacing: 1 }}>
            {t("games.turn")}
          </Text>
        )}
        <Text style={{ color: P2_COLOR, fontSize: 14, fontWeight: "700", fontVariant: ["tabular-nums"] }}>
          {s2}
        </Text>
        <Text
          numberOfLines={1}
          style={{
            color: colors.fg,
            fontSize: 13,
            fontWeight: game.currentTurn === 2 ? "700" : "400",
            maxWidth: 80,
          }}
        >
          {p2Name}
        </Text>
        <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: P2_COLOR }} />
      </View>
    </View>
  );
}

function BombButton({ game, active, onToggle }: { game: ActiveGame; active: boolean; onToggle: () => void }) {
  const { t } = useAppTranslation();
  const myBombUsed = game.bombUsed[String(game.mySeat)] ?? false;
  const isMyTurn = game.currentTurn === game.mySeat;
  const opponentSeat = game.mySeat === 1 ? 2 : 1;
  const isTrailing = (game.scores[String(game.mySeat)] ?? 0) < (game.scores[String(opponentSeat)] ?? 0);
  const canUseBomb = isMyTurn && !myBombUsed && isTrailing && game.phase === "playing";

  return (
    <Touchable
      onPress={onToggle}
      disabled={!canUseBomb}
      pressedTone={colors.washStrong}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: space.md,
        paddingVertical: space.xs,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: canUseBomb
          ? active
            ? "#f59e0b"
            : "rgba(245,158,11,0.4)"
          : colors.stroke,
        backgroundColor: active ? "rgba(245,158,11,0.15)" : "transparent",
        opacity: canUseBomb ? 1 : 0.4,
      }}
    >
      <Bomb size={16} color={canUseBomb ? "#fbbf24" : colors.fgSubtle} />
      <Text style={{ color: canUseBomb ? "#fbbf24" : colors.fgSubtle, fontSize: 13, fontWeight: "600" }}>
        {t("games.bomb")}
      </Text>
    </Touchable>
  );
}

function WinnerOverlay({ game }: { game: ActiveGame }) {
  const { t } = useAppTranslation();
  const winnerId = game.players[String(game.winner)];
  const winnerName = useUserName(winnerId);
  if (game.phase !== "finished" || !game.winner) return null;

  const isMe = game.winner === game.mySeat;

  return (
    <View
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "rgba(0,0,0,0.6)",
        zIndex: 10,
        borderRadius: radius.md,
      }}
    >
      <Trophy size={40} color={isMe ? "#fbbf24" : "#a3a3a3"} />
      <Text style={{ color: colors.fg, fontSize: 18, fontWeight: "700", marginTop: space.sm }}>
        {isMe
          ? t("games.youWon")
          : t("games.opponentWon", { name: winnerName })}
      </Text>
      <Text style={{ color: colors.fgMuted, fontSize: 14, fontVariant: ["tabular-nums"], marginTop: 4 }}>
        {game.scores["1"] ?? 0} – {game.scores["2"] ?? 0}
      </Text>
    </View>
  );
}

export function MinesweeperBoard() {
  const { width: screenWidth } = useWindowDimensions();
  const game = useGameStore((s) => s.activeGame);
  const moveMutation = useGameMove();
  const [bombMode, setBombMode] = useState(false);

  const cellSize = Math.floor((screenWidth - space.md * 2) / GRID_COLS);

  const lastChangedSet = useMemo(() => {
    if (!game) return new Set<number>();
    const s = new Set<number>();
    for (const c of game.lastChangedCells) {
      s.add(c.row * GRID_COLS + c.col);
    }
    return s;
  }, [game?.lastChangedCells]);

  const handleReveal = useCallback(
    (row: number, col: number) => {
      if (!game || game.phase !== "playing") return;
      if (game.currentTurn !== game.mySeat) return;

      if (bombMode) {
        moveMutation.mutate({
          gameId: game.gameId,
          action: { type: "bomb", centerRow: row, centerCol: col },
        });
        setBombMode(false);
      } else {
        moveMutation.mutate({
          gameId: game.gameId,
          action: { type: "reveal", row, col },
        });
      }
    },
    [game, bombMode, moveMutation],
  );

  if (!game) return null;

  const isMyTurn = game.currentTurn === game.mySeat;
  const isFinished = game.phase === "finished";
  const boardWidth = cellSize * GRID_COLS;

  return (
    <View style={{ gap: space.sm, paddingHorizontal: space.md }}>
      <ScoreBar game={game} cellSize={cellSize} />

      <View style={{ position: "relative", alignSelf: "center" }}>
        <WinnerOverlay game={game} />

        <View
          style={{
            width: boardWidth,
            flexDirection: "row",
            flexWrap: "wrap",
            borderRadius: radius.md,
            overflow: "hidden",
            borderWidth: 2,
            borderColor: bombMode
              ? "rgba(245,158,11,0.5)"
              : isMyTurn && !isFinished
                ? "rgba(16,185,129,0.4)"
                : "rgba(82,82,82,0.3)",
          }}
        >
          {game.board.map((cell, idx) => {
            const row = Math.floor(idx / GRID_COLS);
            const col = idx % GRID_COLS;
            return (
              <Cell
                key={idx}
                state={cell}
                row={row}
                col={col}
                cellSize={cellSize}
                isMyTurn={isMyTurn && !bombMode}
                isFinished={isFinished}
                isLastChanged={lastChangedSet.has(idx)}
                onReveal={handleReveal}
              />
            );
          })}
        </View>
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <BombButton game={game} active={bombMode} onToggle={() => setBombMode((p) => !p)} />
        {bombMode && (
          <Text style={{ color: "#fbbf24", fontSize: 11 }}>
            5×5
          </Text>
        )}
      </View>
    </View>
  );
}
