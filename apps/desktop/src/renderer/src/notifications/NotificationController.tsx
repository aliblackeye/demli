import { useEffect } from "react";
import { useAppTranslation } from "../lib/i18n";
import {
  dispatchNotificationActivation,
  setNotificationTranslator,
} from "./notification-manager";

/**
 * Headless bridge between React and the imperative notification manager. Mounted
 * once at the app root. Two jobs:
 *
 *  1. Bind the active `t` into the manager so its non-React code can localize
 *     toast copy, re-binding whenever the language changes.
 *  2. Subscribe to main's "notification clicked" event and route it to the right
 *     surface (focus is already done in main; this handles in-app navigation).
 *
 * Renders nothing.
 */
export function NotificationController(): null {
  const { t } = useAppTranslation();

  // Keep the manager's translator current (identity changes on language switch).
  useEffect(() => {
    setNotificationTranslator(t);
    return () => setNotificationTranslator(null);
  }, [t]);

  // Subscribe to notification clicks (no-op in a non-Electron build).
  useEffect(() => {
    const unsubscribe = window.demli?.notifications?.onActivated(
      dispatchNotificationActivation,
    );
    return unsubscribe;
  }, []);

  return null;
}
