import { AnimatePresence } from "framer-motion";
import { Info } from "lucide-react";
import { useAppTranslation } from "../lib/i18n";
import { localizeVoiceEnded } from "../lib/voice-notices";
import { useVoiceStore } from "../stores/voice-store";
import { NoticeToast } from "./NoticeToast";

/** How long the "why your voice session ended" notice lingers before auto-dismiss. */
const EVICTION_TOAST_MS = 6_000;

/**
 * App-root notice for a voice session that ended for a NON-ERROR reason: the
 * single-active-session handoff (you joined voice on another device) or the
 * alone-idle close (everyone else had left, so the server closed the call).
 * CLAUDE.md §11/§26.
 *
 * The FSM has already left voice cleanly (idle) in both cases — this only EXPLAINS
 * why, so it is an info notice, not an error. Rendered at the root (not in
 * VoicePanel) so it survives the panel unmounting on leave; dismissing it — by
 * timer, ✕ or click — acknowledges the notice (clearing endedReason) so it never
 * re-fires. It renders into the app-root notice stack (App.tsx), which owns the
 * position so concurrent notices stack instead of overlapping.
 */
export function VoiceEvictionToast(): JSX.Element {
  const { t } = useAppTranslation();
  const endedReason = useVoiceStore((s) => s.endedReason);
  const acknowledge = useVoiceStore((s) => s.acknowledgeSessionReplaced);
  // Any non-error end reason gets a notice, and the COPY follows the reason:
  // "you joined on another device" for a handoff, "everyone else had left" for
  // the alone-idle close. Showing the handoff wording for an alone close is what
  // this mapping exists to prevent (§26).
  const message = localizeVoiceEnded(endedReason, t);

  return (
    <AnimatePresence>
      {message !== null && (
        <NoticeToast
          key="voice-eviction"
          tone="info"
          icon={<Info />}
          duration={EVICTION_TOAST_MS}
          onDismiss={acknowledge}
        >
          {message}
        </NoticeToast>
      )}
    </AnimatePresence>
  );
}
