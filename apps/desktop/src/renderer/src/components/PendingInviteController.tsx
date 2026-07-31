/**
 * Replays a web `/invite/<kod>` (or legacy `/kat/<kod>`) route once the session is authenticated:
 * opens the AddServerDialog on its join step with the code pre-filled. Signed
 * out? The capture (lib/invite-route) holds the code through the AuthScreen and
 * this effect fires right after login — the mobile PendingDeepLinkController
 * pattern. Headless; a no-op on Electron (nothing is ever captured there).
 */
import { useEffect } from "react";
import { captureInviteRouteFromLocation, consumePendingInviteCode } from "../lib/invite-route";
import { useAuthStore } from "../stores/auth-store";
import { useUiStore } from "../stores/ui-store";

// Capture at module load — before the first render, while the boot path is
// still exactly what the browser navigated to.
captureInviteRouteFromLocation();

export function PendingInviteController(): null {
  const status = useAuthStore((s) => s.status);

  useEffect(() => {
    if (status !== "authenticated") return;
    const code = consumePendingInviteCode();
    if (code !== null) {
      useUiStore.getState().openJoinWithCode(code);
    }
  }, [status]);

  return null;
}
