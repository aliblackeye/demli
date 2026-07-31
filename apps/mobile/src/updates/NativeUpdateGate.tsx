import type { ReactNode } from "react";
import { useEffect } from "react";
import { AppState } from "react-native";
import { NativeUpdateBanner } from "./NativeUpdateBanner";
import { NativeUpdateScreen } from "./NativeUpdateScreen";
import { useNativeUpdateStore } from "./native-update-store";

/** Don't re-check on every quick app resume — throttle foreground checks. */
const RESUME_RECHECK_MS = 60_000;

/**
 * Wires the NATIVE-update check to the app lifecycle. Mounted just INSIDE the OTA
 * `UpdateGate` in `app/_layout.tsx`, wrapping the navigation Stack, so the two
 * update mechanisms run in parallel without overlapping UI: while OTA is doing a
 * critical download `UpdateGate` renders its own screen instead of these
 * children, so this gate isn't even mounted then.
 *
 *  - Checks once on launch and again on foreground resume (throttled). Both are
 *    no-ops in Expo Go / dev client (the store guards on `updatesEnabled()`).
 *  - FORCED (below the supported floor) -> renders the blocking screen INSTEAD of
 *    the app until the user reinstalls a supported APK.
 *  - OPTIONAL (a newer build exists) -> renders the app plus a dismissible banner.
 */
export function NativeUpdateGate({ children }: { children: ReactNode }) {
  const level = useNativeUpdateStore((s) => s.level);
  const check = useNativeUpdateStore((s) => s.check);

  useEffect(() => {
    // Launch check.
    void check();

    // Foreground resume check (throttled so quick app switches don't spam it).
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      const { lastCheckAt } = useNativeUpdateStore.getState();
      if (lastCheckAt !== null && Date.now() - lastCheckAt < RESUME_RECHECK_MS) return;
      void check();
    });
    return () => sub.remove();
  }, [check]);

  if (level === "forced") return <NativeUpdateScreen />;

  return (
    <>
      {children}
      <NativeUpdateBanner />
    </>
  );
}
