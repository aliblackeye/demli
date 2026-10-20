import { Expo, type ExpoPushMessage, type ExpoPushTicket } from "expo-server-sdk";
import type { UserId } from "@demli/types";
import type { UserPushToken } from "@demli/db";
import {
  PushReceiptTracker,
  pushTokenFingerprint,
  type ExpoReceiptClient,
  type PendingReceipt,
} from "./push-receipts.js";

/**
 * Mobile push via the Expo Push service (task #46).
 *
 * The server stores Expo push tokens and POSTs to Expo's Push API; Expo bridges
 * to FCM (Android) / APNs (iOS). No Firebase Admin SDK runs here — the service
 * account is uploaded to Expo, out of this codebase's scope.
 *
 * Delivery is BEST-EFFORT: a message/friend request is already persisted before
 * a push is attempted, so a push failure must never surface to the caller. The
 * durable side effect is pruning dead tokens (`DeviceNotRegistered`), from the
 * ticket immediately and from the receipt ~15 minutes later (push-receipts.ts).
 */

/**
 * The Android notification channel every push is posted on. MUST equal the
 * channel the mobile app creates at startup (`ANDROID_CHANNEL_ID` in
 * apps/mobile/src/push/push-manager.ts — a test pins the two together).
 *
 * ONE channel for messages AND call rings, on purpose: it is created with HIGH
 * importance (heads-up + sound), and an Android channel is created by app JS at
 * startup — a push naming a channel an older install never created would fall
 * back to FCM's low-importance "Miscellaneous" channel. Every shipped build
 * (runtime 2.0.0 and 2.1.0) creates exactly this id, so it is the only one the
 * server may target.
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
   * Android notification `tag`. Used per channel, per DM conversation and per
   * call; omitted → notifications stack (mentions, friend pushes).
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

/**
 * The log/metrics name of a push, derived from its `data.type` so no call site
 * has to repeat it. Never carries content.
 */
export function pushKindOf(notification: PushNotification): string {
  const type = notification.data?.["type"];
  switch (type) {
    case "call_invite":
      return "call_ring";
    case "call_ended":
      return notification.silent ? "call_cleared" : "call_missed";
    case undefined:
      return "unknown";
    default:
      return typeof type === "string" ? type : "unknown";
  }
}

/** What one `sendToUsers` did — the numbers the dispatch log line carries. */
export interface PushSendSummary {
  /** Registered device tokens for the audience (before format filtering). */
  tokens: number;
  /** Tickets Expo accepted. */
  ok: number;
  /** Ticket error counts by Expo error code (`chunk_failed` = the HTTP call failed). */
  errors: Record<string, number>;
  /** Malformed tokens dropped without sending. */
  invalid: number;
  /** Rows deleted (ticket `DeviceNotRegistered` + malformed). */
  pruned: number;
  /** Fingerprints of the targeted tokens (see `pushTokenFingerprint`); capped. */
  tokenIds: string[];
}

export interface PushService {
  /**
   * Push `notification` to every device of `userIds`. Resolves once tickets are
   * processed and dead tokens pruned; never rejects (all errors are swallowed
   * and logged). Returns a summary when the implementation has one (test stubs
   * may return nothing).
   */
  sendToUsers(
    userIds: readonly UserId[],
    notification: PushNotification,
  ): Promise<PushSendSummary | void>;
}

/** The Expo methods used here — `Expo` satisfies this structurally, tests inject a stub. */
export interface ExpoPushClient extends Partial<ExpoReceiptClient> {
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
  /** Structured log sink (production passes the process logger). */
  log?: (message: string) => void;
  /**
   * Receipt checker. Omitted → built automatically when `expo` can fetch
   * receipts (the real client can; most test stubs cannot). `false` disables.
   */
  receipts?: PushReceiptTracker | false;
}

/** Fingerprints listed per dispatch log line, at most. */
const MAX_LOGGED_TOKENS = 8;

function errToMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class ExpoPushService implements PushService {
  private readonly tokens: PushTokenStore;
  private readonly expo: ExpoPushClient;
  private readonly log: (message: string) => void;
  readonly receipts: PushReceiptTracker | null;

  constructor(deps: ExpoPushServiceDeps) {
    this.tokens = deps.tokens;
    this.expo = deps.expo;
    this.log = deps.log ?? (() => undefined);
    if (deps.receipts === false) {
      this.receipts = null;
    } else if (deps.receipts) {
      this.receipts = deps.receipts;
    } else {
      const { chunkPushNotificationReceiptIds, getPushNotificationReceiptsAsync } = deps.expo;
      this.receipts =
        chunkPushNotificationReceiptIds && getPushNotificationReceiptsAsync
          ? new PushReceiptTracker({
              expo: {
                chunkPushNotificationReceiptIds: (ids) =>
                  chunkPushNotificationReceiptIds.call(deps.expo, ids),
                getPushNotificationReceiptsAsync: (ids) =>
                  getPushNotificationReceiptsAsync.call(deps.expo, ids),
              },
              deleteByTokens: (tokens) => deps.tokens.deleteByTokens(tokens),
              log: this.log,
            })
          : null;
    }
  }

  async sendToUsers(
    userIds: readonly UserId[],
    notification: PushNotification,
  ): Promise<PushSendSummary> {
    const summary: PushSendSummary = {
      tokens: 0,
      ok: 0,
      errors: {},
      invalid: 0,
      pruned: 0,
      tokenIds: [],
    };
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return summary;

    const registered = await this.tokens.listTokensForUsers(ids);
    summary.tokens = registered.length;
    if (registered.length === 0) return summary;
    summary.tokenIds = registered
      .slice(0, MAX_LOGGED_TOKENS)
      .map(({ token }) => pushTokenFingerprint(token));

    const kind = pushKindOf(notification);
    // Tokens Expo confirms are gone (or were never well-formed) get pruned once
    // at the end. A Set dedupes should a token appear on multiple messages.
    const deadTokens = new Set<string>();
    const messages: ExpoPushMessage[] = [];
    for (const { token } of registered) {
      if (!Expo.isExpoPushToken(token)) {
        // Defensive: the endpoint validates format, but a manual insert / schema
        // drift could leave a malformed token — drop and prune it.
        deadTokens.add(token);
        summary.invalid += 1;
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
        // Collapse a burst into one device notification (#94): `collapseId` =
        // APNs apns-collapse-id (iOS), `tag` = Android notification tag (a
        // same-tag push replaces the previous). Absent → stack.
        ...(notification.collapseKey
          ? { collapseId: notification.collapseKey, tag: notification.collapseKey }
          : {}),
        priority: "high",
      });
    }

    const pendingReceipts: PendingReceipt[] = [];
    // `to` is always a single string here, so ticket i maps to message i's token.
    const chunks = this.expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      let tickets: ExpoPushTicket[];
      try {
        tickets = await this.expo.sendPushNotificationsAsync(chunk);
      } catch (err) {
        // Expo/network outage — best-effort: log and move on (no throw).
        summary.errors["chunk_failed"] = (summary.errors["chunk_failed"] ?? 0) + chunk.length;
        this.log(`[push] chunk send failed: ${errToMessage(err)}`);
        continue;
      }
      tickets.forEach((ticket, i) => {
        const to = chunk[i]?.to;
        const token = typeof to === "string" ? to : undefined;
        if (ticket.status === "ok") {
          summary.ok += 1;
          if (token && ticket.id) pendingReceipts.push({ receiptId: ticket.id, token, kind });
          return;
        }
        const errorCode = ticket.details?.error ?? "unknown";
        summary.errors[errorCode] = (summary.errors[errorCode] ?? 0) + 1;
        if (errorCode === "DeviceNotRegistered") {
          const dead = ticket.details?.expoPushToken ?? token;
          if (dead) deadTokens.add(dead);
        } else {
          // DeveloperError / InvalidCredentials / MessageTooBig / rate limits:
          // surface for ops, but do NOT prune (the token may still be valid).
          this.log(
            `[push] ticket error (${errorCode}): ${JSON.stringify({
              kind,
              tok: token ? pushTokenFingerprint(token) : null,
              message: ticket.message,
            })}`,
          );
        }
      });
    }

    this.receipts?.track(pendingReceipts);

    if (deadTokens.size > 0) {
      try {
        summary.pruned = await this.tokens.deleteByTokens([...deadTokens]);
        if (summary.pruned > 0) this.log(`[push] pruned ${summary.pruned} dead device token(s)`);
      } catch (err) {
        this.log(`[push] pruning dead tokens failed: ${errToMessage(err)}`);
      }
    }
    return summary;
  }
}

/** Construct the production push service (real Expo client over the token repo). */
export function createExpoPushService(deps: {
  tokens: PushTokenStore;
  log?: (message: string) => void;
  expo?: ExpoPushClient;
  receipts?: PushReceiptTracker | false;
}): ExpoPushService {
  return new ExpoPushService({
    tokens: deps.tokens,
    expo: deps.expo ?? new Expo(),
    log: deps.log,
    ...(deps.receipts !== undefined ? { receipts: deps.receipts } : {}),
  });
}
