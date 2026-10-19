import { useEffect, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { AlertTriangle, Check } from "lucide-react";
import { useAppTranslation } from "../lib/i18n";
import { setImageActionNoticeListener, type ImageActionNotice } from "../lib/image-actions";
import { NoticeToast } from "./NoticeToast";

/** How long a "saved" / "copied" confirmation lingers. */
const OK_MS = 2_400;
/** Failures get longer — the user has to read a sentence, not a checkmark. */
const ERROR_MS = 5_000;

/**
 * App-root confirmation for "save image" / "copy image".
 *
 * Rendered at the ROOT rather than inside the chat view because the action can
 * be started from the enlarged lightbox, which covers the whole viewport and
 * unmounts the moment the user closes it — a toast anchored inside the message
 * list would either be hidden behind the overlay or die with it. The app-root
 * notice stack (App.tsx) sits above the lightbox layer for the same reason.
 *
 * A CANCELLED save produces no notice at all (see lib/image-actions.ts): the
 * user dismissed a dialog, which is a decision, not an event worth announcing.
 *
 * Held in local state rather than a store because nothing else in the app ever
 * reads it — no subscribers, no re-renders elsewhere (CLAUDE.md §27).
 */
export function ImageActionToast(): JSX.Element {
  const { t } = useAppTranslation();
  const [notice, setNotice] = useState<ImageActionNotice | null>(null);
  // Bumped on every notice so an identical repeat still restarts the timer and
  // replays the animation.
  const [sequence, setSequence] = useState(0);

  useEffect(() => {
    setImageActionNoticeListener((next) => {
      setNotice(next);
      setSequence((n) => n + 1);
    });
    return () => setImageActionNoticeListener(null);
  }, []);

  const isError = notice?.tone === "error";

  return (
    <AnimatePresence>
      {notice && (
        <NoticeToast
          key={`image-action-${sequence}`}
          tone={isError ? "danger" : "success"}
          icon={isError ? <AlertTriangle /> : <Check />}
          duration={isError ? ERROR_MS : OK_MS}
          onDismiss={() => setNotice(null)}
        >
          {t(notice.key)}
        </NoticeToast>
      )}
    </AnimatePresence>
  );
}
