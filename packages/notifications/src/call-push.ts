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
  /** The caller — lets a tap on a ring that already ended open the DM with them. */
  callerId?: string;
}): PushNotification {
  const upgrade = "groupId" in input.target;
  return {
    title: input.callerName,
    body: upgrade ? "added you to a call." : "is calling you.",
    data: {
      type: "call_invite",
      callId: input.callId,
      ...input.target,
      // 1-1 only: for an upgrade ring a client uses `name` as the VOICE
      // CHANNEL's title, so the caller's name must not ride there.
      ...(upgrade ? {} : { name: input.callerName }),
      ...(input.callerId && !upgrade ? { userId: input.callerId } : {}),
    },
    collapseKey: callPushTag(input.callId),
    ttlSeconds: input.ringSeconds,
  };
}

/**
 * Where a missed-call tap should land: the DM with the caller, seen from the
 * CALLEE's side. `channelId` is the DM stream — it travels together with `dmId`
 * on purpose, because an older client routes any push carrying `dmId` to the
 * DM screen and that screen needs the stream to render (without it, a tap
 * showed "conversation unavailable").
 */
export interface MissedCallDmRoute {
  dmId: string;
  channelId: string;
  /** The caller (the DM peer from the callee's side). */
  userId: string;
}

/** The `dms.findById` slice {@link resolveMissedCallDm} needs. */
export interface MissedCallDmLookup {
  findById(
    dmId: string,
    viewerId: string,
  ): Promise<{ id: string; streamId: string; participant: { id: string } } | null>;
}

/**
 * Resolve the callee-side DM of `call` for the missed-call push. Best-effort:
 * any failure (or a lookup the caller could not wire) yields `undefined`, and
 * the push simply carries no route — the tap then opens the recent-calls list.
 */
export async function resolveMissedCallDm(
  dms: MissedCallDmLookup | undefined,
  call: { dmId: string; calleeId: string },
): Promise<MissedCallDmRoute | undefined> {
  if (!dms) return undefined;
  try {
    const dm = await dms.findById(call.dmId, call.calleeId);
    return dm ? { dmId: dm.id, channelId: dm.streamId, userId: dm.participant.id } : undefined;
  } catch {
    return undefined;
  }
}

/** Replace an unanswered ring with the missed-call line. */
export function callMissedPush(input: {
  callerName: string;
  callId: string;
  reason: "timeout" | "canceled";
  /** The callee's DM with the caller, when known — the tap opens it. */
  dm?: MissedCallDmRoute;
}): PushNotification {
  return {
    title: input.callerName,
    body: "Missed call",
    data: {
      type: "call_ended",
      callId: input.callId,
      reason: input.reason,
      ...(input.dm
        ? {
            dmId: input.dm.dmId,
            channelId: input.dm.channelId,
            userId: input.dm.userId,
            name: input.callerName,
          }
        : {}),
    },
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
