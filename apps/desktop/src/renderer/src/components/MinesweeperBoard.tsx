/**
 * Minesweeper Flags game board — MSN Messenger style (MSN Games revival).
 *
 * Server-authoritative: every cell state comes from the game store, which is
 * a projection of server frames. Clicking a cell fires a REST mutation; the
 * result arrives via the realtime connection as a game.move_result event.
 *
 * The board is 16×16. Each cell is a fixed-size square; the board scales via
 * CSS transform to fit the container while maintaining pixel-perfect alignment.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { Bomb, Flag, Trophy } from "lucide-react";
import { Button, cn, Tooltip, TooltipContent, TooltipTrigger, UserAvatar } from "@demli/ui";
import type { WireClientCellState, WirePlayerSeat } from "@demli/protocol";
import type { UserId } from "@demli/types";
import { useGameStore, GRID_ROWS, GRID_COLS, type ActiveGame } from "../stores/game-store";
import { useChatStore } from "../stores/chat-store";
import { useGameMove } from "../queries/game-queries";
import { useAppTranslation } from "../lib/i18n";

function useUserName(id: UserId | undefined): string {
  return useChatStore((s) => {
    if (!id) return "?";
    const u = s.users[id];
    return u?.displayName || u?.username || "?";
  });
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CELL_SIZE = 28;
const BOARD_W = GRID_COLS * CELL_SIZE;
const BOARD_H = GRID_ROWS * CELL_SIZE;

const ADJACENT_COLORS: Record<number, string> = {
  1: "text-blue-600",
  2: "text-green-700",
  3: "text-red-600",
  4: "text-purple-700",
  5: "text-amber-800",
  6: "text-teal-600",
  7: "text-neutral-800",
  8: "text-neutral-500",
};

// ---------------------------------------------------------------------------
// Cell
// ---------------------------------------------------------------------------

function Cell({
  state,
  row,
  col,
  isMyTurn,
  isFinished,
  isLastChanged,
  onReveal,
}: {
  state: WireClientCellState;
  row: number;
  col: number;
  isMyTurn: boolean;
  isFinished: boolean;
  isLastChanged: boolean;
  onReveal: (row: number, col: number) => void;
}) {
  const handleClick = useCallback(() => {
    if (state.kind !== "hidden" || !isMyTurn || isFinished) return;
    onReveal(row, col);
  }, [state.kind, isMyTurn, isFinished, row, col, onReveal]);

  const base =
    "flex items-center justify-center select-none transition-colors duration-100";

  if (state.kind === "hidden") {
    return (
      <button
        type="button"
        className={cn(
          base,
          "bg-emerald-700/80 hover:bg-emerald-600/80 border border-emerald-900/40",
          "cursor-pointer active:bg-emerald-500/80",
          (!isMyTurn || isFinished) && "cursor-default opacity-80 hover:bg-emerald-700/80",
        )}
        style={{ width: CELL_SIZE, height: CELL_SIZE }}
        onClick={handleClick}
        disabled={!isMyTurn || isFinished}
        aria-label={`${row},${col}`}
      />
    );
  }

  if (state.kind === "flagged") {
    const isSeat1 = state.owner === 1;
    return (
      <div
        className={cn(
          base,
          "border border-neutral-600/40",
          isSeat1
            ? "bg-blue-500/30 text-blue-400"
            : "bg-red-500/30 text-red-400",
          isLastChanged && "animate-pulse",
        )}
        style={{ width: CELL_SIZE, height: CELL_SIZE }}
      >
        <Flag className="h-4 w-4" />
      </div>
    );
  }

  // revealed
  return (
    <div
      className={cn(
        base,
        "bg-neutral-800/60 border border-neutral-700/30",
        isLastChanged && "bg-neutral-700/60",
      )}
      style={{ width: CELL_SIZE, height: CELL_SIZE }}
    >
      {state.adjacentMines > 0 && (
        <span
          className={cn(
            "text-xs font-bold leading-none",
            ADJACENT_COLORS[state.adjacentMines] ?? "text-neutral-400",
          )}
        >
          {state.adjacentMines}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Score bar
// ---------------------------------------------------------------------------

function ScoreBar({ game }: { game: ActiveGame }) {
  const { t } = useAppTranslation();
  const p1Id = game.players["1"];
  const p2Id = game.players["2"];
  const p1Name = useUserName(p1Id);
  const p2Name = useUserName(p2Id);
  const s1 = game.scores["1"] ?? 0;
  const s2 = game.scores["2"] ?? 0;

  return (
    <div className="flex items-center justify-between gap-4 px-3 py-2 rounded-lg bg-neutral-800/60 text-sm">
      {/* Player 1 */}
      <div className={cn("flex items-center gap-2", game.currentTurn === 1 && "font-bold")}>
        <div className="h-3 w-3 rounded-full bg-blue-500" />
        <span className="truncate max-w-[100px]">{p1Name}</span>
        <span className="tabular-nums text-blue-400">{s1}</span>
        {game.currentTurn === 1 && !game.winner && (
          <span className="text-[10px] text-blue-300 uppercase tracking-wider">
            {t("games.turn", "Sıra")}
          </span>
        )}
      </div>

      {/* Center */}
      <div className="text-neutral-500 text-xs tabular-nums">
        {game.minesToWin} {t("games.toWin", "kazanmak için")}
      </div>

      {/* Player 2 */}
      <div className={cn("flex items-center gap-2", game.currentTurn === 2 && "font-bold")}>
        {game.currentTurn === 2 && !game.winner && (
          <span className="text-[10px] text-red-300 uppercase tracking-wider">
            {t("games.turn", "Sıra")}
          </span>
        )}
        <span className="tabular-nums text-red-400">{s2}</span>
        <span className="truncate max-w-[100px]">{p2Name}</span>
        <div className="h-3 w-3 rounded-full bg-red-500" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bomb button
// ---------------------------------------------------------------------------

function BombButton({
  game,
  onBomb,
}: {
  game: ActiveGame;
  onBomb: () => void;
}) {
  const { t } = useAppTranslation();
  const myBombUsed = game.bombUsed[String(game.mySeat)] ?? false;
  const isMyTurn = game.currentTurn === game.mySeat;
  const isTrailing =
    (game.scores[String(game.mySeat)] ?? 0) <
    (game.scores[String(game.mySeat === 1 ? 2 : 1)] ?? 0);

  const canUseBomb = isMyTurn && !myBombUsed && isTrailing && game.phase === "playing";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={!canUseBomb}
          onClick={onBomb}
          className={cn(
            "gap-1.5",
            canUseBomb && "border-amber-500/50 text-amber-400 hover:bg-amber-500/10",
          )}
        >
          <Bomb className="h-4 w-4" />
          {t("games.bomb", "Bomba")}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {myBombUsed
          ? t("games.bombUsed", "Bombanı zaten kullandın")
          : !isTrailing
            ? t("games.bombOnlyWhenTrailing", "Sadece gerideyken kullanılabilir")
            : t("games.bombHint", "5×5 alanı patlat (gerideyken 1 kez)")}
      </TooltipContent>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// Winner overlay
// ---------------------------------------------------------------------------

function WinnerOverlay({ game }: { game: ActiveGame }) {
  const { t } = useAppTranslation();
  const winnerId = game.players[String(game.winner)];
  const winnerName = useUserName(winnerId);
  if (game.phase !== "finished" || !game.winner) return null;

  const isMe = game.winner === game.mySeat;

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/60 z-10 rounded-lg backdrop-blur-sm">
      <div className="flex flex-col items-center gap-3 text-center">
        <Trophy className={cn("h-10 w-10", isMe ? "text-amber-400" : "text-neutral-400")} />
        <div className="text-lg font-bold">
          {isMe
            ? t("games.youWon", "Kazandın!")
            : t("games.opponentWon", "{{name}} kazandı", {
                name: winnerName,
              })}
        </div>
        <div className="text-sm text-neutral-400 tabular-nums">
          {game.scores["1"] ?? 0} – {game.scores["2"] ?? 0}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main board
// ---------------------------------------------------------------------------

export function MinesweeperBoard() {
  const game = useGameStore((s) => s.activeGame);
  const moveMutation = useGameMove();
  const [bombMode, setBombMode] = useState(false);

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

  const handleBomb = useCallback(() => {
    setBombMode((prev) => !prev);
  }, []);

  if (!game) return null;

  const isMyTurn = game.currentTurn === game.mySeat;
  const isFinished = game.phase === "finished";

  return (
    <div className="flex flex-col gap-3 p-4">
      <ScoreBar game={game} />

      <div className="relative">
        <WinnerOverlay game={game} />

        <div
          className={cn(
            "grid rounded-lg overflow-hidden border-2",
            isMyTurn && !isFinished
              ? "border-emerald-500/50"
              : "border-neutral-600/30",
            bombMode && "border-amber-500/60",
          )}
          style={{
            gridTemplateColumns: `repeat(${GRID_COLS}, ${CELL_SIZE}px)`,
            width: BOARD_W,
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
                isMyTurn={isMyTurn && !bombMode}
                isFinished={isFinished}
                isLastChanged={lastChangedSet.has(idx)}
                onReveal={handleReveal}
              />
            );
          })}
        </div>
      </div>

      <div className="flex items-center justify-between">
        <BombButton game={game} onBomb={handleBomb} />
        {bombMode && (
          <span className="text-xs text-amber-400 animate-pulse">
            Bir hücreye tıkla — 5×5 alan patlar
          </span>
        )}
      </div>
    </div>
  );
}
