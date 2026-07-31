import { useEffect } from "react";
import { AnimatePresence, m } from "framer-motion";
import { Bell, X } from "lucide-react";
import { cn } from "@demli/ui";
import { toastPop } from "@demli/app-ui";
import { dispatchNotificationActivation } from "../notifications/notification-manager";
import {
  IN_APP_TOAST_MS,
  useInAppNotifications,
  type InAppNotification,
} from "../notifications/in-app-notifications";

/**
 * The in-app notification surface — the fallback that keeps the app from going
 * SILENT when no OS toast is available.
 *
 * It fires only when the notification manager picked the `"in-app"` sink: a
 * browser build whose origin has not been granted notification permission, or an
 * engine with no Notification API at all. On Electron, and on a granted browser,
 * the native toast is used and this renders nothing. Exactly one sink per alert,
 * so an event is never announced twice.
 *
 * Clicking a card routes exactly like clicking the native toast would
 * ({@link dispatchNotificationActivation}), so the two paths cannot drift.
 *
 * Mounted at the app root, fixed-position, top-right: it never participates in
 * the column/drawer layout and can never push or resize chat (§27).
 */
function ToastCard({ item }: { item: InAppNotification }): JSX.Element {
  const dismiss = useInAppNotifications((s) => s.dismiss);

  useEffect(() => {
    const timer = window.setTimeout(() => dismiss(item.id), IN_APP_TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [item.id, dismiss]);

  return (
    <m.div
      variants={toastPop}
      initial="initial"
      animate="animate"
      exit="exit"
      className={cn(
        "pointer-events-auto flex w-80 max-w-[calc(100vw-2rem)] items-start gap-2.5",
        "rounded-lg border border-stroke bg-raised p-3 shadow-lg",
      )}
    >
      <button
        type="button"
        onClick={() => {
          dispatchNotificationActivation(item.navigate);
          dismiss(item.id);
        }}
        className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
      >
        <Bell className="mt-0.5 size-4 shrink-0 text-accent" />
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-fg">{item.title}</span>
          {item.body.length > 0 && (
            <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-fg-faint">
              {item.body}
            </span>
          )}
        </span>
      </button>
      <button
        type="button"
        onClick={() => dismiss(item.id)}
        aria-label="Close"
        className="shrink-0 rounded p-0.5 text-fg-faint transition-colors hover:text-fg"
      >
        <X className="size-3.5" />
      </button>
    </m.div>
  );
}

export function InAppNotificationToast(): JSX.Element {
  const items = useInAppNotifications((s) => s.items);

  return (
    <div className="pointer-events-none fixed right-4 top-4 z-50 flex flex-col items-end gap-2">
      <AnimatePresence initial={false}>
        {items.map((item) => (
          <ToastCard key={item.id} item={item} />
        ))}
      </AnimatePresence>
    </div>
  );
}
