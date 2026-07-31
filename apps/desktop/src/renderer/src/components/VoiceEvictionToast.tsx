import { useEffect } from "react";
import { AnimatePresence, m } from "framer-motion";
import { Info } from "lucide-react";
import { cn } from "@demli/ui";
import { toastPop } from "@demli/app-ui";
import { useAppTranslation } from "../lib/i18n";
import { localizeVoiceEnded } from "../lib/voice-notices";
import { useVoiceStore } from "../stores/voice-store";

/** How long the "why your voice session ended" notice lingers before auto-dismiss. */
const EVICTION_TOAST_MS = 6_000;

/**
 * App-root notice for a voice session that ended for a NON-ERROR reason: the
 * single-active-session handoff (you joined voice on another device) or the
 * alone-idle close (everyone else had left, so the server closed the call).
 * CLAUDE.md §11/§26.
 *
 * The FSM has already left voice cleanly (idle) in both cases — this only EXPLAINS
 * why, so it is not an error banner. Rendered at the root (not in VoicePanel) so
 * it survives the panel unmounting on leave; auto-dismisses and acknowledges the
 * notice (clearing endedReason) so it never re-fires.
 */
export function VoiceEvictionToast(): JSX.Element | null {
  const { t } = useAppTranslation();
  const endedReason = useVoiceStore((s) => s.endedReason);
  const acknowledge = useVoiceStore((s) => s.acknowledgeSessionReplaced);
  // Any non-error end reason gets a notice, and the COPY follows the reason:
  // "you joined on another device" for a handoff, "everyone else had left" for
  // the alone-idle close. Showing the handoff wording for an alone close is what
  // this mapping exists to prevent (§26).
  const message = localizeVoiceEnded(endedReason, t);
  const visible = message !== null;

  useEffect(() => {
    if (!visible) return;
    const timer = window.setTimeout(acknowledge, EVICTION_TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [visible, acknowledge]);

  return (
    // AnimatePresence stays mounted so the toast fades/lifts on the way IN and OUT
    // (framer win over the old enter-only CSS `animate-fade-in`).
    <AnimatePresence>
      {visible && (
        <div
          key="voice-eviction"
          className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4"
        >
          <m.button
            type="button"
            role="status"
            onClick={acknowledge}
            variants={toastPop}
            initial="initial"
            animate="animate"
            exit="exit"
            className={cn(
              "pointer-events-auto flex max-w-sm items-center gap-2 rounded-lg",
              "border border-stroke bg-raised px-3.5 py-2.5 text-sm text-fg shadow-lg",
            )}
          >
            <Info className="size-4 shrink-0 text-accent" />
            <span>{message}</span>
          </m.button>
        </div>
      )}
    </AnimatePresence>
  );
}
