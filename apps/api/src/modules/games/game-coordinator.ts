import { randomUUID, randomInt } from "node:crypto";
import { createGame, applyAction, toGameState } from "@demli/games";
import type { GameAction } from "@demli/games";
import { serverEvent } from "@demli/protocol";
import type { RealtimeMutationPublisher } from "@demli/db";
import type { UserId, GameId, ChannelId } from "@demli/types";
import { GameStore, type ActiveGame } from "./game-store.js";

export class GameCoordinator {
  readonly store = new GameStore();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(private readonly mutationBus?: RealtimeMutationPublisher) {
    this.cleanupTimer = setInterval(() => this.store.cleanup(), 60_000);
  }

  close(): void {
    clearInterval(this.cleanupTimer);
  }

  async invite(
    inviterUserId: UserId,
    targetUserId: UserId,
    channelId: ChannelId,
  ): Promise<{ gameId: GameId } | { error: string }> {
    if (inviterUserId === targetUserId) {
      return { error: "cannot_invite_self" };
    }

    const existingGame = this.store.getUserActiveGameId(inviterUserId);
    if (existingGame) {
      return { error: "already_in_game" };
    }

    const gameId: GameId = randomUUID();
    this.store.addInvite({
      gameId,
      gameType: "minesweeper-flags",
      inviterUserId,
      targetUserId,
      channelId,
      createdAt: Date.now(),
    });

    await this.mutationBus?.publish({
      userId: targetUserId,
      event: serverEvent.gameInviteReceived({
        gameId,
        gameType: "minesweeper-flags",
        inviterUserId,
        channelId,
      }),
    });

    return { gameId };
  }

  async accept(
    userId: UserId,
    gameId: GameId,
  ): Promise<{ ok: true; channelId: ChannelId; inviterUserId: UserId } | { error: string }> {
    const invite = this.store.getInvite(gameId);
    if (!invite) return { error: "invite_not_found" };
    if (invite.targetUserId !== userId) return { error: "not_target" };

    const existingGame = this.store.getUserActiveGameId(userId);
    if (existingGame) return { error: "already_in_game" };

    this.store.removeInvite(gameId);

    const serverGame = createGame(gameId, (max) => randomInt(max));
    const players: Record<1 | 2, UserId> = {
      1: invite.inviterUserId,
      2: userId,
    };

    const activeGame: ActiveGame = {
      serverGame,
      gameType: "minesweeper-flags",
      channelId: invite.channelId,
      players,
      createdAt: Date.now(),
    };
    this.store.addGame(gameId, activeGame);

    const state = toGameState(serverGame);
    const startedEvent = serverEvent.gameStarted({
      gameId,
      gameType: "minesweeper-flags",
      channelId: invite.channelId,
      players: { "1": players[1], "2": players[2] },
      state: {
        ...state,
        scores: { "1": state.scores[1], "2": state.scores[2] },
        bombUsed: { "1": state.bombUsed[1], "2": state.bombUsed[2] },
      },
    });

    await Promise.all([
      this.mutationBus?.publish({ userId: players[1], event: startedEvent }),
      this.mutationBus?.publish({ userId: players[2], event: startedEvent }),
    ]);

    return { ok: true, channelId: invite.channelId, inviterUserId: invite.inviterUserId };
  }

  async decline(
    userId: UserId,
    gameId: GameId,
  ): Promise<{ ok: true } | { error: string }> {
    const invite = this.store.getInvite(gameId);
    if (!invite) return { error: "invite_not_found" };
    if (invite.targetUserId !== userId) return { error: "not_target" };

    this.store.removeInvite(gameId);

    await this.mutationBus?.publish({
      userId: invite.inviterUserId,
      event: serverEvent.gameDeclined({
        gameId,
        declinedByUserId: userId,
      }),
    });

    return { ok: true };
  }

  async move(
    userId: UserId,
    gameId: GameId,
    action: GameAction,
  ): Promise<
    | { ok: true; finished?: { channelId: ChannelId; scores: Record<1 | 2, number>; winnerUserId: UserId | null } }
    | { error: string }
  > {
    const activeGame = this.store.getGame(gameId);
    if (!activeGame) return { error: "game_not_found" };

    const seat = this.store.seatForUser(activeGame, userId);
    if (seat === undefined) return { error: "not_a_player" };

    const result = applyAction(activeGame.serverGame, seat, action);
    if ("error" in result) return { error: result.error };

    const wireResult = {
      ...result,
      scores: { "1": result.scores[1], "2": result.scores[2] },
      cellChanges: result.cellChanges.map((c) => ({
        ...c,
        state:
          c.state.kind === "flagged"
            ? { ...c.state, owner: c.state.owner as 1 | 2 }
            : c.state,
      })),
    };

    const moveResultEvent = serverEvent.gameMoveResult({
      gameId,
      result: wireResult,
    });

    await Promise.all([
      this.mutationBus?.publish({
        userId: activeGame.players[1],
        event: moveResultEvent,
      }),
      this.mutationBus?.publish({
        userId: activeGame.players[2],
        event: moveResultEvent,
      }),
    ]);

    if (result.phase === "finished") {
      const winnerSeat = result.winner;
      const winnerUserId = winnerSeat
        ? activeGame.players[winnerSeat]
        : null;

      const endedEvent = serverEvent.gameEnded({
        gameId,
        winnerUserId,
        scores: { "1": result.scores[1], "2": result.scores[2] },
        players: {
          "1": activeGame.players[1],
          "2": activeGame.players[2],
        },
      });

      await Promise.all([
        this.mutationBus?.publish({
          userId: activeGame.players[1],
          event: endedEvent,
        }),
        this.mutationBus?.publish({
          userId: activeGame.players[2],
          event: endedEvent,
        }),
      ]);

      this.store.removeGame(gameId);

      return {
        ok: true,
        finished: {
          channelId: activeGame.channelId,
          scores: { 1: result.scores[1], 2: result.scores[2] },
          winnerUserId,
        },
      };
    }

    return { ok: true };
  }
}
