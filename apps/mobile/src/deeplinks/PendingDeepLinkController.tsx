/**
 * Replays a deep-link action that arrived while signed out. When a `/kat` or
 * `/arkadas` link opens the app before there's a session, the handler screen
 * stashes the intent (pending-link-store) and bounces to sign-in — so the code
 * survives the auth-guard redirect. Once the session becomes authenticated we
 * navigate back to the matching handler route, which now runs the action.
 *
 * Mounted in app/_layout.tsx next to <PushController>, INSIDE the i18n + query
 * providers, and owns no UI. Mirrors PushController's defer-until-authenticated
 * flush.
 */
import { useEffect } from "react";
import { router } from "expo-router";
import { useAuthStore } from "@/stores/auth-store";
import { usePendingDeepLinkStore } from "./pending-link-store";

export function PendingDeepLinkController(): null {
  const status = useAuthStore((s) => s.status);
  const pending = usePendingDeepLinkStore((s) => s.pending);

  useEffect(() => {
    if (status !== "authenticated" || !pending) return;
    // Consume once: clear before navigating so the handler screen (which sets
    // pending only while unauthenticated) can't re-stash and loop.
    usePendingDeepLinkStore.getState().clearPending();
    if (pending.kind === "invite") {
      router.replace({ pathname: "/kat/[code]", params: { code: pending.code } });
    } else {
      router.replace({ pathname: "/arkadas/[code]", params: { code: pending.code } });
    }
  }, [status, pending]);

  return null;
}
