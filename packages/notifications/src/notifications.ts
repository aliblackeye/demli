import type { PresenceReader } from "@demli/db";
import type { UserId } from "@demli/types";
import type { PushNotification, PushService } from "./push.js";

/**
 * Away-gated push dispatch (task #46, WhatsApp model #110).
 *
 * A push should reach a user ONLY when they are not actively listening. "Actively
 * listening" is NOT merely "has a live socket": a backgrounded app keeps its WS
 * connection open, yet shows nothing on screen. So the gate is "AWAY" —
 * `presence.filterAway` — a user with no FOREGROUND connection (offline OR every
 * connection backgrounded). This wraps the presence reader and the push service
 * so a call site is a single best-effort line:
 *
 *   void notifier?.notify([recipientId], { title, body, data });
 *
 * The audience is the AWAY subset of the given recipients. `notify` never
 * throws: the underlying message/friend-request is already persisted, so a
 * push failure must not fail the HTTP request.
 */
export interface OfflineNotifier {
  /**
   * AWAY-ONLY (#110): pushes to the subset of `recipientUserIds` with no
   * foreground WS connection — offline OR backgrounded. The default for message /
   * mention / friend-request pushes: a user with the app in the FOREGROUND
   * receives the in-app event/banner instead, so a push would only double up,
   * while a backgrounded (or offline) user gets the OS push they need.
   */
  notify(recipientUserIds: readonly UserId[], notification: PushNotification): Promise<void>;
  /**
   * Presence-INDEPENDENT: pushes to EVERY recipient regardless of connection or
   * app state. Exists for DM / group call ringing (#103): even a FOREGROUND app
   * (which the away gate excludes) may not be showing the call surface, so the
   * ring — and its same-tag retraction — MUST reach the device that `notify`
   * would suppress. Use ONLY for call invite / retraction; every other push stays
   * on `notify` so a foreground, listening user is never double-notified. Same
   * best-effort contract as `notify` (never throws).
   */
  notifyAlways(
    recipientUserIds: readonly UserId[],
    notification: PushNotification,
  ): Promise<void>;
}

export interface OfflineNotifierDeps {
  presence: PresenceReader;
  push: PushService;
  log?: (message: string) => void;
}

export function createOfflineNotifier(deps: OfflineNotifierDeps): OfflineNotifier {
  const log = deps.log ?? (() => undefined);

  /**
   * Shared best-effort send. `gateAway` toggles the presence filter: `notify`
   * pushes only to the AWAY subset (no foreground connection — offline or
   * backgrounded, #110); `notifyAlways` (call ringing, #103) sends to every
   * recipient. Both dedupe and swallow — a push failure never surfaces.
   */
  async function dispatch(
    recipientUserIds: readonly UserId[],
    notification: PushNotification,
    gateAway: boolean,
  ): Promise<void> {
    try {
      const ids = [...new Set(recipientUserIds)];
      if (ids.length === 0) return;
      const audience = gateAway ? await deps.presence.filterAway(ids) : ids;
      if (audience.length === 0) return;
      await deps.push.sendToUsers(audience, notification);
    } catch (err) {
      log(`[push] notify failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    notify: (recipientUserIds, notification) => dispatch(recipientUserIds, notification, true),
    notifyAlways: (recipientUserIds, notification) =>
      dispatch(recipientUserIds, notification, false),
  };
}
