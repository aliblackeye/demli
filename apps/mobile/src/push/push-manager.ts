/**
 * Push-notification manager (task #46) — the mobile mirror of the desktop's
 * notification-manager.ts, adapted to Expo push (which bridges to FCM on
 * Android / APNs on iOS).
 *
 * Split of responsibilities:
 *  - The SERVER (apps/api push worker) owns notification COPY. When a message or
 *    friend request lands while this device is backgrounded/closed, the server
 *    sends an Expo push whose `content` (title/body) is already localized and
 *    whose `data` carries routing hints. This client does NOT compose copy for
 *    remote pushes.
 *  - This module owns the CLIENT lifecycle: register/drop the Expo push token,
 *    the Android channel, the foreground presentation policy, and tap routing.
 *
 * Like the sound manager it is imperative (never in React state) and defensive —
 * a failed push step must never crash the app, so every entry point swallows and
 * logs. React glue (auth-bound registration, listener wiring) lives in
 * PushController.tsx.
 *
 * The client↔push-backend data contract and its parsing live in the pure,
 * vitest-tested `notification-target.ts` — this module is the native/imperative
 * side (Expo calls, token I/O, expo-router navigation).
 */
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import Constants from "expo-constants";
import { router } from "expo-router";
import { shouldShowForegroundPush } from "@demli/client-core";
import { getApi, type DevicePlatform } from "@/lib/clients";
import { visibleContext } from "@/notifications/visible-context";
import {
  parseNotificationTarget,
  streamIdOfPush,
  type NotificationTarget,
} from "./notification-target";

/**
 * The Android channel our LOCAL notifications are posted on (the update-ready
 * notice below targets it explicitly). Remote pushes do not name a channel — the
 * server payload carries no `channelId` — so their routing is expo's own default
 * and is NOT verified here.
 *
 * Versioned on purpose. An Android channel is IMMUTABLE once created — later
 * `setNotificationChannelAsync` calls cannot change its sound or importance, only
 * the user can, from system settings. The first channel ("default") was created
 * with `sound: "default"`, which expo resolves as a CUSTOM sound FILE name; no
 * such raw resource exists, so that channel points at a dead sound URI and its
 * notifications arrive SILENT (and every launch logged "Custom sound 'default'
 * not found in native app"). Fixing the code alone would have left every existing
 * install broken, so the id is bumped and the dead channel is deleted below.
 */
const ANDROID_CHANNEL_ID = "messages-v2";

/** The broken pre-fix channel, removed on startup so it stops showing in settings. */
const LEGACY_ANDROID_CHANNEL_ID = "default";

/**
 * The token currently registered with the server this session, so logout can
 * drop the exact token without the caller threading it back through. Cleared on
 * a successful unregister.
 */
let registeredToken: string | null = null;

// ---------------------------------------------------------------------------
// Foreground presentation policy (task #16 analog)
// ---------------------------------------------------------------------------

/**
 * Install the foreground handler. Fires only for pushes that arrive while the
 * app is open, so this is the mobile analog of the desktop's "focused" check.
 *
 * Policy (task #46) — now the SHARED rule from `@demli/client-core`
 * (notify-policy), the same one desktop uses:
 *  - Suppress entirely when the push targets the conversation the user is
 *    demonstrably looking at — the message is already in the open thread (and
 *    the live WS path played its in-app cue).
 *  - Otherwise show a heads-up banner + list entry so a message in ANOTHER
 *    conversation is not missed. Sound stays OFF in the foreground: the realtime
 *    connection owns in-app cues (sounds/sound-manager), so letting the OS also
 *    play would double up. The Android channel still carries sound/vibration for
 *    BACKGROUND pushes, which never reach this handler.
 *
 * The visibility check is deliberately NOT `activeChannelId`: that only says the
 * thread is mounted, and a screen pushed on top of it (voice room, settings)
 * left the claim standing while the user looked elsewhere. See
 * notifications/visible-context.
 */
export function configureForegroundHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const data = notification.request.content.data;
      const show = shouldShowForegroundPush({
        streamId: streamIdOfPush(data) ?? null,
        visible: visibleContext(),
      });
      return {
        shouldShowBanner: show,
        shouldShowList: show,
        shouldPlaySound: false,
        shouldSetBadge: false,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Android channel
// ---------------------------------------------------------------------------

/**
 * Create/refresh the Android "default" notification channel that carries pushes.
 * No-op on iOS (channels are Android-only). `name`/`description` are already
 * localized by the caller (they surface in the system settings UI).
 */
export async function ensureAndroidChannel(name: string, description: string): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
      name,
      description,
      importance: Notifications.AndroidImportance.HIGH,
      // `sound` is deliberately OMITTED: expo treats any string here as a custom
      // sound FILE that must be bundled as a raw resource, so the old
      // `sound: "default"` resolved to a missing file and left the channel mute.
      // With the key absent the native side uses
      // Settings.System.DEFAULT_NOTIFICATION_URI — the phone's own notification
      // sound, which is what "default" was meant to say.
      vibrationPattern: [0, 250, 250, 250],
      // Notification LED / accent tint — `colors.accent` (#FF8C1A). Literal
      // because this module runs in node-environment unit tests too.
      lightColor: "#ff8c1a",
    });
    // Retire the dead channel (best-effort). Its sound cannot be repaired in
    // place, and leaving it behind shows the user a second, silent "default"
    // entry in the app's notification settings.
    await Notifications.deleteNotificationChannelAsync(LEGACY_ANDROID_CHANNEL_ID);
  } catch (err) {
    console.warn(`[push] failed to set up Android channel: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Local notifications (OTA update-ready)
// ---------------------------------------------------------------------------

/**
 * Present a local, immediate heads-up notification on the existing Android
 * channel. Used by the OTA flow (updates-store) to tell a BACKGROUNDED user that
 * a downloaded update is ready to apply — the mobile analog of the desktop's
 * native update-ready toast.
 *
 * Best-effort and defensive: skips silently when the OS notification permission
 * was never granted (we never prompt from here — that is registration's job) and
 * never throws, so a failed toast can't break the update flow. `title`/`body`
 * arrive already localized from the caller (the store, via its bound `t`).
 *
 * The `data` marks it as an update notice; `parseNotificationTarget` returns null
 * for it, so a tap simply opens the app — where the update banner is visible.
 */
export async function presentUpdateReadyNotification(
  title: string,
  body: string,
): Promise<void> {
  try {
    const perms = await Notifications.getPermissionsAsync();
    if (!perms.granted) return;
    await Notifications.scheduleNotificationAsync({
      content: { title, body, data: { type: "update" } },
      // `{ channelId }` is expo's immediate trigger that also targets our Android
      // channel; channelId is ignored on iOS (channels are Android-only).
      trigger: { channelId: ANDROID_CHANNEL_ID },
    });
  } catch (err) {
    console.warn(`[push] failed to present update notification: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Token registration
// ---------------------------------------------------------------------------

/** The EAS project id (needed to mint an Expo push token), read from the config. */
function easProjectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as
    | { eas?: { projectId?: string } }
    | undefined;
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId;
}

/** Ensure the OS notification permission, prompting once if undetermined. */
async function ensurePermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  // `canAskAgain === false` means permanently denied — asking again is a no-op,
  // so we skip the prompt and just report "not granted".
  if (!current.canAskAgain) return false;
  const requested = await Notifications.requestPermissionsAsync();
  return requested.granted;
}

/**
 * Request permission (if needed), mint the Expo push token, and register it with
 * the server. Idempotent-ish: safe to call again for the same session; the
 * server upserts. Returns the registered token, or null when permission was
 * denied / no token could be minted (e.g. emulator without Google Play). Never
 * throws.
 */
export async function registerPushToken(): Promise<string | null> {
  try {
    const granted = await ensurePermission();
    if (!granted) {
      console.warn("[push] notification permission not granted — skipping registration");
      return null;
    }

    const projectId = easProjectId();
    const { data: token } = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    if (!token) return null;

    const platform: DevicePlatform = Platform.OS === "ios" ? "ios" : "android";
    await getApi().registerDevice({ token, platform });
    registeredToken = token;
    return token;
  } catch (err) {
    // Emulators without Google Play, transient network, etc. — never fatal.
    console.warn(`[push] token registration failed: ${String(err)}`);
    return null;
  }
}

/**
 * Drop the registered push token from the server (logout / permission revoked).
 * Uses the token remembered at registration; a no-op when nothing is registered.
 * Never throws — a failed unregister must not block logout.
 */
export async function unregisterPushToken(): Promise<void> {
  const token = registeredToken;
  if (!token) return;
  registeredToken = null;
  try {
    await getApi().unregisterDevice({ token });
  } catch (err) {
    console.warn(`[push] token unregister failed: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Tap routing
// ---------------------------------------------------------------------------

/** Drop undefined values so expo-router never receives `undefined` params. */
function definedParams(params: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Navigate to the surface a tapped notification points at (expo-router). */
export function routeToNotificationTarget(target: NotificationTarget): void {
  switch (target.kind) {
    case "friends":
      router.push("/friends");
      return;
    case "dm":
      router.push({
        pathname: "/dm/[dmId]",
        params: definedParams({
          dmId: target.dmId,
          streamId: target.streamId,
          name: target.name,
          userId: target.userId,
        }),
      });
      return;
    case "groupChat":
      router.push({
        pathname: "/group-chat/[groupChatId]",
        params: definedParams({ groupChatId: target.groupChatId, name: target.name }),
      });
      return;
    case "channel":
      router.push({
        pathname: "/channel/[channelId]",
        params: definedParams({
          channelId: target.channelId,
          groupId: target.groupId,
          name: target.name,
        }),
      });
      return;
    case "call":
      // ADR 0012: land near the call; the live ring UI is driven by the socket.
      // Group-upgrade ring → the group's voice channel; 1-1 DM call → friends.
      if (target.groupId && target.voiceChannelId) {
        router.push({
          pathname: "/voice/[channelId]",
          params: definedParams({
            channelId: target.voiceChannelId,
            groupId: target.groupId,
            name: target.name,
          }),
        });
      } else {
        router.push("/friends");
      }
      return;
    default: {
      const _exhaustive: never = target;
      void _exhaustive;
    }
  }
}

/**
 * Resolve a tapped notification response to a target, or null when it carries
 * nothing routable. Callers decide WHEN to route (e.g. defer until authenticated).
 */
export function targetFromResponse(
  response: Notifications.NotificationResponse | null,
): NotificationTarget | null {
  if (!response) return null;
  return parseNotificationTarget(response.notification.request.content.data);
}
