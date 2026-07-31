import type { ReactNode } from "react";
import { useEffect } from "react";
import { AppState } from "react-native";
import { useAppTranslation } from "@/lib/i18n";
import { CriticalUpdateScreen } from "./CriticalUpdateScreen";
import { UpdateBanner } from "./UpdateBanner";
import { setUpdatesTranslator, useUpdatesStore } from "./updates-store";

/** Don't re-check on every quick app resume — throttle foreground checks. */
const RESUME_RECHECK_MS = 15_000;

const CRITICAL_PHASES = new Set(["critical-downloading", "critical-reloading", "critical-error"]);

/**
 * Wires OTA checks to the app lifecycle. Mounted just inside the providers in
 * `app/_layout.tsx`, wrapping the navigation Stack.
 *
 *  - Checks once on launch and again whenever the app returns to the foreground
 *    (throttled). Both are no-ops in Expo Go / dev client (guarded in the store).
 *  - CRITICAL update available -> renders the blocking screen INSTEAD of the app
 *    until the update is fetched and reloaded; nothing else can be reached.
 *  - OPTIONAL update ready -> renders the app plus a dismissible banner overlay.
 */
export function UpdateGate({ children }: { children: ReactNode }) {
  const { t } = useAppTranslation();
  const phase = useUpdatesStore((s) => s.phase);
  const check = useUpdatesStore((s) => s.check);

  // Keep the store's translator current (identity changes on language switch) so
  // the OTA "update ready" notification is localized. Mirrors the desktop's
  // <NotificationController> binding into the notification manager.
  useEffect(() => {
    setUpdatesTranslator(t);
    return () => setUpdatesTranslator(null);
  }, [t]);

  useEffect(() => {
    // Launch check.
    void check();

    // Foreground resume check (throttled so quick app switches don't spam it).
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      const { lastCheckAt } = useUpdatesStore.getState();
      if (lastCheckAt !== null && Date.now() - lastCheckAt < RESUME_RECHECK_MS) return;
      void check();
    });
    return () => sub.remove();
  }, [check]);

  if (CRITICAL_PHASES.has(phase)) return <CriticalUpdateScreen />;

  return (
    <>
      {children}
      <UpdateBanner />
    </>
  );
}
