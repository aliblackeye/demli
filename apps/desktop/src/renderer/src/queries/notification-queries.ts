/**
 * Notification-mute queries + mutations (migration 0013 — "Kanalı Sustur" /
 * "Sunucuyu Sustur"). The list query seeds a fast O(1) lookup in the chat store so
 * ChannelItem / GroupRail read mute state without a refetch; the mutations update
 * that lookup optimistically and reconcile against the server on settle. The
 * `notification_mute.updated` realtime event keeps the SAME lookup live across
 * the user's other devices (see realtime/connection.ts).
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NotificationMuteMode, NotificationMuteScope } from "@demli/types";
import { api } from "../lib/api-client";
import { queryKeys } from "../lib/query-client";
import { useChatStore } from "../stores/chat-store";

/** Duration presets (ms) for the timed mute options. */
export const MUTE_DURATIONS = {
  min15: 15 * 60 * 1000,
  hour1: 60 * 60 * 1000,
  hours8: 8 * 60 * 60 * 1000,
} as const;

/** Fetch the caller's mutes once and seed the store lookup (mount in AppShell). */
export function useNotificationMutes() {
  return useQuery({
    queryKey: queryKeys.notificationMutes,
    queryFn: async () => {
      const { mutes } = await api.listNotificationMutes();
      useChatStore.getState().replaceNotificationMutes(mutes);
      return mutes;
    },
  });
}

export interface SetMuteVars {
  scope: NotificationMuteScope;
  targetId: string;
  mode: NotificationMuteMode;
  /** Auto-expiry in ms from now; omit for an indefinite mute. */
  durationMs?: number;
}

function untilFrom(durationMs: number | undefined): string | null {
  return durationMs ? new Date(Date.now() + durationMs).toISOString() : null;
}

export function useSetNotificationMute() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: SetMuteVars) => {
      const until = untilFrom(vars.durationMs);
      return api.setNotificationMute({
        scope: vars.scope,
        targetId: vars.targetId,
        mode: vars.mode,
        ...(until ? { until } : {}),
      });
    },
    onMutate: (vars) => {
      // Optimistic: paint the mute immediately (the row dims, the badge drops).
      useChatStore
        .getState()
        .setLocalMute(vars.scope, vars.targetId, { mode: vars.mode, until: untilFrom(vars.durationMs) });
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.notificationMutes }),
  });
}

export function useClearNotificationMute() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { scope: NotificationMuteScope; targetId: string }) =>
      api.clearNotificationMute(vars.scope, vars.targetId),
    onMutate: (vars) => {
      useChatStore.getState().clearLocalMute(vars.scope, vars.targetId);
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.notificationMutes }),
  });
}
