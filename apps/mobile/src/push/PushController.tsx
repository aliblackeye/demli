/**
 * Push lifecycle glue (task #46) — the thin React layer that binds the imperative
 * push-manager to the app: it owns no UI (returns null) and is the mobile analog
 * of the desktop's <NotificationController>.
 *
 * Responsibilities:
 *  - Register the Expo push token on EVERY launch once authenticated, again on
 *    every return to the foreground (throttled) and right after a permission
 *    grant; drop it on logout. The server upserts, so repeating is free — and it
 *    is what brings back a token the server pruned as dead or FCM rotated
 *    (field report 2026-10-20).
 *  - Keep the notification-permission store fresh (Home banner + Settings row).
 *  - Keep the Android notification channel in sync with the active language.
 *  - Route notification taps (foreground, background, and cold-start) to the
 *    right screen — deferring until authenticated when a tap arrives first.
 *
 * Mounted INSIDE the i18n + query providers in app/_layout.tsx so `useAppTranslation`
 * resolves and the API client (already carrying the session token) is reachable.
 */
import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import * as Notifications from "expo-notifications";
import { useAppTranslation } from "@/lib/i18n";
import { useAuthStore } from "@/stores/auth-store";
import {
  configureForegroundHandler,
  ensureAndroidChannel,
  registerPushToken,
  responseKey,
  routeToNotificationTarget,
  targetFromResponse,
  unregisterPushToken,
} from "./push-manager";
import { shouldRefreshToken } from "./permission-model";
import { useNotificationPermission } from "./permission-store";
import type { NotificationTarget } from "./notification-target";

// Install the foreground presentation policy once at module load — no React or
// auth needed, and it must be set before any push arrives (mirrors the
// side-effect import of sounds/voice-sounds in _layout.tsx).
configureForegroundHandler();

/** Responses already routed this process (live listener + cold-start read can both deliver one). */
const handledResponses = new Set<string>();

/** The last-tapped response at launch; the sync API, with the deprecated async one as fallback. */
async function readLastResponse(): Promise<Notifications.NotificationResponse | null> {
  try {
    return Notifications.getLastNotificationResponse();
  } catch {
    return Notifications.getLastNotificationResponseAsync().catch(() => null);
  }
}

export function PushController(): null {
  const { t } = useAppTranslation();
  const status = useAuthStore((s) => s.status);

  /** True while this session's token is registered (guards the logout unregister). */
  const registeredRef = useRef(false);
  /** Last time the token was (re)registered, for the foreground throttle. */
  const lastRefreshRef = useRef<number | null>(null);
  /** A tap that landed before we were authenticated; routed once we are. */
  const pendingTargetRef = useRef<NotificationTarget | null>(null);

  // Tap routing: live listener + cold-start (app opened from a killed state by
  // tapping a push). Mount-once; refs and module fns are stable.
  useEffect(() => {
    const handle = (response: Notifications.NotificationResponse | null): void => {
      if (!response) return;
      const key = responseKey(response);
      if (handledResponses.has(key)) return;
      handledResponses.add(key);
      // Consumed: a later remount must not route to the same old tap again.
      try {
        Notifications.clearLastNotificationResponse();
      } catch {
        // older native module — the Set above still dedupes within this process
      }
      const target = targetFromResponse(response);
      if (!target) return;
      if (useAuthStore.getState().status === "authenticated") {
        void routeToNotificationTarget(target);
      } else {
        pendingTargetRef.current = target;
      }
    };

    const sub = Notifications.addNotificationResponseReceivedListener(handle);
    void readLastResponse().then(handle);
    return () => sub.remove();
  }, []);

  // Android channel: (re)create with localized copy, refreshing on language change.
  useEffect(() => {
    void ensureAndroidChannel(
      t("mobile:notifications.channelName"),
      t("mobile:notifications.channelDescription"),
    );
  }, [t]);

  // Token lifecycle bound to the session, plus flushing any deferred tap.
  useEffect(() => {
    if (status === "authenticated") {
      registeredRef.current = true;
      lastRefreshRef.current = Date.now();
      // Every launch / sign-in: may show the one-time system prompt.
      void registerPushToken().then(() => useNotificationPermission.getState().refresh());
      const pending = pendingTargetRef.current;
      if (pending) {
        pendingTargetRef.current = null;
        void routeToNotificationTarget(pending);
      }
    } else if (status === "unauthenticated" && registeredRef.current) {
      registeredRef.current = false;
      lastRefreshRef.current = null;
      void unregisterPushToken();
    }
  }, [status]);

  // Every return to the foreground: re-read the permission (the user may have
  // just flipped it in system settings) and refresh the token — never prompting.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next !== "active") return;
      if (useAuthStore.getState().status !== "authenticated") return;
      void (async () => {
        const before = useNotificationPermission.getState().status;
        const snapshot = await useNotificationPermission.getState().refresh();
        if (snapshot.status !== "granted") return;
        const justGranted = before === "denied";
        const now = Date.now();
        // `refresh` already registers on a fresh grant; this covers the rest.
        if (justGranted) {
          lastRefreshRef.current = now;
          return;
        }
        if (!shouldRefreshToken({ now, lastRefreshAt: lastRefreshRef.current, justGranted })) {
          return;
        }
        lastRefreshRef.current = now;
        await registerPushToken({ prompt: false });
      })();
    });
    return () => sub.remove();
  }, []);

  return null;
}
