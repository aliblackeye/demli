/**
 * Push lifecycle glue (task #46) — the thin React layer that binds the imperative
 * push-manager to the app: it owns no UI (returns null) and is the mobile analog
 * of the desktop's <NotificationController>.
 *
 * Responsibilities:
 *  - Register the Expo push token once the session is authenticated; drop it on
 *    logout (so a signed-out / handed-off phone stops receiving this user).
 *  - Keep the Android notification channel in sync with the active language.
 *  - Route notification taps (foreground, background, and cold-start) to the
 *    right screen — deferring until authenticated when a tap arrives first.
 *
 * Mounted INSIDE the i18n + query providers in app/_layout.tsx so `useAppTranslation`
 * resolves and the API client (already carrying the session token) is reachable.
 */
import { useEffect, useRef } from "react";
import * as Notifications from "expo-notifications";
import { useAppTranslation } from "@/lib/i18n";
import { useAuthStore } from "@/stores/auth-store";
import {
  configureForegroundHandler,
  ensureAndroidChannel,
  registerPushToken,
  routeToNotificationTarget,
  targetFromResponse,
  unregisterPushToken,
} from "./push-manager";
import type { NotificationTarget } from "./notification-target";

// Install the foreground presentation policy once at module load — no React or
// auth needed, and it must be set before any push arrives (mirrors the
// side-effect import of sounds/voice-sounds in _layout.tsx).
configureForegroundHandler();

export function PushController(): null {
  const { t } = useAppTranslation();
  const status = useAuthStore((s) => s.status);

  /** True once this session's token has been registered (guards re-registration). */
  const registeredRef = useRef(false);
  /** A tap that landed before we were authenticated; routed once we are. */
  const pendingTargetRef = useRef<NotificationTarget | null>(null);

  // Tap routing: live listener + cold-start (app opened from a killed state by
  // tapping a push). Mount-once; refs and module fns are stable.
  useEffect(() => {
    const handle = (target: NotificationTarget | null): void => {
      if (!target) return;
      if (useAuthStore.getState().status === "authenticated") {
        routeToNotificationTarget(target);
      } else {
        pendingTargetRef.current = target;
      }
    };

    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      handle(targetFromResponse(response));
    });

    void Notifications.getLastNotificationResponseAsync().then((response) => {
      handle(targetFromResponse(response));
    });

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
      if (!registeredRef.current) {
        registeredRef.current = true;
        void registerPushToken();
      }
      const pending = pendingTargetRef.current;
      if (pending) {
        pendingTargetRef.current = null;
        routeToNotificationTarget(pending);
      }
    } else if (status === "unauthenticated" && registeredRef.current) {
      registeredRef.current = false;
      void unregisterPushToken();
    }
  }, [status]);

  return null;
}
