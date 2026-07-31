import { useEffect, useState } from "react";
import { AnimatePresence, m } from "framer-motion";
import { AlertTriangle } from "lucide-react";
import { cn } from "@demli/ui";
import { toastPop } from "@demli/app-ui";
import { useAppTranslation } from "../lib/i18n";
import { setOutboxChannelGoneListener } from "../realtime/outbox";

/** How long the "these messages were not sent" notice lingers. */
const NOTICE_MS = 8_000;

/**
 * App-root notice for messages the offline queue had to abandon (M17).
 *
 * A queued send whose channel was deleted (or that we lost access to) can NEVER
 * be delivered. Silently dropping it would be the worst outcome — the user typed
 * something and would assume it went through — so the queue reports it and this
 * tells them, once, with the count (§26).
 *
 * Rendered at the ROOT, not inside a channel view: by definition the channel it
 * refers to is gone, so there is no surface left to attach the message to. Held
 * in local state rather than a store because nothing else in the app ever needs
 * to read it (§27 — no store subscribers, no re-renders elsewhere).
 */
export function OutboxChannelGoneToast(): JSX.Element | null {
  const { t } = useAppTranslation();
  const [count, setCount] = useState(0);

  useEffect(() => {
    setOutboxChannelGoneListener((_channelId, dropped) => {
      if (dropped.length === 0) return;
      setCount((current) => current + dropped.length);
    });
  }, []);

  useEffect(() => {
    if (count === 0) return;
    const timer = window.setTimeout(() => setCount(0), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [count]);

  return (
    <AnimatePresence>
      {count > 0 && (
        <div
          key="outbox-gone"
          className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4"
        >
          <m.button
            type="button"
            role="status"
            onClick={() => setCount(0)}
            variants={toastPop}
            initial="initial"
            animate="animate"
            exit="exit"
            className={cn(
              "pointer-events-auto flex max-w-sm items-start gap-2 rounded-lg text-left",
              "border border-stroke bg-raised px-3.5 py-2.5 text-sm text-fg shadow-lg",
            )}
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-idle" />
            <span>
              {t("desktop:chat.queueChannelGone")}{" "}
              <span className="text-fg-muted">
                ({t("desktop:chat.queuedCount", { count })})
              </span>
            </span>
          </m.button>
        </div>
      )}
    </AnimatePresence>
  );
}
