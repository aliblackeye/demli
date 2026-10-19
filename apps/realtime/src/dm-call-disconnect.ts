/**
 * "The caller vanished" ring reaper (founder P0, 2026-07-27).
 *
 * When a user's LAST WebSocket closes, any call they are RINGING OUT on is dead
 * on arrival: nobody is behind the ringback, so the callee is being rung by
 * someone who cannot answer, and the row would sit `ringing` until its 30s
 * deadline (or, for a row with no stamped deadline, forever — blocking that DM
 * through `dm_calls_one_live_per_dm`). This cancels it at the source instead of
 * waiting for a timer nobody is running.
 *
 * THE THREE DELIBERATE NON-ACTIONS, because each of them would be a regression:
 *
 *  1. A CALLEE losing its socket does NOT cancel the ring. A phone is rung by
 *     PUSH — it may hold no socket at all — so "callee offline ⇒ stop ringing"
 *     would break every ring to a backgrounded mobile client.
 *
 *  2. An ACCEPTED (`active`) call is NEVER ended here. Media does not ride this
 *     socket — it is a LiveKit/WebRTC session on a completely different transport
 *     (CLAUDE.md §10/§35). A user in a tunnel routinely loses the WebSocket while
 *     the SFU connection survives on UDP/TURN, so hanging up on a WS close would
 *     cut live conversations. The authority for an abandoned call is the media
 *     plane itself, in the API's sweeper.
 *
 *  3. Nothing fires until {@link DEFAULT_CALLER_DROP_GRACE_MS} has passed AND the
 *     user is STILL offline. A reconnect (which every deploy causes) must not
 *     kill the caller's own ring.
 *
 * Presence — not this process's socket map — decides "still offline", so the
 * check is correct across gateway replicas.
 */

import type { RealtimeMutationPublisher, Repositories } from "@demli/db";
import { callMissedPush, type OfflineNotifier } from "@demli/notifications";
import { serverEvent } from "@demli/protocol";
import type { UserId } from "@demli/types";

/**
 * How long a caller may be gone before their outgoing ring is withdrawn.
 *
 * Short by design: the whole ring window is only 30s, so a long grace would let
 * the ring outlive the caller for most of its life. Eight seconds comfortably
 * covers an ordinary socket blip / app-server restart reconnect (clients
 * reconnect with a sub-second first backoff) while still cutting the ring well
 * inside the window when the caller is genuinely gone.
 */
export const DEFAULT_CALLER_DROP_GRACE_MS = 8_000;

export interface DmCallDisconnectReaperDeps {
  repos: Repositories;
  /** Publishes `call.ended` to the callee (and the caller's other devices). */
  mutationBus?: RealtimeMutationPublisher;
  /**
   * Replaces the withdrawn ring on the callee's phone with the missed-call line;
   * a backgrounded phone never sees the `call.ended` event. Omitted ⇒ no push.
   */
  notifier?: OfflineNotifier;
  /** "Is this user still fully offline?" — presence-backed, cross-replica. */
  isOffline: (userId: UserId) => Promise<boolean>;
  graceMs?: number;
  log?: (message: string) => void;
  /** Timer seam for tests. */
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface DmCallDisconnectReaper {
  /** Call when a user's last connection closed. Never throws. */
  onUserOffline(userId: UserId): void;
  /** Cancel every pending check (gateway shutdown). */
  stop(): void;
}

export function createDmCallDisconnectReaper(
  deps: DmCallDisconnectReaperDeps,
): DmCallDisconnectReaper {
  const graceMs = deps.graceMs ?? DEFAULT_CALLER_DROP_GRACE_MS;
  const log = deps.log ?? (() => undefined);
  const setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  /** One pending check per user — a flapping socket must not queue N sweeps. */
  const pending = new Map<UserId, unknown>();

  async function reap(userId: UserId): Promise<void> {
    pending.delete(userId);
    // Came back within the grace window (the deploy-reconnect case) — their ring
    // is theirs again, leave it alone.
    if (!(await deps.isOffline(userId))) return;

    const missed = await deps.repos.calls.missRingingByCaller(userId, new Date());
    for (const call of missed) {
      // Both sides: the callee must stop ringing, and the caller's OTHER devices
      // (a phone still holding the ring UI) must drop it too.
      for (const target of [call.calleeId, call.callerId]) {
        await deps.mutationBus?.publish({
          userId: target,
          event: serverEvent.callEnded({ callId: call.id, reason: "timeout" }),
        });
      }
    }
    if (missed.length > 0) {
      log(`caller ${userId} went offline — withdrew ${missed.length} outgoing ring(s)`);
      const caller = deps.notifier ? await deps.repos.users.findById(userId) : null;
      if (caller) {
        for (const call of missed) {
          await deps.notifier?.notifyAlways(
            [call.calleeId],
            callMissedPush({ callerName: caller.displayName, callId: call.id, reason: "timeout" }),
          );
        }
      }
    }
  }

  return {
    onUserOffline(userId: UserId): void {
      const existing = pending.get(userId);
      if (existing !== undefined) clearTimer(existing);
      const handle = setTimer(() => {
        void reap(userId).catch((err) =>
          log(`ring reap failed: ${err instanceof Error ? err.message : String(err)}`),
        );
      }, graceMs);
      (handle as { unref?: () => void }).unref?.();
      pending.set(userId, handle);
    },
    stop(): void {
      for (const handle of pending.values()) clearTimer(handle);
      pending.clear();
    },
  };
}
