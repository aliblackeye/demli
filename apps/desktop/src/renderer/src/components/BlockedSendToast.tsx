import { useEffect, useState } from "react";
import { AnimatePresence, m } from "framer-motion";
import { ShieldBan } from "lucide-react";
import { cn } from "@demli/ui";
import { toastPop } from "@demli/app-ui";
import { useAppTranslation } from "../lib/i18n";
import { setBlockedNoticeListener } from "../lib/blocked-notice";
import type { BlockedAction } from "../lib/errors";

/** How long the "that couldn't go through" notice lingers. */
const NOTICE_MS = 6_000;

/** Catalog key per refused action — resolved at render so a locale switch relabels. */
const MESSAGE_KEY = {
  message: "errors.blockedMessage",
  friendRequest: "errors.blockedFriendRequest",
  call: "errors.blockedCall",
  addMember: "errors.blockedAddMember",
} as const satisfies Record<BlockedAction, string>;

/**
 * App-root notice for an action the server refused because a block exists (M18 /
 * ADR 0017) — currently a DM send and a DM call start.
 *
 * Both of those fail in layers with no local place to show a reason: a queued
 * send lands in the shared outbox (whose error-key union has no `blocked` member
 * and is not this layer's to widen, so the row keeps its generic "rejected"
 * copy), and a call start fails inside the call controller, whose error hook only
 * logs. Without this the message would fail without explanation and the call
 * button would appear to do nothing.
 *
 * The copy is deliberately symmetric and blameless: the server sends the same
 * `BLOCKED` code whether this user blocked the other or the other way round, so
 * "You can't message this user" is the most that may ever be said. Wording that
 * let the two cases be told apart would defeat the block itself (§28).
 */
export function BlockedSendToast(): JSX.Element | null {
  const { t } = useAppTranslation();
  const [action, setAction] = useState<BlockedAction | null>(null);

  useEffect(() => {
    setBlockedNoticeListener((next) => setAction(next));
    return () => setBlockedNoticeListener(null);
  }, []);

  useEffect(() => {
    if (action === null) return;
    const timer = window.setTimeout(() => setAction(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [action]);

  return (
    <AnimatePresence>
      {action !== null && (
        <div
          key="blocked-notice"
          className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4"
        >
          <m.button
            type="button"
            role="status"
            onClick={() => setAction(null)}
            variants={toastPop}
            initial="initial"
            animate="animate"
            exit="exit"
            className={cn(
              "pointer-events-auto flex max-w-sm items-start gap-2 rounded-lg text-left",
              "border border-stroke bg-raised px-3.5 py-2.5 text-sm text-fg shadow-lg",
            )}
          >
            <ShieldBan className="mt-0.5 size-4 shrink-0 text-danger" />
            <span>{t(MESSAGE_KEY[action])}</span>
          </m.button>
        </div>
      )}
    </AnimatePresence>
  );
}
