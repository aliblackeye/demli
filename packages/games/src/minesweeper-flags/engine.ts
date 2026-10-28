/**
 * Minesweeper Flags game engine — processes moves and maintains state.
 *
 * Pure functions over immutable-ish state. No side effects, no I/O.
 * The server creates a game, applies moves, and broadcasts the results.
 */

import {
  GRID_SIZE,
  MINE_COUNT,
  MINES_TO_WIN,
  BOMB_RADIUS,
  GRID_ROWS,
  GRID_COLS,
  type ServerGame,
  type ServerCell,
  type ClientBoard,
  type ClientCellState,
  type GameState,
  type GameAction,
  type MoveResult,
  type PlayerSeat,
} from "./types.js";
import {
  generateBoard,
  emptyClientBoard,
  cellIndex,
  inBounds,
  neighbours,
} from "./board.js";

/**
 * Create a new game. The board is generated with the provided RNG.
 */
export function createGame(
  id: string,
  randomInt: (max: number) => number,
): ServerGame {
  return {
    id,
    phase: "playing",
    serverBoard: generateBoard(randomInt),
    clientBoard: emptyClientBoard(),
    scores: { 1: 0, 2: 0 },
    currentTurn: 1,
    bombUsed: { 1: false, 2: false },
  };
}

/** Can the given player use their bomb right now? Only when trailing. */
export function canUseBomb(game: ServerGame, seat: PlayerSeat): boolean {
  if (game.bombUsed[seat]) return false;
  if (game.phase !== "playing") return false;
  const other: PlayerSeat = seat === 1 ? 2 : 1;
  return game.scores[seat] < game.scores[other];
}

/**
 * Reveal a single cell. If it's a 0-adjacent cell, cascade-reveal neighbours
 * (standard Minesweeper flood-fill). Returns all cells that changed.
 */
function revealCell(
  serverBoard: ServerCell[],
  clientBoard: ClientBoard,
  row: number,
  col: number,
  actor: PlayerSeat,
): { changes: Array<{ row: number; col: number; state: ClientCellState }>; foundMine: boolean } {
  const idx = cellIndex(row, col);
  const cell = clientBoard[idx]!;

  if (cell.kind !== "hidden") {
    return { changes: [], foundMine: false };
  }

  const server = serverBoard[idx]!;

  if (server.hasMine) {
    const state: ClientCellState = { kind: "flagged", owner: actor };
    clientBoard[idx] = state;
    return { changes: [{ row, col, state }], foundMine: true };
  }

  const state: ClientCellState = { kind: "revealed", adjacentMines: server.adjacentMines };
  clientBoard[idx] = state;
  const changes: Array<{ row: number; col: number; state: ClientCellState }> = [
    { row, col, state },
  ];

  if (server.adjacentMines === 0) {
    const queue: Array<{ row: number; col: number }> = neighbours(row, col);
    while (queue.length > 0) {
      const next = queue.pop()!;
      const ni = cellIndex(next.row, next.col);
      if (clientBoard[ni]!.kind !== "hidden") continue;
      const ns = serverBoard[ni]!;
      if (ns.hasMine) continue;
      const ns2: ClientCellState = { kind: "revealed", adjacentMines: ns.adjacentMines };
      clientBoard[ni] = ns2;
      changes.push({ row: next.row, col: next.col, state: ns2 });
      if (ns.adjacentMines === 0) {
        queue.push(...neighbours(next.row, next.col));
      }
    }
  }

  return { changes, foundMine: false };
}

function checkWinner(game: ServerGame): PlayerSeat | undefined {
  if (game.scores[1] >= MINES_TO_WIN) return 1;
  if (game.scores[2] >= MINES_TO_WIN) return 2;

  const totalFlagged = game.scores[1] + game.scores[2];
  if (totalFlagged >= MINE_COUNT) {
    return game.scores[1] > game.scores[2] ? 1 : 2;
  }

  return undefined;
}

/**
 * Apply a game action. Mutates the game in place and returns the result
 * to broadcast to clients.
 */
export function applyAction(
  game: ServerGame,
  seat: PlayerSeat,
  action: GameAction,
): MoveResult | { error: string } {
  if (game.phase !== "playing") {
    return { error: "game_not_active" };
  }
  if (game.currentTurn !== seat) {
    return { error: "not_your_turn" };
  }

  if (action.type === "reveal") {
    if (!inBounds(action.row, action.col)) {
      return { error: "out_of_bounds" };
    }
    const idx = cellIndex(action.row, action.col);
    if (game.clientBoard[idx]!.kind !== "hidden") {
      return { error: "cell_already_revealed" };
    }

    const { changes, foundMine } = revealCell(
      game.serverBoard,
      game.clientBoard,
      action.row,
      action.col,
      seat,
    );

    if (foundMine) {
      game.scores[seat]++;
    }

    const winner = checkWinner(game);
    if (winner) {
      game.phase = "finished";
      game.winner = winner;
    } else if (!foundMine) {
      game.currentTurn = seat === 1 ? 2 : 1;
    }

    return {
      action,
      cellChanges: changes,
      foundMine,
      scores: { ...game.scores },
      currentTurn: game.currentTurn,
      phase: game.phase,
      winner: game.winner,
    };
  }

  if (action.type === "bomb") {
    if (!canUseBomb(game, seat)) {
      return { error: "bomb_not_available" };
    }
    if (!inBounds(action.centerRow, action.centerCol)) {
      return { error: "out_of_bounds" };
    }

    game.bombUsed[seat] = true;
    const allChanges: Array<{ row: number; col: number; state: ClientCellState }> = [];
    let minesFound = 0;

    for (let dr = -BOMB_RADIUS; dr <= BOMB_RADIUS; dr++) {
      for (let dc = -BOMB_RADIUS; dc <= BOMB_RADIUS; dc++) {
        const r = action.centerRow + dr;
        const c = action.centerCol + dc;
        if (!inBounds(r, c)) continue;
        const idx = cellIndex(r, c);
        if (game.clientBoard[idx]!.kind !== "hidden") continue;

        const { changes, foundMine } = revealCell(
          game.serverBoard,
          game.clientBoard,
          r,
          c,
          seat,
        );
        allChanges.push(...changes);
        if (foundMine) minesFound++;
      }
    }

    game.scores[seat] += minesFound;

    const foundMine = minesFound > 0;
    const winner = checkWinner(game);
    if (winner) {
      game.phase = "finished";
      game.winner = winner;
    } else if (!foundMine) {
      game.currentTurn = seat === 1 ? 2 : 1;
    }

    return {
      action,
      cellChanges: allChanges,
      foundMine,
      scores: { ...game.scores },
      currentTurn: game.currentTurn,
      phase: game.phase,
      winner: game.winner,
    };
  }

  return { error: "unknown_action" };
}

/** Extract the public game state (no mine positions). */
export function toGameState(game: ServerGame): GameState {
  return {
    id: game.id,
    phase: game.phase,
    board: game.clientBoard.map((c) => ({ ...c })),
    scores: { ...game.scores },
    currentTurn: game.currentTurn,
    bombUsed: { ...game.bombUsed },
    winner: game.winner,
    totalMines: MINE_COUNT,
    minesToWin: MINES_TO_WIN,
  };
}
