/**
 * TanStack Query mutations for MSN Games (Minesweeper Flags).
 *
 * Game state flows through the Zustand game-store via realtime events, not
 * through the query cache — these mutations are fire-and-forget REST calls
 * that trigger server-side event fan-out.
 */

import { useMutation } from "@tanstack/react-query";
import type { GameId, UserId, ChannelId } from "@demli/types";
import type { GameType, WireGameAction } from "@demli/protocol";
import { api } from "../lib/api-client";
import { useGameStore } from "../stores/game-store";

export function useGameInvite() {
  return useMutation({
    mutationFn: (input: {
      targetUserId: UserId;
      channelId: ChannelId;
      gameType: GameType;
    }) => api.gameInvite(input),
    onSuccess: (data) => {
      useGameStore.getState().setOutgoingInvite(data.gameId);
    },
  });
}

export function useGameAccept() {
  return useMutation({
    mutationFn: (gameId: GameId) => api.gameAccept(gameId),
  });
}

export function useGameDecline() {
  return useMutation({
    mutationFn: (gameId: GameId) => api.gameDecline(gameId),
  });
}

export function useGameMove() {
  return useMutation({
    mutationFn: (input: { gameId: GameId; action: WireGameAction }) =>
      api.gameMove(input.gameId, input.action),
  });
}
