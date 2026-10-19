import { Expo, type ExpoPushMessage, type ExpoPushTicket } from "expo-server-sdk";
import type { UserId } from "@demli/types";
import type { UserPushToken } from "@demli/db";

/**
 * Mobile push via the Expo Push service (task #46).
 *
 * The server stores Expo push tokens and POSTs to Expo's Push API; Expo bridges
 * to FCM (Android) / APNs (iOS). No Firebase Admin SDK runs here — the service
 * account is uploaded to Expo, out of this codebase's scope.
 *
 * Delivery is BEST-EFFORT: a message/friend request is already persisted before
 * a push is attempted, so a push failure must never surface to the caller. The
 * one durable side effect is pruning dead tokens (`DeviceNotRegistered`).
 */

/**
 * The Android notification channel every push is posted on. MUST equal the
 * channel the mobile app creates at startup (`ANDROID_CHANNEL_ID` in
 * apps/mobile/src/push/push-manager.ts — a test pins the two together).
 *
 * A push that names no channel lands on Expo's `default` channel, which the app
 * deletes on startup because its sound points at a missing file; Android then
 * recreates it with those dead settings, so rings arrived silent or on a
 * low-importance channel.
 */
export const ANDROID_PUSH_CHANNEL_ID = "messages-v2";

/** The user-facing content of a push. `data` rides along for client navigation. */
export interface PushNotification {
  /** Ignored for a {@link silent} push. */
  title: string;
  /** Ignored for a {@link silent} push. */
  body: string;
  /** Opaque nav payload (e.g. `{ type, channelId, dmId, messageId }`). */
  data?: Record<string, unknown>;
  /**
   * Per-topic collapse key (#94 anti-spam). When set, rapid pushes sharing it
   * REPLACE each other on the device into a single, latest notification instead
   * of stacking N — mapped to APNs `apns-collapse-id` (iOS `collapseId`) and the
   * Android notification `tag`. Used to collapse a burst of messages in the SAME
   * channel; omitted → notifications stack as before (DM, friend, mention pushes).
   */
  collapseKey?: string;
  /**
   * How long the push service may hold an undelivered push (seconds). Omitted →
   * the provider default (up to four weeks on FCM). A call ring needs this: a
   * phone that comes back online must not ring for a call that ended long ago.
   */
  ttlSeconds?: number;
  /**
   * Data-only: no title, body or sound, so nothing is shown by the OS. For
   * signals a client acts on itself (dismissing a ring answered elsewhere).
   */
  silent?: boolean;
}

export interface PushService {
  /**
   * Push `notification` to every device of `userIds`. Resolves once tickets are
   * processed and dead tokens pruned; never rejects (all errors are swallowed
   * and logged).
   */
  sendToUsers(userIds: readonly UserId[], notification: PushNotification): Promise<void>;
}

/** The two Expo methods used here — `Expo` satisfies this structurally, tests inject a stub. */
export interface ExpoPushClient {
  chunkPushNotifications(messages: ExpoPushMessage[]): ExpoPushMessage[][];
  sendPushNotificationsAsync(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]>;
}

/** The device-token operations the push path needs (a slice of the repo). */
export interface PushTokenStore {
  listTokensForUsers(userIds: readonly UserId[]): Promise<UserPushToken[]>;
  deleteByTokens(tokens: readonly string[]): Promise<number>;
}

export interface ExpoPushServiceDeps {
  tokens: PushTokenStore;
  expo: ExpoPushClient;
  /** Structured log sink (production passes the Fastify logger's info). */
  log?: (message: string) => void;
}

function errToMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class ExpoPushService implements PushService {
  private readonly tokens: PushTokenStore;
  private readonly expo: ExpoPushClient;
  private readonly log: (message: string) => void;

  constructor(deps: ExpoPushServiceDeps) {
    this.tokens = deps.tokens;
    this.expo = deps.expo;
    this.log = deps.log ?? (() => undefined);
  }

  async sendToUsers(
    userIds: readonly UserId[],
    notification: PushNotification,
  ): Promise<void> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return;

    const registered = await this.tokens.listTokensForUsers(ids);
    if (registered.length === 0) return;

    // Tokens Expo confirms are gone (or were never well-formed) get pruned once
    // at the end. A Set dedupes should a token appear on multiple messages.
    const deadTokens = new Set<string>();
    const messages: ExpoPushMessage[] = [];
    for (const { token } of registered) {
      if (!Expo.isExpoPushToken(token)) {
        // Defensive: the endpoint validates format, but a manual insert / schema
        // drift could leave a malformed token — drop and prune it.
        deadTokens.add(token);
        continue;
      }
      messages.push({
        to: token,
        ...(notification.silent
          ? { _contentAvailable: true }
          : { sound: "default", title: notification.title, body: notification.body }),
        ...(notification.data ? { data: notification.data } : {}),
        channelId: ANDROID_PUSH_CHANNEL_ID,
        ...(notification.ttlSeconds !== undefined ? { ttl: notification.ttlSeconds } : {}),
        // Collapse a channel's message burst into one device notification (#94):
        // `collapseId` = APNs apns-collapse-id (iOS), `tag` = Android notification
        // tag (a same-tag push replaces the previous). Absent → stack as before.
        ...(notification.collapseKey
          ? { collapseId: notification.collapseKey, tag: notification.collapseKey }
          : {}),
        priority: "high",
      });
    }

    // `to` is always a single string here, so ticket i maps to message i's token.
    const chunks = this.expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      let tickets: ExpoPushTicket[];
      try {
        tickets = await this.expo.sendPushNotificationsAsync(chunk);
      } catch (err) {
        // Expo/network outage — best-effort: log and move on (no throw).
        this.log(`[push] chunk send failed: ${errToMessage(err)}`);
        continue;
      }
      tickets.forEach((ticket, i) => {
        if (ticket.status !== "error") return;
        const errorCode = ticket.details?.error;
        if (errorCode === "DeviceNotRegistered") {
          const to = chunk[i]?.to;
          const dead =
            ticket.details?.expoPushToken ?? (typeof to === "string" ? to : undefined);
          if (dead) deadTokens.add(dead);
        } else {
          // DeveloperError / InvalidCredentials / MessageTooBig / rate limits:
          // surface for ops, but do NOT prune (the token may still be valid).
          this.log(`[push] ticket error (${errorCode ?? "unknown"}): ${ticket.message}`);
        }
      });
    }

    if (deadTokens.size > 0) {
      try {
        const removed = await this.tokens.deleteByTokens([...deadTokens]);
        if (removed > 0) this.log(`[push] pruned ${removed} dead device token(s)`);
      } catch (err) {
        this.log(`[push] pruning dead tokens failed: ${errToMessage(err)}`);
      }
    }
  }
}

/** Construct the production push service (real Expo client over the token repo). */
export function createExpoPushService(deps: {
  tokens: PushTokenStore;
  log?: (message: string) => void;
  expo?: ExpoPushClient;
}): ExpoPushService {
  return new ExpoPushService({
    tokens: deps.tokens,
    expo: deps.expo ?? new Expo(),
    log: deps.log,
  });
}
