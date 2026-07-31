import { useEffect, useState } from "react";
import { AnimatePresence, m } from "framer-motion";
import { AlertTriangle, Check } from "lucide-react";
import { cn } from "@demli/ui";
import { toastPop } from "@demli/app-ui";
import { useAppTranslation } from "../lib/i18n";
import { setImageActionNoticeListener, type ImageActionNotice } from "../lib/image-actions";

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
 * list would either be hidden behind the overlay or die with it.
 *
 * A CANCELLED save produces no notice at all (see lib/image-actions.ts): the
 * user dismissed a dialog, which is a decision, not an event worth announcing.
 *
 * Held in local state rather than a store because nothing else in the app ever
 * reads it — no subscribers, no re-renders elsewhere (CLAUDE.md §27).
 */
export function ImageActionToast(): JSX.Element | null {
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

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(
      () => setNotice(null),
      notice.tone === "ok" ? OK_MS : ERROR_MS,
    );
    return () => window.clearTimeout(timer);
  }, [notice, sequence]);

  const isError = notice?.tone === "error";

  return (
    <AnimatePresence>
      {notice && (
        <div
          key={`image-action-${sequence}`}
          className="pointer-events-none fixed inset-x-0 bottom-6 z-[60] flex justify-center px-4"
        >
          <m.button
            type="button"
            role="status"
            onClick={() => setNotice(null)}
            variants={toastPop}
            initial="initial"
            animate="animate"
            exit="exit"
            className={cn(
              "pointer-events-auto flex max-w-sm items-start gap-2 rounded-lg text-left",
              "border border-stroke bg-raised px-3.5 py-2.5 text-sm text-fg shadow-lg",
            )}
          >
            {isError ? (
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
            ) : (
              <Check className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
            )}
            <span>{t(notice.key)}</span>
          </m.button>
        </div>
      )}
    </AnimatePresence>
  );
}
