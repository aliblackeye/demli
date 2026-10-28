/**
 * Client-side game state — PHONE mirror of desktop's game-store.ts (MSN Games).
 *
 * A deliberate mirror: same slices, same actions, same selector shapes. It is a
 * mirror rather than a shared module because the store is the platform's own
 * projection layer — the desktop one imports `zustand` for the web build and
 * this one for RN — but every DECISION inside it is the same, and any divergence
 * here is a bug on this side.
 *
 * Server-authoritative: the store is a pure projection of server frames
 * (`game.started`, `game.move_result`, `game.ended`). Nothing is authored
 * locally except optimistic UI hints (pending invite, whose turn it is).
 */

import { create } from "zustand";
import type {
  GameType,
  WireClientCellState,
  WireGameState,
  WireMoveResult,
  GameInviteReceivedPayload,
  GameStartedPayload,
  GameMoveResultPayload,
  GameEndedPayload,
  GameDeclinedPayload,
  WirePlayerSeat,
} from "@demli/protocol";
import type { GameId, UserId } from "@demli/types";

// ---------------------------------------------------------------------------
// Board constants (must match packages/games)
// ---------------------------------------------------------------------------

export const GRID_ROWS = 16;
export const GRID_COLS = 16;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PendingInvite {
  gameId: GameId;
  gameType: GameType;
  inviterUserId: UserId;
  channelId: string;
  receivedAt: number;
}

export interface ActiveGame {
  gameId: GameId;
  gameType: GameType;
  channelId: string;
  players: Record<string, UserId>;
  mySeat: WirePlayerSeat;
  board: WireClientCellState[];
  scores: Record<string, number>;
  currentTurn: WirePlayerSeat;
  bombUsed: Record<string, boolean>;
  phase: "playing" | "finished";
  winner?: WirePlayerSeat;
  totalMines: number;
  minesToWin: number;
  lastChangedCells: Array<{ row: number; col: number }>;
}

export interface GameEndResult {
  gameId: GameId;
  winnerUserId: UserId | null;
  scores: Record<string, number>;
  players: Record<string, UserId>;
}

interface GameState {
  pendingInvite: PendingInvite | null;
  activeGame: ActiveGame | null;
  lastResult: GameEndResult | null;
  outgoingInviteGameId: GameId | null;

  receiveInvite(payload: GameInviteReceivedPayload): void;
  gameStarted(payload: GameStartedPayload, myUserId: UserId): void;
  moveResult(payload: GameMoveResultPayload): void;
  gameEnded(payload: GameEndedPayload): void;
  inviteDeclined(payload: GameDeclinedPayload): void;

  dismissInvite(): void;
  dismissResult(): void;
  setOutgoingInvite(gameId: GameId | null): void;
  reset(): void;
}

export const useGameStore = create<GameState>((set, get) => ({
  pendingInvite: null,
  activeGame: null,
  lastResult: null,
  outgoingInviteGameId: null,

  receiveInvite(payload) {
    set({
      pendingInvite: {
        gameId: payload.gameId,
        gameType: payload.gameType,
        inviterUserId: payload.inviterUserId,
        channelId: payload.channelId,
        receivedAt: Date.now(),
      },
    });
  },

  gameStarted(payload, myUserId) {
    const mySeat = payload.players["1"] === myUserId ? 1 : 2;
    set({
      pendingInvite: null,
      outgoingInviteGameId: null,
      lastResult: null,
      activeGame: {
        gameId: payload.gameId,
        gameType: payload.gameType,
        channelId: payload.channelId,
        players: payload.players,
        mySeat,
        board: payload.state.board,
        scores: payload.state.scores,
        currentTurn: payload.state.currentTurn,
        bombUsed: payload.state.bombUsed,
        phase: "playing",
        winner: undefined,
        totalMines: payload.state.totalMines,
        minesToWin: payload.state.minesToWin,
        lastChangedCells: [],
      },
    });
  },

  moveResult(payload) {
    const game = get().activeGame;
    if (!game || game.gameId !== payload.gameId) return;

    const newBoard = [...game.board];
    for (const change of payload.result.cellChanges) {
      newBoard[change.row * GRID_COLS + change.col] = change.state;
    }

    set({
      activeGame: {
        ...game,
        board: newBoard,
        scores: payload.result.scores,
        currentTurn: payload.result.currentTurn,
        phase: payload.result.phase === "finished" ? "finished" : "playing",
        winner: payload.result.winner,
        lastChangedCells: payload.result.cellChanges.map((c) => ({
          row: c.row,
          col: c.col,
        })),
      },
    });
  },

  gameEnded(payload) {
    set({
      activeGame: null,
      lastResult: {
        gameId: payload.gameId,
        winnerUserId: payload.winnerUserId,
        scores: payload.scores,
        players: payload.players,
      },
    });
  },

  inviteDeclined(_payload) {
    set({ outgoingInviteGameId: null });
  },

  dismissInvite() {
    set({ pendingInvite: null });
  },

  dismissResult() {
    set({ lastResult: null });
  },

  setOutgoingInvite(gameId) {
    set({ outgoingInviteGameId: gameId });
  },

  reset() {
    set({
      pendingInvite: null,
      activeGame: null,
      lastResult: null,
      outgoingInviteGameId: null,
    });
  },
}));
