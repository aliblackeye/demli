/**
 * Headless boot-phase reporters (mobile mirror of the desktop renderer's
 * components/BootPhaseBinder.tsx).
 *
 * These render nothing. They exist so the boot store's phases are completed by
 * the code that OWNS each piece of startup work rather than by a timer — the
 * splash's progress bar is only allowed to move on things that really finished
 * (CLAUDE.md §35).
 *
 *  - {@link BootPhaseBinder}  session phase, from the auth store's status. A
 *    boot that lands signed-out drops the two signed-in-only phases.
 *  - `BootDataBinder`         data + realtime phases, mounted only for a
 *    signed-in boot. Both carry their own grace timer so neither can hold the
 *    splash open: the data phase falls through to the app's own loading state,
 *    the socket falls through to the in-app connection banner.
 *
 * Both must sit INSIDE the QueryClientProvider (the data binder subscribes to a
 * query) — see app/_layout.tsx.
 */

import { useEffect } from "react";
import { useGroups } from "../queries/chat-queries";
import { useAuthStore } from "../stores/auth-store";
import { useBootStore } from "../stores/boot-store";
import { useChatStore } from "../stores/chat-store";

/**
 * How long the first server payload may take before the splash stops waiting.
 * Not a failure: the shell renders its own skeletons/empty states perfectly
 * well, so waiting longer than this only delays a usable app. A phone on a bad
 * mobile connection is the normal case here, not the exception.
 */
const DATA_GRACE_MS = 8_000;

/**
 * How long the gateway handshake may take before the splash stops waiting. The
 * socket is not required to use the app (messages queue in the persistent
 * outbox, the connection banner shows the state), so this stays short.
 */
const REALTIME_GRACE_MS = 4_000;

/**
 * Data + realtime phases. Mounted ONLY while a signed-in boot is still running,
 * so its `useGroups` subscription is short-lived — and it shares the query key
 * the Servers tab uses, so it warms the exact cache entry the app needs instead
 * of issuing a second request.
 */
function BootDataBinder(): null {
  const groups = useGroups();
  // `isSuccess || isError` — a SETTLED query, not a successful one. A failed
  // groups fetch must open the app (with its own error/empty state), never park
  // the user on a splash.
  const dataSettled = groups.isSuccess || groups.isError;
  const online = useChatStore((s) => s.connectionStatus === "online");

  useEffect(() => {
    if (!dataSettled) return;
    useBootStore.getState().completeBootPhase("data");
  }, [dataSettled]);

  useEffect(() => {
    if (!online) return;
    useBootStore.getState().completeBootPhase("realtime");
  }, [online]);

  // Grace timers: whatever has not landed by now is finished as DEGRADED, so
  // the app opens and its own surfaces report the rest.
  useEffect(() => {
    const data = setTimeout(() => useBootStore.getState().degradeBootPhase("data"), DATA_GRACE_MS);
    const realtime = setTimeout(
      () => useBootStore.getState().degradeBootPhase("realtime"),
      REALTIME_GRACE_MS,
    );
    return () => {
      clearTimeout(data);
      clearTimeout(realtime);
    };
  }, []);

  return null;
}

/**
 * Session phase + the shape of the rest of the boot. Mounted for the whole
 * signed-in-or-not lifetime of a boot; renders null once the boot is done so no
 * subscription outlives the splash.
 */
export function BootPhaseBinder(): JSX.Element | null {
  const status = useAuthStore((s) => s.status);
  const booting = useBootStore((s) => s.status === "booting");

  useEffect(() => {
    if (status === "initializing") return;
    const boot = useBootStore.getState();
    // A boot that ends on the sign-in screen has no server data and no socket —
    // drop those phases instead of pretending they ran, so the bar reaches 100%
    // honestly on a 3-phase boot.
    if (status === "unauthenticated") {
      boot.dropBootPhases("data", "realtime");
    }
    boot.completeBootPhase("session");
  }, [status]);

  if (!booting) return null;
  return status === "authenticated" ? <BootDataBinder /> : null;
}
