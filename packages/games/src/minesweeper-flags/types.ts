/**
 * Minesweeper Flags — MSN Messenger'daki ikonik 2-kişilik mayın tarlası.
 *
 * Tüm tipler saf TypeScript — DOM, Node, framework bağımlılığı yok.
 * Sunucu ve istemci aynı tipleri kullanır.
 */

/** 0-indexed row/col on the 16×16 grid. */
export interface Cell {
  row: number;
  col: number;
}

/** Which player seat (not a UserId — mapped externally). */
export type PlayerSeat = 1 | 2;

export type GamePhase = "waiting" | "playing" | "finished";

/** A single cell's server-side truth (NEVER sent to clients). */
export interface ServerCell {
  hasMine: boolean;
  adjacentMines: number;
}

/** A single cell as the client sees it. */
export type ClientCellState =
  | { kind: "hidden" }
  | { kind: "revealed"; adjacentMines: number }
  | { kind: "flagged"; owner: PlayerSeat };

/** The full board as the client sees it — 16×16 flat array (row-major). */
export type ClientBoard = ClientCellState[];

/** A player's move. */
export interface MoveAction {
  type: "reveal";
  row: number;
  col: number;
}

/** The bomb power — reveals a 5×5 area centered on the target. */
export interface BombAction {
  type: "bomb";
  centerRow: number;
  centerCol: number;
}

export type GameAction = MoveAction | BombAction;

/** Result of processing a single action. */
export interface MoveResult {
  action: GameAction;
  /** Cells that changed (revealed or flagged). */
  cellChanges: Array<{ row: number; col: number; state: ClientCellState }>;
  /** Did the active player find a mine? (Extra turn if true.) */
  foundMine: boolean;
  /** Current scores after this move. */
  scores: Record<PlayerSeat, number>;
  /** Whose turn it is NOW (after this move). */
  currentTurn: PlayerSeat;
  /** Game phase after this move. */
  phase: GamePhase;
  /** Winner (only set when phase === "finished"). */
  winner?: PlayerSeat;
}

/** The public game state sent to clients. */
export interface GameState {
  /** Unique game id. */
  id: string;
  phase: GamePhase;
  board: ClientBoard;
  scores: Record<PlayerSeat, number>;
  currentTurn: PlayerSeat;
  /** Whether each player has used their bomb. */
  bombUsed: Record<PlayerSeat, boolean>;
  winner?: PlayerSeat;
  /** Total mines on the board. */
  totalMines: number;
  /** Mines needed to win. */
  minesToWin: number;
}

/** Full server-side game (includes hidden mine positions). */
export interface ServerGame {
  id: string;
  phase: GamePhase;
  serverBoard: ServerCell[];
  clientBoard: ClientBoard;
  scores: Record<PlayerSeat, number>;
  currentTurn: PlayerSeat;
  bombUsed: Record<PlayerSeat, boolean>;
  winner?: PlayerSeat;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GRID_ROWS = 16;
export const GRID_COLS = 16;
export const GRID_SIZE = GRID_ROWS * GRID_COLS; // 256
export const MINE_COUNT = 51;
export const MINES_TO_WIN = 26;
export const BOMB_RADIUS = 2; // 5×5 = center ± 2
