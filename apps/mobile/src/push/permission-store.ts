/**
 * Live notification-permission state shared by the Home banner, the Settings row
 * and the push lifecycle (field report 2026-10-20).
 *
 * One store so the three agree: a grant made from the banner flips the Settings
 * row too, and — the part that was missing — re-registers the push token
 * immediately. Before this, a user who turned notifications on from Settings
 * still had NO token on the server until the next sign-in, so pushes kept not
 * arriving after they had done the right thing.
 */
import { Linking } from "react-native";
import * as Notifications from "expo-notifications";
import { create } from "zustand";
import { permissionAction, type PermissionSnapshot } from "./permission-model";
import { registerPushToken } from "./push-manager";

interface PermissionStore extends PermissionSnapshot {
  /** Banner waved off — in memory only, so it returns on the next launch. */
  dismissed: boolean;
  /** Re-read the OS answer; registers the token when it just became granted. */
  refresh: () => Promise<PermissionSnapshot>;
  /** The banner/row action: in-app prompt while allowed, else system settings. */
  resolve: () => Promise<void>;
  dismiss: () => void;
}

export const useNotificationPermission = create<PermissionStore>((set, get) => ({
  status: "unknown",
  canAskAgain: true,
  dismissed: false,

  refresh: async () => {
    const before = get().status;
    try {
      const perms = await Notifications.getPermissionsAsync();
      const next: PermissionSnapshot = {
        status: perms.granted ? "granted" : "denied",
        canAskAgain: perms.canAskAgain,
      };
      set(next);
      if (next.status === "granted" && before === "denied") {
        void registerPushToken({ prompt: false });
      }
      return next;
    } catch {
      // A permissions read that throws (older OS, odd OEM) must not claim
      // notifications are off — stay "unknown", which shows nothing.
      set({ status: "unknown" });
      return { status: "unknown", canAskAgain: get().canAskAgain };
    }
  },

  resolve: async () => {
    if (permissionAction(get()) === "request") {
      try {
        const res = await Notifications.requestPermissionsAsync();
        if (res.granted) {
          set({ status: "granted", canAskAgain: res.canAskAgain });
          await registerPushToken({ prompt: false });
          return;
        }
        set({ status: "denied", canAskAgain: res.canAskAgain });
        // Android answers a repeat prompt with an instant "no" once the user has
        // declined; that is exactly when the settings page is the only route.
        if (res.canAskAgain) return;
      } catch {
        // fall through to settings
      }
    }
    // The user flips it there and comes back; the foreground listener in
    // PushController re-reads the answer (and registers) on return.
    await Linking.openSettings().catch(() => undefined);
  },

  dismiss: () => set({ dismissed: true }),
}));
