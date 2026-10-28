import type { UserId, GameId } from "@demli/types";
import type { ServerGame, PlayerSeat } from "@demli/games";

export interface ActiveGame {
  serverGame: ServerGame;
  gameType: "minesweeper-flags";
  channelId: string;
  players: Record<PlayerSeat, UserId>;
  createdAt: number;
}

export interface PendingInvite {
  gameId: GameId;
  gameType: "minesweeper-flags";
  inviterUserId: UserId;
  targetUserId: UserId;
  channelId: string;
  createdAt: number;
}

const INVITE_TTL_MS = 60_000;
const GAME_TTL_MS = 30 * 60_000;

export class GameStore {
  private games = new Map<GameId, ActiveGame>();
  private invites = new Map<GameId, PendingInvite>();
  private userActiveGame = new Map<UserId, GameId>();

  addInvite(invite: PendingInvite): void {
    this.invites.set(invite.gameId, invite);
  }

  getInvite(gameId: GameId): PendingInvite | undefined {
    const inv = this.invites.get(gameId);
    if (!inv) return undefined;
    if (Date.now() - inv.createdAt > INVITE_TTL_MS) {
      this.invites.delete(gameId);
      return undefined;
    }
    return inv;
  }

  removeInvite(gameId: GameId): void {
    this.invites.delete(gameId);
  }

  addGame(gameId: GameId, game: ActiveGame): void {
    this.games.set(gameId, game);
    this.userActiveGame.set(game.players[1], gameId);
    this.userActiveGame.set(game.players[2], gameId);
  }

  getGame(gameId: GameId): ActiveGame | undefined {
    const g = this.games.get(gameId);
    if (!g) return undefined;
    if (Date.now() - g.createdAt > GAME_TTL_MS) {
      this.removeGame(gameId);
      return undefined;
    }
    return g;
  }

  getUserActiveGameId(userId: UserId): GameId | undefined {
    return this.userActiveGame.get(userId);
  }

  removeGame(gameId: GameId): void {
    const game = this.games.get(gameId);
    if (game) {
      if (this.userActiveGame.get(game.players[1]) === gameId) {
        this.userActiveGame.delete(game.players[1]);
      }
      if (this.userActiveGame.get(game.players[2]) === gameId) {
        this.userActiveGame.delete(game.players[2]);
      }
    }
    this.games.delete(gameId);
  }

  seatForUser(game: ActiveGame, userId: UserId): PlayerSeat | undefined {
    if (game.players[1] === userId) return 1;
    if (game.players[2] === userId) return 2;
    return undefined;
  }

  cleanup(): void {
    const now = Date.now();
    for (const [id, inv] of this.invites) {
      if (now - inv.createdAt > INVITE_TTL_MS) this.invites.delete(id);
    }
    for (const [id, game] of this.games) {
      if (now - game.createdAt > GAME_TTL_MS) this.removeGame(id);
    }
  }
}
