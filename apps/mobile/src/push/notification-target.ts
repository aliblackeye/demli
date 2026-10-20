/**
 * Pure parsing + routing of a push notification's `data` map (task #46, field
 * report 2026-10-20). Deliberately free of react-native / expo imports so it is
 * unit-testable in vitest and stands as the single source of truth for the
 * client↔push-backend data contract.
 *
 * Expo/FCM `data` maps are string→string on the wire, so every field is read as
 * a string. The SERVER builders are in packages/notifications (message-push.ts,
 * channel-message-push.ts, call-push.ts, apps/api friends module); a test there
 * and the tests here pin the shapes:
 *
 *   dm_message   { type, dmId, channelId(stream), messageId, userId(author), name }
 *   mention      { type, channelId, groupId, messageId, name, groupChatId? }
 *   message      { type, channelId, groupId, messageId, name, groupChatId? }
 *                  groupChatId present ⇔ a flat group chat (own screen)
 *   friend_request / friend   { type, userId }
 *   call_invite  { type, callId, dmId, name, userId }            (1-1 ring)
 *                { type, callId, groupId, voiceChannelId }       (upgrade ring)
 *   call_ended   { type, callId, reason, dmId?, channelId?, userId?, name? }
 *                  (missed call; the silent "answered elsewhere" variant is
 *                  never shown, so never tapped)
 *   update       local OTA notice — not routable, the tap just opens the app
 */

/** Where a tapped notification points. */
export type NotificationTarget =
  | { kind: "friends" }
  | {
      kind: "dm";
      dmId: string;
      streamId?: string;
      name?: string;
      userId?: string;
      messageId?: string;
    }
  | { kind: "groupChat"; groupChatId: string; name?: string; messageId?: string }
  | { kind: "channel"; channelId: string; groupId?: string; name?: string; messageId?: string }
  | {
      kind: "callRing";
      callId?: string;
      dmId?: string;
      groupId?: string;
      voiceChannelId?: string;
      name?: string;
      userId?: string;
    }
  | {
      kind: "callMissed";
      callId?: string;
      dmId?: string;
      streamId?: string;
      name?: string;
      userId?: string;
    };

/** An expo-router destination (structurally an `Href`). */
export type NotificationHref =
  | string
  | { pathname: string; params: Record<string, string> };

/** Read a data field as a trimmed non-empty string, or undefined. */
function str(data: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = data?.[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Push types that are about a person or a call, never about a stream on screen. */
const NON_STREAM_TYPES = new Set(["friend_request", "friend", "call_invite", "call_ended", "update"]);

/**
 * The stream key a message push is on (server channel id / DM / group-chat
 * streamId), used only for FOREGROUND suppression. Undefined for friend and call
 * pushes, which are never suppressed — a missed call must show even while that
 * DM is open.
 */
export function streamIdOfPush(data: Record<string, unknown> | undefined): string | undefined {
  const type = str(data, "type");
  if (type && NON_STREAM_TYPES.has(type)) return undefined;
  return str(data, "channelId");
}

/**
 * Resolve a notification's `data` into a target, or null when it carries nothing
 * routable (the tap then just opens the app).
 */
export function parseNotificationTarget(
  data: Record<string, unknown> | undefined,
): NotificationTarget | null {
  const type = str(data, "type");
  if (type === "friend_request" || type === "friend") return { kind: "friends" };
  if (type === "update") return null;

  const name = str(data, "name");
  const messageId = str(data, "messageId");

  if (type === "call_invite") {
    return compact<NotificationTarget>({
      kind: "callRing",
      callId: str(data, "callId"),
      dmId: str(data, "dmId"),
      groupId: str(data, "groupId"),
      voiceChannelId: str(data, "voiceChannelId"),
      name,
      userId: str(data, "userId"),
    });
  }

  if (type === "call_ended") {
    return compact<NotificationTarget>({
      kind: "callMissed",
      callId: str(data, "callId"),
      dmId: str(data, "dmId"),
      streamId: str(data, "channelId"),
      name,
      userId: str(data, "userId"),
    });
  }

  const dmId = str(data, "dmId");
  if (dmId) {
    return compact<NotificationTarget>({
      kind: "dm",
      dmId,
      streamId: str(data, "channelId") ?? str(data, "streamId"),
      name,
      userId: str(data, "userId"),
      messageId,
    });
  }

  const groupChatId = str(data, "groupChatId");
  if (groupChatId) return compact<NotificationTarget>({ kind: "groupChat", groupChatId, name, messageId });

  const channelId = str(data, "channelId");
  if (channelId) {
    return compact<NotificationTarget>({ kind: "channel", channelId, groupId: str(data, "groupId"), name, messageId });
  }

  return null;
}

/** Drop undefined keys so targets compare cleanly and never leak `undefined` params. */
function compact<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) if (v !== undefined) out[key] = v;
  return out as T;
}

function params(values: Record<string, string | undefined>): Record<string, string> {
  return compact(values) as Record<string, string>;
}

function dmHref(input: {
  dmId: string;
  streamId?: string;
  name?: string;
  userId?: string;
}): NotificationHref {
  return {
    pathname: "/dm/[dmId]",
    params: params({
      dmId: input.dmId,
      streamId: input.streamId,
      name: input.name,
      userId: input.userId,
    }),
  };
}

/**
 * Where a tap goes for every target EXCEPT a live ring (see
 * {@link callRingDecision} for that one). Pure: the same data always maps to the
 * same destination.
 */
export function notificationHref(target: NotificationTarget): NotificationHref {
  switch (target.kind) {
    case "friends":
      return "/friends";
    case "dm":
      return dmHref(target);
    case "groupChat":
      return {
        pathname: "/group-chat/[groupChatId]",
        params: params({ groupChatId: target.groupChatId, name: target.name }),
      };
    case "channel":
      return {
        pathname: "/channel/[channelId]",
        params: params({ channelId: target.channelId, groupId: target.groupId, name: target.name }),
      };
    case "callMissed":
      // The DM with the caller (the call row sits in its history); without one,
      // the call log.
      return target.dmId ? dmHref({ ...target, dmId: target.dmId }) : "/recent-calls";
    case "callRing":
      // A ring that is no longer ringing: the place the call lived.
      if (target.groupId && target.voiceChannelId) {
        return {
          pathname: "/voice/[channelId]",
          params: params({ channelId: target.voiceChannelId, groupId: target.groupId }),
        };
      }
      return target.dmId
        ? dmHref({ dmId: target.dmId, name: target.name, userId: target.userId })
        : "/recent-calls";
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}

/** The slice of the live call state a ring tap decides on. */
export interface CallSnapshot {
  phase: string;
  callId: string | null;
}

/**
 * A ring tap, decided AFTER the call state has been re-read from the server:
 *  - still ringing on this phone → `"overlay"`: the global incoming-call overlay
 *    (accept / video / decline) is already up, navigating would only hide it;
 *  - that call is already live here (accepted on this phone) → the call screen;
 *  - otherwise the ring is over → wherever {@link notificationHref} lands.
 */
export function callRingDecision(
  target: Extract<NotificationTarget, { kind: "callRing" }>,
  call: CallSnapshot,
): "overlay" | NotificationHref {
  const same = !target.callId || call.callId === target.callId;
  if (same && call.phase === "incoming") return "overlay";
  if (same && call.callId !== null && (call.phase === "active" || call.phase === "outgoing")) {
    return "/call";
  }
  return notificationHref(target);
}
