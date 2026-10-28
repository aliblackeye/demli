import { describe, it, expect } from "vitest";
import { createGame, applyAction, toGameState, canUseBomb } from "../engine.js";
import { cellIndex } from "../board.js";
import { GRID_SIZE, MINE_COUNT, MINES_TO_WIN, type ServerGame } from "../types.js";

function seededRng(seed: number) {
  let s = seed;
  return (max: number): number => {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    return s % max;
  };
}

describe("createGame", () => {
  it("creates a board with exactly MINE_COUNT mines", () => {
    const game = createGame("test-1", seededRng(42));
    const mineCount = game.serverBoard.filter((c) => c.hasMine).length;
    expect(mineCount).toBe(MINE_COUNT);
    expect(game.serverBoard.length).toBe(GRID_SIZE);
    expect(game.phase).toBe("playing");
    expect(game.currentTurn).toBe(1);
    expect(game.scores).toEqual({ 1: 0, 2: 0 });
  });

  it("computes correct adjacent mine counts", () => {
    const game = createGame("test-2", seededRng(123));
    for (let r = 0; r < 16; r++) {
      for (let c = 0; c < 16; c++) {
        const idx = cellIndex(r, c);
        const cell = game.serverBoard[idx]!;
        if (cell.hasMine) continue;
        let count = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const nr = r + dr;
            const nc = c + dc;
            if (nr < 0 || nr >= 16 || nc < 0 || nc >= 16) continue;
            if (game.serverBoard[cellIndex(nr, nc)]!.hasMine) count++;
          }
        }
        expect(cell.adjacentMines).toBe(count);
      }
    }
  });
});

describe("applyAction — reveal", () => {
  it("reveals a non-mine cell and passes turn", () => {
    const game = createGame("test-3", seededRng(42));
    const safe = game.serverBoard.findIndex((c) => !c.hasMine);
    const { row, col } = { row: Math.floor(safe / 16), col: safe % 16 };
    const result = applyAction(game, 1, { type: "reveal", row, col });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.foundMine).toBe(false);
    expect(result.currentTurn).toBe(2);
    expect(result.cellChanges.length).toBeGreaterThan(0);
  });

  it("flags a mine cell and keeps turn", () => {
    const game = createGame("test-4", seededRng(42));
    const mineIdx = game.serverBoard.findIndex((c) => c.hasMine);
    const row = Math.floor(mineIdx / 16);
    const col = mineIdx % 16;
    const result = applyAction(game, 1, { type: "reveal", row, col });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.foundMine).toBe(true);
    expect(result.currentTurn).toBe(1);
    expect(result.scores[1]).toBe(1);
    expect(game.clientBoard[mineIdx]).toEqual({ kind: "flagged", owner: 1 });
  });

  it("rejects move on already-revealed cell", () => {
    const game = createGame("test-5", seededRng(42));
    const safe = game.serverBoard.findIndex((c) => !c.hasMine);
    const row = Math.floor(safe / 16);
    const col = safe % 16;
    applyAction(game, 1, { type: "reveal", row, col });
    const result = applyAction(game, 2, { type: "reveal", row, col });
    expect("error" in result).toBe(true);
  });

  it("rejects move when not your turn", () => {
    const game = createGame("test-6", seededRng(42));
    const result = applyAction(game, 2, { type: "reveal", row: 0, col: 0 });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toBe("not_your_turn");
  });
});

describe("applyAction — bomb", () => {
  it("cannot use bomb when not trailing", () => {
    const game = createGame("test-7", seededRng(42));
    expect(canUseBomb(game, 1)).toBe(false);
  });

  it("can use bomb when trailing", () => {
    const game = createGame("test-8", seededRng(42));
    game.scores[2] = 3;
    expect(canUseBomb(game, 1)).toBe(true);
  });

  it("bomb reveals a 5×5 area", () => {
    const game = createGame("test-9", seededRng(42));
    game.scores[2] = 5;
    game.scores[1] = 0;
    const result = applyAction(game, 1, { type: "bomb", centerRow: 8, centerCol: 8 });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.cellChanges.length).toBeGreaterThan(0);
    expect(game.bombUsed[1]).toBe(true);
  });

  it("bomb cannot be used twice", () => {
    const game = createGame("test-10", seededRng(42));
    game.scores[2] = 5;
    applyAction(game, 1, { type: "bomb", centerRow: 8, centerCol: 8 });
    game.currentTurn = 1;
    game.scores[2] = 10;
    const result = applyAction(game, 1, { type: "bomb", centerRow: 4, centerCol: 4 });
    expect("error" in result).toBe(true);
  });
});

describe("win condition", () => {
  it("finishes when a player reaches MINES_TO_WIN", () => {
    const game = createGame("test-11", seededRng(42));
    game.scores[1] = MINES_TO_WIN - 1;
    const mineIdx = game.serverBoard.findIndex(
      (c, i) => c.hasMine && game.clientBoard[i]!.kind === "hidden",
    );
    const row = Math.floor(mineIdx / 16);
    const col = mineIdx % 16;
    const result = applyAction(game, 1, { type: "reveal", row, col });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.phase).toBe("finished");
    expect(result.winner).toBe(1);
  });
});

describe("toGameState", () => {
  it("excludes server board", () => {
    const game = createGame("test-12", seededRng(42));
    const state = toGameState(game);
    expect(state.id).toBe("test-12");
    expect((state as unknown as Record<string, unknown>)["serverBoard"]).toBeUndefined();
    expect(state.board.length).toBe(GRID_SIZE);
    expect(state.totalMines).toBe(MINE_COUNT);
    expect(state.minesToWin).toBe(MINES_TO_WIN);
  });
});
