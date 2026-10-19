import { AnimatePresence } from "framer-motion";
import { Bell } from "lucide-react";
import { dispatchNotificationActivation } from "../notifications/notification-manager";
import {
  IN_APP_TOAST_MS,
  useInAppNotifications,
  type InAppNotification,
} from "../notifications/in-app-notifications";
import { NoticeToast } from "./NoticeToast";

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
 * ({@link dispatchNotificationActivation}), so the two paths cannot drift. The
 * card is the shared {@link NoticeToast} (hover pauses its clock, ✕ / Esc
 * dismiss), so it looks and behaves like every other notice in the app.
 *
 * Mounted at the app root, fixed-position, top-right: it never participates in
 * the column/drawer layout and can never push or resize chat (§27).
 */
function ToastCard({ item }: { item: InAppNotification }): JSX.Element {
  const dismiss = useInAppNotifications((s) => s.dismiss);
  return (
    <NoticeToast
      tone="info"
      icon={<Bell />}
      duration={IN_APP_TOAST_MS}
      onActivate={() => dispatchNotificationActivation(item.navigate)}
      onDismiss={() => dismiss(item.id)}
    >
      <span className="block truncate font-medium text-fg">{item.title}</span>
      {item.body.length > 0 && (
        <span className="mt-0.5 line-clamp-2 block text-label text-fg-muted">{item.body}</span>
      )}
    </NoticeToast>
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
