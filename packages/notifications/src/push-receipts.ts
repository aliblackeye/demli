import { createHash } from "node:crypto";
import type { ExpoPushReceipt, ExpoPushReceiptId } from "expo-server-sdk";

/**
 * Expo push RECEIPTS (field report 2026-10-20).
 *
 * A push TICKET only says Expo accepted the message. Whether FCM/APNs then took
 * it — or answered "this device is gone" — is in the RECEIPT, which Expo makes
 * available a while later (it recommends checking ~15 minutes after sending,
 * and keeps receipts for about a day). We never fetched them, so a token whose
 * app was uninstalled or whose FCM registration rotated (`DeviceNotRegistered`
 * at the receipt stage) stayed in `user_push_tokens` forever and every push
 * kept being fanned out to it.
 *
 * This tracker is deliberately in-memory and best-effort: the ids live only in
 * this process, a restart loses them (Expo's own advice is that a missed
 * receipt check is harmless — the next send to that token will surface the
 * same error), and the queue is BOUNDED so a flood of pushes cannot grow memory
 * without limit.
 */

/** Expo's recommended wait before a receipt is worth asking for. */
export const PUSH_RECEIPT_DELAY_MS = 15 * 60 * 1000;

/** Hard cap on queued receipt ids; the oldest are dropped past it. */
export const PUSH_RECEIPT_MAX_PENDING = 10_000;

/**
 * A short, stable, NON-reversible fingerprint of a push token for logs. Tokens
 * are bearer-like (anyone holding one can push to that phone), so they never
 * appear in a log line in clear. Ops correlate a line with a DB row by hashing
 * the row's token the same way:
 *   node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex').slice(0,12))" '<token>'
 */
export function pushTokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

/** The receipt half of the Expo client — `Expo` satisfies it structurally. */
export interface ExpoReceiptClient {
  chunkPushNotificationReceiptIds(receiptIds: ExpoPushReceiptId[]): ExpoPushReceiptId[][];
  getPushNotificationReceiptsAsync(
    receiptIds: ExpoPushReceiptId[],
  ): Promise<{ [id: string]: ExpoPushReceipt }>;
}

/** One sent message whose receipt is still to be checked. */
export interface PendingReceipt {
  receiptId: string;
  /** Kept in memory only so a dead token can be pruned; never logged. */
  token: string;
  /** Push kind (dm_message, call_ring, ...) — for the log line. */
  kind: string;
}

export interface PushReceiptTrackerDeps {
  expo: ExpoReceiptClient;
  deleteByTokens: (tokens: readonly string[]) => Promise<number>;
  log?: (message: string) => void;
  delayMs?: number;
  maxPending?: number;
  /** Clock seam for tests. */
  now?: () => number;
  /**
   * Timer seam for tests. The default is an UNREF'd `setTimeout`, so a pending
   * receipt check never keeps a process alive on shutdown.
   */
  schedule?: (fn: () => void, ms: number) => void;
}

/** Summary of one receipt pass (also what the log line carries). */
export interface ReceiptCheckSummary {
  checked: number;
  ok: number;
  errors: Record<string, number>;
  missing: number;
  pruned: number;
  dropped: number;
}

interface QueuedReceipt extends PendingReceipt {
  dueAt: number;
}

function errToMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class PushReceiptTracker {
  private readonly expo: ExpoReceiptClient;
  private readonly deleteByTokens: (tokens: readonly string[]) => Promise<number>;
  private readonly log: (message: string) => void;
  private readonly delayMs: number;
  private readonly maxPending: number;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => void;

  /** FIFO by `dueAt` (every entry gets the same delay, so append order IS due order). */
  private queue: QueuedReceipt[] = [];
  private timerArmed = false;
  private dropped = 0;
  private flushing: Promise<ReceiptCheckSummary> | null = null;

  constructor(deps: PushReceiptTrackerDeps) {
    this.expo = deps.expo;
    this.deleteByTokens = deps.deleteByTokens;
    this.log = deps.log ?? (() => undefined);
    this.delayMs = deps.delayMs ?? PUSH_RECEIPT_DELAY_MS;
    this.maxPending = deps.maxPending ?? PUSH_RECEIPT_MAX_PENDING;
    this.now = deps.now ?? Date.now;
    this.schedule =
      deps.schedule ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        (handle as { unref?: () => void }).unref?.();
      });
  }

  /** Number of receipt ids waiting for their check. */
  get pending(): number {
    return this.queue.length;
  }

  /** Queue receipts for a check `delayMs` from now. Never throws. */
  track(entries: readonly PendingReceipt[]): void {
    if (entries.length === 0) return;
    const dueAt = this.now() + this.delayMs;
    for (const entry of entries) this.queue.push({ ...entry, dueAt });
    const overflow = this.queue.length - this.maxPending;
    if (overflow > 0) {
      // Bounded memory: shed the OLDEST — they are the closest to Expo's ~1 day
      // receipt expiry anyway, and losing one only delays a prune to the next send.
      this.queue.splice(0, overflow);
      this.dropped += overflow;
    }
    this.arm(this.delayMs);
  }

  private arm(ms: number): void {
    if (this.timerArmed) return;
    this.timerArmed = true;
    this.schedule(() => {
      this.timerArmed = false;
      void this.flushDue();
    }, Math.max(0, ms));
  }

  /**
   * Check every receipt that is due. Exposed for tests and shutdown hooks;
   * single-flight, never rejects. Re-arms the timer for whatever is not due yet.
   */
  flushDue(): Promise<ReceiptCheckSummary> {
    if (this.flushing) return this.flushing;
    const run = this.runFlush().finally(() => {
      this.flushing = null;
      const next = this.queue[0];
      if (next) this.arm(next.dueAt - this.now());
    });
    this.flushing = run;
    return run;
  }

  private async runFlush(): Promise<ReceiptCheckSummary> {
    const now = this.now();
    let dueCount = 0;
    while (dueCount < this.queue.length && this.queue[dueCount]!.dueAt <= now) dueCount += 1;
    const due = this.queue.splice(0, dueCount);
    const summary: ReceiptCheckSummary = {
      checked: due.length,
      ok: 0,
      errors: {},
      missing: 0,
      pruned: 0,
      dropped: this.dropped,
    };
    this.dropped = 0;
    if (due.length === 0) return summary;

    const byId = new Map(due.map((entry) => [entry.receiptId, entry]));
    const deadTokens = new Set<string>();

    for (const chunk of this.expo.chunkPushNotificationReceiptIds([...byId.keys()])) {
      let receipts: { [id: string]: ExpoPushReceipt };
      try {
        receipts = await this.expo.getPushNotificationReceiptsAsync(chunk);
      } catch (err) {
        // Expo outage: these receipts are simply not checked (best-effort).
        this.log(`[push] receipt fetch failed for ${chunk.length} id(s): ${errToMessage(err)}`);
        summary.missing += chunk.length;
        continue;
      }
      for (const id of chunk) {
        const entry = byId.get(id);
        const receipt = receipts[id];
        if (!entry) continue;
        if (!receipt) {
          // Not available (expired, or Expo never produced one). Nothing to act on.
          summary.missing += 1;
          continue;
        }
        if (receipt.status === "ok") {
          summary.ok += 1;
          continue;
        }
        const code = receipt.details?.error ?? "unknown";
        summary.errors[code] = (summary.errors[code] ?? 0) + 1;
        if (code === "DeviceNotRegistered") {
          deadTokens.add(entry.token);
        } else {
          // InvalidCredentials / MessageTooBig / MessageRateExceeded /
          // MismatchSenderId (FCM credentials on Expo do not match the app) /
          // ProviderError / ...: an ops
          // problem, not a dead device — log, never prune.
          this.log(
            `[push] receipt error ${JSON.stringify({
              code,
              kind: entry.kind,
              tok: pushTokenFingerprint(entry.token),
              message: receipt.message,
            })}`,
          );
        }
      }
    }

    if (deadTokens.size > 0) {
      try {
        summary.pruned = await this.deleteByTokens([...deadTokens]);
      } catch (err) {
        this.log(`[push] pruning receipt-dead tokens failed: ${errToMessage(err)}`);
      }
    }

    this.log(`[push] receipts ${JSON.stringify(summary)}`);
    return summary;
  }
}
