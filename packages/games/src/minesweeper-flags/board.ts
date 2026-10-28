/**
 * Board generation and cell math for Minesweeper Flags.
 *
 * The board is generated SERVER-SIDE only — clients never know mine positions
 * until a cell is revealed. This prevents any client-side cheating.
 */

import {
  GRID_ROWS,
  GRID_COLS,
  GRID_SIZE,
  MINE_COUNT,
  type ServerCell,
  type ClientBoard,
} from "./types.js";

/** Convert (row, col) to flat index. */
export function cellIndex(row: number, col: number): number {
  return row * GRID_COLS + col;
}

/** Convert flat index to (row, col). */
export function indexToCell(index: number): { row: number; col: number } {
  return { row: Math.floor(index / GRID_COLS), col: index % GRID_COLS };
}

/** True when (row, col) is inside the grid. */
export function inBounds(row: number, col: number): boolean {
  return row >= 0 && row < GRID_ROWS && col >= 0 && col < GRID_COLS;
}

/** All valid neighbours of (row, col), 8-directional. */
export function neighbours(row: number, col: number): Array<{ row: number; col: number }> {
  const result: Array<{ row: number; col: number }> = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = row + dr;
      const nc = col + dc;
      if (inBounds(nr, nc)) result.push({ row: nr, col: nc });
    }
  }
  return result;
}

/**
 * Fisher–Yates shuffle (in-place). Uses the provided RNG so the server can
 * use `crypto.randomInt` and tests can use a seeded PRNG.
 */
function shuffle<T>(arr: T[], randomInt: (max: number) => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
}

/**
 * Generate a new server board with `MINE_COUNT` mines placed randomly.
 *
 * @param randomInt - returns a random integer in [0, max). Injected so the
 *   server can use `crypto.randomInt` and tests can seed it.
 */
export function generateBoard(
  randomInt: (max: number) => number,
): ServerCell[] {
  const indices = Array.from({ length: GRID_SIZE }, (_, i) => i);
  shuffle(indices, randomInt);
  const mineSet = new Set(indices.slice(0, MINE_COUNT));

  const board: ServerCell[] = Array.from({ length: GRID_SIZE }, (_, i) => ({
    hasMine: mineSet.has(i),
    adjacentMines: 0,
  }));

  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (!board[cellIndex(r, c)]!.hasMine) continue;
      for (const n of neighbours(r, c)) {
        board[cellIndex(n.row, n.col)]!.adjacentMines++;
      }
    }
  }

  return board;
}

/** A fresh all-hidden client board. */
export function emptyClientBoard(): ClientBoard {
  return Array.from({ length: GRID_SIZE }, () => ({ kind: "hidden" as const }));
}
