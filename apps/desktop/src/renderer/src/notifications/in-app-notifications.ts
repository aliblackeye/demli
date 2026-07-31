/**
 * In-app notification fallback.
 *
 * A notification must never be SILENTLY dropped. On the web build the OS toast
 * needs a permission the user may not have granted (or an engine that has no
 * Notification API at all — iOS Safari for most of its history); on desktop a
 * native toast can still fail. In every one of those cases the alert lands here
 * instead and is painted inside the app by {@link InAppNotificationToast}.
 *
 * This is a FALLBACK, not a parallel channel: the notification manager picks
 * exactly one sink per alert, so nothing is ever announced twice.
 *
 * Kept to a bounded queue (oldest dropped) with a per-entry auto-dismiss, so a
 * burst can never grow unbounded or cover the app.
 */

import { create } from "zustand";
import type { NotificationNavigate } from "@demli/app-ui";

/** How long one in-app toast lingers before it dismisses itself. */
export const IN_APP_TOAST_MS = 6_000;

/** Most toasts on screen at once; the oldest is dropped beyond this. */
const MAX_VISIBLE = 3;

export interface InAppNotification {
  /** Monotonic id — also the React key. */
  id: number;
  title: string;
  body: string;
  /** Where a click should take the user (same contract as a native toast). */
  navigate: NotificationNavigate;
}

interface InAppNotificationState {
  items: InAppNotification[];
  push: (entry: Omit<InAppNotification, "id">) => void;
  dismiss: (id: number) => void;
  clear: () => void;
}

let nextId = 1;

export const useInAppNotifications = create<InAppNotificationState>()((set) => ({
  items: [],
  push: (entry) =>
    set((state) => {
      const items = [...state.items, { ...entry, id: nextId++ }];
      return { items: items.slice(-MAX_VISIBLE) };
    }),
  dismiss: (id) => set((state) => ({ items: state.items.filter((i) => i.id !== id) })),
  clear: () => set({ items: [] }),
}));

/** Imperative entry point for the (non-React) notification manager. */
export function pushInAppNotification(entry: Omit<InAppNotification, "id">): void {
  useInAppNotifications.getState().push(entry);
}
