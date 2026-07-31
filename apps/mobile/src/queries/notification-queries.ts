/**
 * Notification-mute mutations (migration 0013). Optimistically update the chat
 * store so the row dims / drops its badge instantly; the server also fans out
 * `notification_mute.updated` to this device, which is idempotent with the
 * optimistic write. On error we roll back to the pre-mutation entry.
 */
import { useMutation } from "@tanstack/react-query";
import type { NotificationMuteScope } from "@demli/types";
import { getApi, type SetNotificationMuteInput } from "../lib/clients";
import { muteKey, useChatStore, type MuteEntry } from "../stores/chat-store";

function snapshot(scope: NotificationMuteScope, targetId: string): MuteEntry | undefined {
  return useChatStore.getState().notificationMutes[muteKey(scope, targetId)];
}

function restore(scope: NotificationMuteScope, targetId: string, prev: MuteEntry | undefined): void {
  const store = useChatStore.getState();
  if (prev) store.setNotificationMute(scope, targetId, prev);
  else store.clearNotificationMute(scope, targetId);
}

export function useSetNotificationMute() {
  return useMutation({
    mutationFn: (input: SetNotificationMuteInput) => getApi().setNotificationMute(input),
    onMutate: (input): { prev: MuteEntry | undefined } => {
      const prev = snapshot(input.scope, input.targetId);
      useChatStore
        .getState()
        .setNotificationMute(input.scope, input.targetId, {
          mode: input.mode,
          until: input.until ?? null,
        });
      return { prev };
    },
    onError: (_err, input, ctx) => {
      restore(input.scope, input.targetId, ctx?.prev);
    },
  });
}

export function useClearNotificationMute() {
  return useMutation({
    mutationFn: (vars: { scope: NotificationMuteScope; targetId: string }) =>
      getApi().clearNotificationMute(vars.scope, vars.targetId),
    onMutate: (vars): { prev: MuteEntry | undefined } => {
      const prev = snapshot(vars.scope, vars.targetId);
      useChatStore.getState().clearNotificationMute(vars.scope, vars.targetId);
      return { prev };
    },
    onError: (_err, vars, ctx) => {
      restore(vars.scope, vars.targetId, ctx?.prev);
    },
  });
}
