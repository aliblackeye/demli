import type { PushNotification } from "./push.js";

/**
 * Call pushes (ADR 0012, #103) — built in ONE place because three processes
 * send them: the API (start / accept / reject / cancel / upgrade / inline ring
 * reaps), the API's sweeper (expired rings) and the realtime gateway (a caller
 * who dropped off mid-ring). Every one of them must agree on the collapse tag,
 * or a retraction lands as a second notification next to the ring it was meant
 * to replace.
 *
 * Copy: the strings are the ones the API has always sent. Server-side push copy
 * is not localized yet — there is no recipient locale on the server to pick a
 * language with — so this module deliberately adds no new visible strings: an
 * unanswered ring is retracted with the existing "Missed call" line, and a ring
 * answered or declined on another device is retracted with a SILENT push the
 * client can act on.
 */

/** How long an undelivered "missed call" line stays worth delivering. */
export const CALL_MISSED_PUSH_TTL_SECONDS = 24 * 60 * 60;

/**
 * How long an undelivered "answered/declined elsewhere" signal stays worth
 * delivering. It only matters to a device that is showing the ring, so it is
 * short — but longer than the ring itself, because a phone can receive the ring
 * and then drop off the network for a while.
 */
export const CALL_CLEARED_PUSH_TTL_SECONDS = 10 * 60;

/**
 * Per-call push collapse tag (#103). The ring and every retraction share it so a
 * later same-tag push REPLACES the ring on the device (Android notification
 * `tag` / iOS `apns-collapse-id`) instead of stacking a second notification.
 */
export function callPushTag(callId: string): string {
  return `call:${callId}`;
}

/**
 * The ring. `ringSeconds` is the ring window: an undelivered ring older than
 * that is dropped by the push service rather than shown for a call that has
 * already ended.
 */
export function callRingPush(input: {
  callerName: string;
  callId: string;
  ringSeconds: number;
  /** `dmId` for a 1-1 call; `groupId` + `voiceChannelId` for an upgrade invite. */
  target: { dmId: string } | { groupId: string; voiceChannelId: string };
}): PushNotification {
  const upgrade = "groupId" in input.target;
  return {
    title: input.callerName,
    body: upgrade ? "added you to a call." : "is calling you.",
    data: { type: "call_invite", callId: input.callId, ...input.target },
    collapseKey: callPushTag(input.callId),
    ttlSeconds: input.ringSeconds,
  };
}

/** Replace an unanswered ring with the missed-call line. */
export function callMissedPush(input: {
  callerName: string;
  callId: string;
  reason: "timeout" | "canceled";
}): PushNotification {
  return {
    title: input.callerName,
    body: "Missed call",
    data: { type: "call_ended", callId: input.callId, reason: input.reason },
    collapseKey: callPushTag(input.callId),
    ttlSeconds: CALL_MISSED_PUSH_TTL_SECONDS,
  };
}

/**
 * The callee answered or declined on ANOTHER device: tell the rest of their
 * devices the ring is over without showing anything. Data-only, so it cannot
 * replace the ring by itself — the client dismisses the `call:<id>` notification
 * when it receives `type: "call_ended"`.
 */
export function callClearedPush(input: {
  callId: string;
  reason: "answered" | "declined";
}): PushNotification {
  return {
    title: "",
    body: "",
    silent: true,
    data: { type: "call_ended", callId: input.callId, reason: input.reason },
    collapseKey: callPushTag(input.callId),
    ttlSeconds: CALL_CLEARED_PUSH_TTL_SECONDS,
  };
}
