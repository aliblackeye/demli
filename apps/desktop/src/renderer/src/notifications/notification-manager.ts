/**
 * Notification manager (renderer) — desktop AND web.
 *
 * The realtime dispatcher (src/realtime/connection.ts) sees every inbound event;
 * this module turns the notify-worthy ones into a notification. On Electron that
 * is a native OS toast, shown by the main process through the validated bridge
 * (`window.demli.notifications`); on the web build it is a browser
 * Notification, shown by the web bridge. On click, both focus the window and echo
 * a navigate target back — {@link dispatchNotificationActivation} routes it to a
 * chat-store action. When neither sink can fire (no browser permission, no
 * Notification API), the alert falls back to an in-app toast rather than being
 * dropped — see {@link resolveSink}.
 *
 * Design mirrors the sound manager (src/sounds/sound-manager.ts): imperative,
 * never in React state, re-reads persisted settings on every call, and never
 * throws (a failed toast must not crash the app).
 *
 * NOTIFY POLICY lives in ./notify-policy.ts (pure + unit-tested); the short
 * version: suppress only when the user is already looking at the conversation
 * the alert is about. Focus alone is NOT enough — the old `document.hasFocus()`
 * gate meant a DM arriving while you read #general produced nothing at all.
 * Unchanged gates, all still upstream or here: Do Not Disturb, the master
 * switch, channel/server mutes, blocks, own messages, system notices, and the
 * per-channel throttle (at most one toast per channel per ~5 s).
 */

import type { Dm, Group, GroupId, ChannelId, DmId, Message, User } from "@demli/types";
import type { GroupDetails } from "../lib/api-client";
import type { AppTFunction } from "../lib/i18n";
import { queryClient, queryKeys } from "../lib/query-client";
import { useChatStore } from "../stores/chat-store";
import { isDoNotDisturb } from "../stores/self-presence-store";
import { isWebSurface } from "../lib/surface";
import { useNotificationSettings } from "./notification-settings";
import { pushInAppNotification } from "./in-app-notifications";
import { readWebNotificationPermission, webNotificationsSupported } from "./web-permission";
import { shouldNotify, type AlertTarget } from "./notify-policy";
import { visibleContext } from "./visible-conversation";

// Bridge types are DERIVED from the global `window.demli` surface (declared by
// the preload) so they can never drift from it, and we never import across the
// main/ boundary (same convention as SystemSettings.tsx).
type NotificationsApi = Window["demli"]["notifications"];
type NotificationRequest = Parameters<NotificationsApi["notify"]>[0];
type NotificationNavigate = Parameters<
  Parameters<NotificationsApi["onActivated"]>[0]
>[0];

/** Notification body is a short preview — trim message content to this. */
const BODY_MAX_CHARS = 100;
/** At most one toast per channel within this window. */
const CHANNEL_THROTTLE_MS = 5_000;

const lastNotifiedByChannel = new Map<string, number>();

/**
 * Version we last fired an "update ready" toast for, so a re-broadcast of the
 * same `ready` status (or a status re-seed) never double-notifies.
 */
let lastNotifiedUpdateVersion: string | null = null;

/**
 * The active `t`, bound by {@link NotificationController} from React (and re-bound
 * on language change). Held here so this non-React module can localize copy. When
 * unset (before first bind), we skip notifying rather than emit English — a lost
 * toast is harmless and binding happens at app start, before any event arrives.
 */
let translate: AppTFunction | null = null;

export function setNotificationTranslator(t: AppTFunction | null): void {
  translate = t;
}

/** The native-notifications bridge, or null in a non-Electron (web) build. */
function bridge(): NotificationsApi | null {
  return window.demli?.notifications ?? null;
}

/** True when a fresh toast is allowed for this channel (updates the throttle). */
function passesChannelThrottle(channelId: string): boolean {
  const now = Date.now();
  const last = lastNotifiedByChannel.get(channelId);
  if (last !== undefined && now - last < CHANNEL_THROTTLE_MS) {
    return false;
  }
  lastNotifiedByChannel.set(channelId, now);
  return true;
}

/** Human-readable sender name for the message author (directory → fallback). */
function senderName(t: AppTFunction, authorId: string): string {
  return (
    useChatStore.getState().users[authorId]?.displayName ??
    t("desktop:notifications.someone")
  );
}

/** The toast body: trimmed message content, or a localized attachment stand-in. */
function messagePreview(t: AppTFunction, message: Message): string {
  const content = message.content.trim();
  if (content.length > 0) {
    return content.length > BODY_MAX_CHARS
      ? `${content.slice(0, BODY_MAX_CHARS).trimEnd()}…`
      : content;
  }
  if (message.attachments && message.attachments.length > 0) {
    return t("desktop:notifications.attachment");
  }
  return "";
}

// ---------------------------------------------------------------------------
// Message → notification resolution
// ---------------------------------------------------------------------------

/** Scan cached server-group details for the text channel carrying this message. */
function findServerChannel(
  channelId: ChannelId,
): { groupId: GroupId; name: string } | null {
  // Prefix match also returns the ["groups"] list (FriendGroup[]) which has no
  // `.channels` — the optional chain treats it as a miss (see connection.ts).
  const entries = queryClient.getQueriesData<GroupDetails>({
    queryKey: queryKeys.groups,
  });
  for (const [, details] of entries) {
    const channel = details?.channels?.find((c) => c.id === channelId);
    if (channel && details) {
      return { groupId: details.group.id, name: channel.name };
    }
  }
  return null;
}

/**
 * Build the {title, body, navigate} for an inbound message, resolving which
 * surface it belongs to (DM / flat group chat / server channel) from the query
 * cache. Returns null when the channel is not recognized (nothing to route to).
 */
function resolveMessageNotification(
  t: AppTFunction,
  message: Message,
): NotificationRequest | null {
  const preview = messagePreview(t, message);

  // 1) DM — title is the other person (author === the DM participant).
  const dms = queryClient.getQueryData<Dm[]>(queryKeys.dms);
  const dm = dms?.find((d) => d.streamId === message.channelId);
  if (dm) {
    return {
      title: dm.participant.displayName,
      body: preview,
      navigate: { target: "dm", dmId: dm.id, streamId: dm.streamId },
    };
  }

  // 2) Flat group chat — title is the group, body is "sender: message".
  const groupChats = queryClient.getQueryData<Group[]>(queryKeys.groupChats);
  const groupChat = groupChats?.find((g) => g.streamId === message.channelId);
  if (groupChat) {
    return {
      title: groupChat.name,
      body: t("desktop:notifications.messageBody", {
        sender: senderName(t, message.authorId),
        message: preview,
      }),
      navigate: {
        target: "groupChat",
        groupChatId: groupChat.id,
        streamId: groupChat.streamId,
      },
    };
  }

  // 3) Server text channel — title is "#channel", body is "sender: message".
  const serverChannel = findServerChannel(message.channelId);
  if (serverChannel) {
    return {
      title: `#${serverChannel.name}`,
      body: t("desktop:notifications.messageBody", {
        sender: senderName(t, message.authorId),
        message: preview,
      }),
      navigate: {
        target: "channel",
        groupId: serverChannel.groupId,
        channelId: message.channelId,
      },
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Sink selection
// ---------------------------------------------------------------------------

/**
 * Where this alert can actually be shown.
 *
 * - `"native"`  — the platform bridge: an Electron OS toast, or a browser
 *   Notification when the origin has been granted permission.
 * - `"in-app"`  — the browser has no Notification API, or permission is not
 *   granted. Rather than going silent (which is what shipped: `web-bridge.notify`
 *   returned early on `permission !== "granted"`, forever, because nothing ever
 *   asked), the alert is painted inside the app.
 * - `"none"`    — no bridge at all (a bare test renderer). Nothing to do.
 *
 * Exactly ONE sink is chosen per alert, so nothing is ever announced twice.
 */
type NotificationSink = "native" | "in-app" | "none";

function resolveSink(): NotificationSink {
  if (!bridge()) return "none";
  if (!isWebSurface()) return "native";
  if (!webNotificationsSupported()) return "in-app";
  return readWebNotificationPermission() === "granted" ? "native" : "in-app";
}

/** Deliver through the chosen sink. Never throws. */
function deliver(sink: NotificationSink, request: NotificationRequest): void {
  if (sink === "native") {
    void bridge()?.notify(request).catch(() => undefined);
    return;
  }
  if (sink === "in-app") {
    pushInAppNotification({
      title: request.title,
      body: request.body,
      navigate: request.navigate,
    });
  }
}

// ---------------------------------------------------------------------------
// Public API (called from the dispatcher)
// ---------------------------------------------------------------------------

/**
 * The one gate every alert passes through: master switch + Do Not Disturb + a
 * usable sink + a bound translator + "is the user already looking at it?"
 * (./notify-policy.ts). Returns the sink so the caller delivers exactly once.
 */
function gate(target: AlertTarget): NotificationSink {
  const sink = resolveSink();
  const allowed = shouldNotify({
    // Do Not Disturb silences EVERY alert (messages, friend requests, incoming
    // calls, update-ready) — the founder's "dnd iken bildirim gelmez". Unread
    // badges still tick; only the interruptive surfaces are suppressed.
    doNotDisturb: isDoNotDisturb(),
    enabled: useNotificationSettings.getState().enabled,
    hasSink: sink !== "none",
    hasTranslator: translate !== null,
    target,
    visible: visibleContext(),
  });
  return allowed ? sink : "none";
}

/**
 * Notify for an inbound message. The dispatcher has already filtered out our own
 * messages, system notices, muted channels and blocked authors; this adds the
 * visibility gate, the per-channel throttle, and surface resolution.
 *
 * The target is the message's own stream, so the toast is suppressed ONLY while
 * that exact conversation is the one on screen — a message in any other channel,
 * DM or server alerts even with the app focused (the founder's report).
 */
export function notifyIncomingMessage(message: Message): void {
  const sink = gate({ kind: "stream", streamId: message.channelId });
  if (sink === "none") return;
  const t = translate;
  if (!t) return;
  if (!passesChannelThrottle(message.channelId)) return;

  const request = resolveMessageNotification(t, message);
  if (!request) return;
  deliver(sink, request);
}

/**
 * Notify for an incoming friend request (friend.request_received). Rare event —
 * no throttle. Suppressed only while the Friends table itself is on screen (that
 * is where the request already appears); anywhere else it alerts. Click routes
 * to the friends surface.
 */
export function notifyFriendRequest(requester: User): void {
  const sink = gate({ kind: "surface", surface: "friends" });
  if (sink === "none") return;
  const t = translate;
  if (!t) return;

  deliver(sink, {
    title: t("desktop:notifications.friendRequestTitle"),
    body: t("desktop:notifications.friendRequestBody", {
      name: requester.displayName,
    }),
    navigate: { target: "friends" },
  });
}

/**
 * Notify that we were just added to a flat group chat (`group_chat.added`). Rare
 * event — no throttle. Targeted at the new chat's stream, which by definition is
 * not the one on screen yet, so this effectively always alerts. Click opens it.
 */
export function notifyAddedToGroupChat(group: Group): void {
  const sink = gate({ kind: "stream", streamId: group.streamId });
  if (sink === "none") return;
  const t = translate;
  if (!t) return;

  deliver(sink, {
    title: t("desktop:notifications.groupChatAddedTitle"),
    body: t("desktop:notifications.groupChatAddedBody", { name: group.name }),
    navigate: { target: "groupChat", groupChatId: group.id, streamId: group.streamId },
  });
}

/**
 * Notify for an incoming DM call (ADR 0012 Wave 6).
 *
 * Target is `{ kind: "app" }`, NOT a stream: the global incoming-call overlay
 * renders over every screen, so whenever the app is in the foreground the user
 * is already looking at this alert and a toast on top of it is pure noise. In
 * the background (another window, tray, minimized, hidden tab) it fires. The
 * click target `{ target: "call" }` only focuses the window; nothing routes.
 * `video` only varies the copy.
 */
export function notifyIncomingCall(caller: User, video: boolean): void {
  const sink = gate({ kind: "app" });
  if (sink === "none") return;
  const t = translate;
  if (!t) return;

  deliver(sink, {
    title: t("desktop:call.notifyIncomingTitle"),
    body: video
      ? t("desktop:call.notifyVideoBody", { name: caller.displayName })
      : t("desktop:call.notifyVoiceBody", { name: caller.displayName }),
    navigate: { target: "call" },
  });
}

/**
 * Notify that a downloaded app update is ready to install. Called from the update
 * status subscription (see UpdateSettings' `ensureInit`) on the transition into
 * the `ready` state.
 *
 * Target is `{ kind: "app" }` for the same reason as an incoming call: the
 * app-wide update banner is already visible whenever the app is in front, so the
 * toast is only useful in the background. Deduped by version so a status
 * re-broadcast never fires twice. `critical` only varies the copy: the forced
 * path auto-restarts shortly, so the toast is a heads-up, not an action.
 */
export function notifyUpdateReady(version: string, critical: boolean): void {
  const sink = gate({ kind: "app" });
  if (sink === "none") return;
  const t = translate;
  if (!t) return;
  if (lastNotifiedUpdateVersion === version) return;
  lastNotifiedUpdateVersion = version;

  deliver(sink, {
    title: t("desktop:notifications.updateReadyTitle"),
    body: critical
      ? t("desktop:notifications.updateCriticalBody")
      : t("desktop:notifications.updateReadyBody"),
    navigate: { target: "update" },
  });
}

// ---------------------------------------------------------------------------
// Click → navigation
// ---------------------------------------------------------------------------

/**
 * Route a clicked notification to the right surface. The navigate ids arrive as
 * plain strings across IPC; they originated as branded ids in this renderer, so
 * the casts are safe (main only ever echoes back what it validated).
 */
export function dispatchNotificationActivation(
  navigate: NotificationNavigate,
): void {
  const chat = useChatStore.getState();
  switch (navigate.target) {
    case "channel": {
      const groupId = navigate.groupId as GroupId;
      chat.openServer(groupId);
      // Select the exact channel if its group details are cached; otherwise the
      // server is at least in view and selection sync picks a default channel.
      const details = queryClient.getQueryData<GroupDetails>(
        queryKeys.groupDetails(groupId),
      );
      const channel = details?.channels.find((c) => c.id === navigate.channelId);
      if (channel) chat.setActiveChannel(channel);
      return;
    }
    case "groupChat":
      chat.openGroupChat({
        id: navigate.groupChatId as GroupId,
        streamId: navigate.streamId as ChannelId,
      });
      return;
    case "dm":
      chat.openDm({
        id: navigate.dmId as DmId,
        streamId: navigate.streamId as ChannelId,
      });
      return;
    case "friends":
      chat.openFriends();
      return;
    case "update":
      // Nothing to navigate: main already focused the window, and the app-wide
      // GlobalUpdateBanner (App root) is visible for any ready update with its
      // Restart action, so the user acts from there.
      return;
    case "call":
      // Nothing to navigate: main already focused the window, and the global
      // incoming-call overlay (App root) renders on every screen (ADR 0012 W6).
      return;
    default: {
      const _exhaustive: never = navigate;
      void _exhaustive;
    }
  }
}
