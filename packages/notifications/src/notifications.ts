import type { PresenceReader } from "@demli/db";
import type { UserId } from "@demli/types";
import { pushKindOf, type PushNotification, type PushService } from "./push.js";

/** Recipient ids listed per dispatch line, at most (bounded log size). */
const MAX_LOGGED_USERS = 10;

/** First 8 chars of a UUID — enough to find the row, short enough to scan. */
function shortId(id: string): string {
  return id.slice(0, 8);
}

/** The non-content id a push is about (message / call / friend), for correlation. */
function refOf(notification: PushNotification): string | null {
  const data = notification.data ?? {};
  for (const key of ["messageId", "callId", "userId"]) {
    const value = data[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

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
    const ids = [...new Set(recipientUserIds)];
    if (ids.length === 0) return;
    // ONE structured line per dispatch (field report 2026-10-20: a message that
    // produced no notification left no trace, so "was a push even sent?" could
    // not be answered). Ids and counts only — never the title/body, never a
    // token in clear (fingerprints, see `pushTokenFingerprint`).
    const line: Record<string, unknown> = {
      kind: pushKindOf(notification),
      ref: refOf(notification),
      gate: gateAway ? "away" : "always",
      recipients: ids.length,
    };
    try {
      const audience = gateAway ? await deps.presence.filterAway(ids) : ids;
      line["away"] = audience.length;
      line["users"] = audience.slice(0, MAX_LOGGED_USERS).map(shortId);
      if (audience.length > 0) {
        const summary = await deps.push.sendToUsers(audience, notification);
        if (summary) {
          line["tokens"] = summary.tokens;
          line["ok"] = summary.ok;
          line["errors"] = summary.errors;
          if (summary.invalid > 0) line["invalid"] = summary.invalid;
          if (summary.pruned > 0) line["pruned"] = summary.pruned;
          line["tok"] = summary.tokenIds;
        }
      }
    } catch (err) {
      line["failed"] = err instanceof Error ? err.message : String(err);
      log(`[push] notify failed: ${String(line["failed"])}`);
    }
    log(`[push] dispatch ${JSON.stringify(line)}`);
  }

  return {
    notify: (recipientUserIds, notification) => dispatch(recipientUserIds, notification, true),
    notifyAlways: (recipientUserIds, notification) =>
      dispatch(recipientUserIds, notification, false),
  };
}
