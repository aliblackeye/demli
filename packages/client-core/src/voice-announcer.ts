/**
 * Voice-occupancy announcement — what the gateway believes about which voice
 * channel this connection is in, reconciled with where the engine really is.
 *
 * The gateway tracks occupancy per WebSocket connection from our
 * `voice.join` / `voice.leave` frames; peers render "who is in the channel" from
 * it. The reconcile itself is trivial (announce the room when it changes). What
 * this module adds is the case the old inline copies in both apps got wrong: a
 * REFUSED join. They recorded the room as announced the moment the frame was
 * sent, so when the gateway refused it — which it can do for a join that is
 * perfectly legitimate, e.g. right after a DM call is upgraded to a group and
 * before it has subscribed us to the new group — nothing ever retried until the
 * next reconnect, and everyone else saw an empty channel while we talked in it.
 *
 * Now a refusal of OUR join (the gateway names the channel) un-records it and
 * retries on a short, bounded backoff. Refusals that cannot heal by waiting
 * (`INVALID_CHANNEL`) are not retried. Platform-free: the app injects the frame
 * senders and its notion of "the room I should be announced in".
 */

import type { RealtimeErrorCode } from "@demli/protocol";
import type { ChannelId } from "@demli/types";

/** Waits before each retry of a refused join; the list length is the attempt cap. */
export const VOICE_ANNOUNCE_RETRY_DELAYS_MS: readonly number[] = [500, 1_000, 2_000, 4_000, 8_000];

/** Refusals that can clear up by themselves — the gateway catching up, a DB blip. */
const RETRYABLE_REFUSALS: ReadonlySet<RealtimeErrorCode> = new Set<RealtimeErrorCode>([
  "NOT_A_MEMBER",
  "MESSAGE_FAILED",
]);

export interface VoiceAnnouncerDeps {
  /** Send `voice.join` for `channelId`. May silently fail while the socket is down. */
  join(channelId: ChannelId): void;
  /** Send `voice.leave` for `channelId`. */
  leave(channelId: ChannelId): void;
  /** The channel we should be announced in right now, or null. */
  desired(): ChannelId | null;
  retryDelaysMs?: readonly number[];
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface VoiceAnnouncer {
  /** Reconcile with `desired()`. Cheap and idempotent — call it on every state tick. */
  sync(): void;
  /** A fresh socket: the gateway knows nothing about us. Forget, then announce. */
  reset(): void;
  /** Forget what was announced without sending anything (session start / stop). */
  forget(): void;
  /**
   * The gateway refused a `voice.join` for `channelId`. True when that was our
   * current announcement (the caller then needs to do nothing else with it).
   */
  refused(channelId: ChannelId, code: RealtimeErrorCode): boolean;
  /** The channel the gateway was last told we are in. */
  announced(): ChannelId | null;
}

export function createVoiceAnnouncer(deps: VoiceAnnouncerDeps): VoiceAnnouncer {
  const delays = deps.retryDelaysMs ?? VOICE_ANNOUNCE_RETRY_DELAYS_MS;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let announced: ChannelId | null = null;
  /** The channel whose refused join is waiting out a backoff (or has given up). */
  let heldBack: ChannelId | null = null;
  let timer: unknown = null;
  /** Retries spent on `attemptsFor`; another channel starts from zero. */
  let attempts = 0;
  let attemptsFor: ChannelId | null = null;

  function cancelRetry(): void {
    if (timer !== null) clearTimer(timer);
    timer = null;
    heldBack = null;
    attempts = 0;
    attemptsFor = null;
  }

  function sync(): void {
    const desired = deps.desired();
    if (heldBack !== null && desired !== heldBack) cancelRetry();
    if (desired !== null && desired === heldBack) return;
    if (desired === announced) return;
    if (announced) deps.leave(announced);
    if (desired) deps.join(desired);
    announced = desired;
  }

  return {
    sync,
    reset(): void {
      cancelRetry();
      announced = null;
      sync();
    },
    forget(): void {
      cancelRetry();
      announced = null;
    },
    refused(channelId, code): boolean {
      if (channelId !== announced) return false;
      announced = null;
      if (timer !== null) clearTimer(timer);
      timer = null;
      if (attemptsFor !== channelId) {
        attemptsFor = channelId;
        attempts = 0;
      }
      // Held back until the timer below releases it (or for good once the
      // attempts run out, or when waiting cannot change the answer) — so the
      // per-tick `sync()` calls do not re-send it in a tight loop meanwhile.
      heldBack = channelId;
      if (!RETRYABLE_REFUSALS.has(code)) return true;
      const delay = delays[attempts];
      if (delay === undefined) return true;
      attempts += 1;
      timer = setTimer(() => {
        timer = null;
        if (heldBack !== channelId) return;
        // Release the hold for one attempt; another refusal re-arms it.
        heldBack = null;
        sync();
      }, delay);
      return true;
    },
    announced: () => announced,
  };
}
