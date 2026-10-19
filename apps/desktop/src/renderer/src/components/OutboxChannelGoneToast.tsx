import { useEffect, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { AlertTriangle } from "lucide-react";
import { useAppTranslation } from "../lib/i18n";
import { setOutboxChannelGoneListener } from "../realtime/outbox";
import { NoticeToast } from "./NoticeToast";

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
export function OutboxChannelGoneToast(): JSX.Element {
  const { t } = useAppTranslation();
  const [count, setCount] = useState(0);

  useEffect(() => {
    setOutboxChannelGoneListener((_channelId, dropped) => {
      if (dropped.length === 0) return;
      setCount((current) => current + dropped.length);
    });
  }, []);

  return (
    <AnimatePresence>
      {count > 0 && (
        <NoticeToast
          key="outbox-gone"
          tone="warning"
          icon={<AlertTriangle />}
          duration={NOTICE_MS}
          // A later batch restarts the clock: the count just changed under the reader.
          timerKey={count}
          onDismiss={() => setCount(0)}
        >
          {t("desktop:chat.queueChannelGone")}{" "}
          <span className="text-fg-muted">({t("desktop:chat.queuedCount", { count })})</span>
        </NoticeToast>
      )}
    </AnimatePresence>
  );
}
