import { useEffect, useState } from "react";
import { Timer } from "lucide-react-native";
import { aloneCountdownAt } from "@demli/media";
import { useAppTranslation } from "@/lib/i18n";
import { space } from "@/theme/theme";
import { useVoiceStore } from "@/stores/voice-store";
import { Banner } from "../ui/Banner";
import { aloneCountdownLabel } from "./voice-ended";

/** Tick rate for the visible countdown. One second is all the label resolves to. */
const TICK_MS = 1_000;

/**
 * "You're the only one here — the call will close in M:SS." (mobile twin of the
 * desktop `AloneCountdownNotice`).
 *
 * Renders ONLY when the engine has armed a deadline, which it does exclusively
 * for the surfaces the server actually sweeps: a DM call room or a group-DM voice
 * channel. A SERVER voice channel never arms one, so this can never appear there
 * — that gating lives in the shared engine (`@demli/media/alone-watch`), so
 * both platforms obey one rule rather than two hand-written copies.
 *
 * No "stay" button (the founder asked for a warning, not a negotiation) and no
 * self-leave: reaching zero only changes the wording. The server closes the room.
 *
 * Drawn as the kit's warning Banner (gold wash, timer glyph). It drops in once
 * when the deadline arms; the per-second text change is NOT re-announced
 * (`live="none"`), or TalkBack would read the clock out every second.
 *
 * The per-second tick lives here, not in the voice FSM: the store holds a stable
 * deadline, so only this small component re-renders each second (§27), and no
 * timer runs at all when there is no deadline.
 */
export function AloneCountdownNotice({ marginTop }: { marginTop?: number }): JSX.Element | null {
  const { t } = useAppTranslation();
  const deadlineAt = useVoiceStore((s) => s.aloneDeadlineAt);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (deadlineAt === null) return;
    // Re-read the clock whenever the deadline arms/changes so a screen mounted
    // mid-window paints the correct value immediately.
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [deadlineAt]);

  const label = aloneCountdownLabel(aloneCountdownAt(deadlineAt, now), t);
  if (!label) return null;

  return (
    <Banner
      variant="warning"
      icon={Timer}
      title={label}
      live="none"
      style={{ marginHorizontal: space.lg, marginTop: marginTop ?? space.sm }}
    />
  );
}
