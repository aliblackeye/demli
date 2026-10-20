import { useEffect, useState } from "react";
import { UserMinus } from "lucide-react";
import { cn } from "@demli/ui";
import { useAppTranslation } from "../lib/i18n";
import { aloneCountdownAt, aloneCountdownLabel } from "../lib/voice-notices";
import { useVoiceStore } from "../stores/voice-store";

/** Tick rate for the visible countdown. One second is all the label resolves to. */
const TICK_MS = 1_000;

/**
 * "You're the only one here — the call will close in M:SS."
 *
 * The client-side view of the server's alone-idle sweep, so nobody is disconnected
 * without warning. It renders ONLY when the engine has armed a deadline, which it
 * does exclusively for the surfaces the server actually sweeps (a DM call room or
 * a group-DM voice channel) — a SERVER voice channel never arms one, so this
 * component can never appear there. That gating lives in the engine
 * (`@demli/media/alone-watch`), not here, so both platforms share one rule.
 *
 * Deliberately has NO "stay" button: the founder asked for a warning, not a
 * negotiation. And it never leaves the room itself — the countdown reaching zero
 * only changes the wording, because the server decides who leaves (the real cut
 * lands within a minute of zero, on its next sweep tick).
 *
 * The per-second tick lives HERE rather than in the voice FSM: the store holds a
 * stable deadline timestamp, so only this small component re-renders each second
 * instead of every consumer of voice state (§27). No timer runs at all when there
 * is no deadline.
 */
export function AloneCountdownNotice({ className }: { className?: string }): JSX.Element | null {
  const { t } = useAppTranslation();
  const deadlineAt = useVoiceStore((s) => s.aloneDeadlineAt);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (deadlineAt === null) return;
    // Re-read the clock on mount/arm so the first paint is correct even if this
    // component mounted mid-window (re-opening the panel, a route change).
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [deadlineAt]);

  const countdown = aloneCountdownAt(deadlineAt, now);
  const label = aloneCountdownLabel(countdown, t);
  if (!label) return null;

  return (
    <p
      role="status"
      data-testid="alone-countdown"
      // Koyu Masa notice: a borderless amber wash (warning shares the gold
      // token) with the glyph carrying the meaning alongside the colour. The
      // ticking time uses tabular figures so the line does not jitter each second.
      className={cn(
        "flex items-start gap-2 rounded-lg bg-warning/12 px-2.5 py-2",
        "text-2xs leading-snug tabular-nums text-warning animate-fade-in",
        className,
      )}
    >
      <UserMinus aria-hidden className="mt-px size-3.5 shrink-0" />
      <span>{label}</span>
    </p>
  );
}
