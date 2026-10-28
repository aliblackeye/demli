/**
 * TanStack Query mutations for MSN Games (Minesweeper Flags) — mobile mirror.
 *
 * Game state flows through the Zustand game-store via realtime events, not
 * through the query cache — these mutations are fire-and-forget REST calls
 * that trigger server-side event fan-out.
 */

import { useMutation } from "@tanstack/react-query";
import type { GameId, UserId, ChannelId } from "@demli/types";
import type { GameType, WireGameAction } from "@demli/protocol";
import { getApi } from "../lib/clients";
import { useGameStore } from "../stores/game-store";

export function useGameInvite() {
  return useMutation({
    mutationFn: (input: {
      targetUserId: UserId;
      channelId: ChannelId;
      gameType: GameType;
    }) => getApi().gameInvite(input),
    onSuccess: (data) => {
      useGameStore.getState().setOutgoingInvite(data.gameId);
    },
  });
}

export function useGameAccept() {
  return useMutation({
    mutationFn: (gameId: GameId) => getApi().gameAccept(gameId),
  });
}

export function useGameDecline() {
  return useMutation({
    mutationFn: (gameId: GameId) => getApi().gameDecline(gameId),
  });
}

export function useGameMove() {
  return useMutation({
    mutationFn: (input: { gameId: GameId; action: WireGameAction }) =>
      getApi().gameMove(input.gameId, input.action),
  });
}
