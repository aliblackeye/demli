import { useEffect, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { ShieldBan } from "lucide-react";
import { useAppTranslation } from "../lib/i18n";
import { setBlockedNoticeListener } from "../lib/blocked-notice";
import type { BlockedAction } from "../lib/errors";
import { NoticeToast } from "./NoticeToast";

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
export function BlockedSendToast(): JSX.Element {
  const { t } = useAppTranslation();
  const [action, setAction] = useState<BlockedAction | null>(null);
  // Bumped per refusal so a second identical refusal gets the full duration again.
  const [sequence, setSequence] = useState(0);

  useEffect(() => {
    setBlockedNoticeListener((next) => {
      setAction(next);
      setSequence((n) => n + 1);
    });
    return () => setBlockedNoticeListener(null);
  }, []);

  return (
    <AnimatePresence>
      {action !== null && (
        <NoticeToast
          key="blocked-notice"
          tone="danger"
          icon={<ShieldBan />}
          duration={NOTICE_MS}
          timerKey={sequence}
          onDismiss={() => setAction(null)}
        >
          {t(MESSAGE_KEY[action])}
        </NoticeToast>
      )}
    </AnimatePresence>
  );
}
