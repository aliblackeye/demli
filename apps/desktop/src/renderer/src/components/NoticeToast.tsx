import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { m } from "framer-motion";
import { X } from "lucide-react";
import { IconButton, cn } from "@demli/ui";
import { toastPop } from "@demli/app-ui";
import { useAppTranslation } from "../lib/i18n";

/**
 * What a notice is saying. The tone picks the glyph box colour only — the words
 * carry the meaning (§26), the colour is the at-a-glance hint.
 */
export type NoticeTone = "info" | "success" | "warning" | "danger";

const TONE_BOX: Record<NoticeTone, string> = {
  info: "bg-accent-surface text-accent",
  success: "bg-success/12 text-success",
  warning: "bg-warning/12 text-warning",
  danger: "bg-danger-surface text-danger",
};

export interface NoticeToastProps {
  tone: NoticeTone;
  /** A lucide glyph; sized by the box. */
  icon: ReactNode;
  /** The notice itself — one or two sentences, already localized. */
  children: ReactNode;
  /** Called when the notice should go: its timer ran out, ✕, Esc, or a click on the body. */
  onDismiss: () => void;
  /**
   * Auto-dismiss after this many ms of being VISIBLE AND UNATTENDED: hovering the
   * card or focusing anything inside it pauses the clock, and leaving resumes it
   * with whatever was left — a sentence is never yanked away mid-read.
   */
  duration: number;
  /**
   * Restart the clock when this changes (a repeated identical notice should be
   * on screen for its full duration again, not for the remainder of the first).
   */
  timerKey?: string | number;
  /**
   * Optional primary action for the body (the in-app notification routes to the
   * conversation it is about). Without it, clicking the body dismisses it.
   */
  onActivate?: () => void;
  /** Width override for a wider card (the top-right notification stack). */
  className?: string;
}

/**
 * The ONE notice card every app-root toast renders (voice handoff, abandoned
 * queue, image saved, blocked send, in-app notification, account-switch
 * failure). Koyu Masa: strong glass (92% + blur), radius 16, the landing's inset
 * pill line, no border and no outer shadow; a 28px tone box for the glyph.
 *
 * It lifts in on the position spring and sinks out on the fast step
 * (`toastPop`, framer `m.*` — LazyMotion-safe). Callers wrap it in
 * `<AnimatePresence>` so the exit plays.
 *
 * Danger notices are `role="alert"` (interrupting); everything else is a polite
 * `role="status"`. Esc on a focused notice dismisses it.
 */
export function NoticeToast({
  tone,
  icon,
  children,
  onDismiss,
  duration,
  timerKey,
  onActivate,
  className,
}: NoticeToastProps): JSX.Element {
  const { t } = useAppTranslation();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const remaining = useRef(duration);
  const startedAt = useRef(0);
  const timer = useRef<number | null>(null);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  const stop = useCallback((): void => {
    if (timer.current === null) return;
    window.clearTimeout(timer.current);
    timer.current = null;
    remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt.current));
  }, []);

  const start = useCallback((): void => {
    if (timer.current !== null) return;
    startedAt.current = Date.now();
    timer.current = window.setTimeout(() => {
      timer.current = null;
      dismissRef.current();
    }, remaining.current);
  }, []);

  // Pause while pointed at or focused, resume on leave. NATIVE listeners on the
  // card itself, not React's synthetic onPointerEnter/Leave: those are derived
  // from pointerover/out pairs across the whole tree, and when a sibling notice
  // unmounts under the pointer they were observed pausing the wrong card.
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const onFocusOut = (event: FocusEvent): void => {
      if (!card.contains(event.relatedTarget as Node | null)) start();
    };
    card.addEventListener("pointerenter", stop);
    card.addEventListener("pointerleave", start);
    card.addEventListener("focusin", stop);
    card.addEventListener("focusout", onFocusOut);
    return () => {
      card.removeEventListener("pointerenter", stop);
      card.removeEventListener("pointerleave", start);
      card.removeEventListener("focusin", stop);
      card.removeEventListener("focusout", onFocusOut);
    };
  }, [start, stop]);

  useEffect(() => {
    remaining.current = duration;
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    start();
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
  }, [duration, timerKey, start]);

  const body = (
    <span className="min-w-0 flex-1 py-1 text-sm leading-snug text-fg">{children}</span>
  );

  return (
    <m.div
      role={tone === "danger" ? "alert" : "status"}
      aria-live={tone === "danger" ? "assertive" : "polite"}
      variants={toastPop}
      initial="initial"
      animate="animate"
      exit="exit"
      ref={cardRef}
      onKeyDown={(event) => {
        if (event.key === "Escape") onDismiss();
      }}
      className={cn(
        "pointer-events-auto flex w-[min(24rem,calc(100vw-2rem))] items-start gap-3 rounded-xl py-2 pl-2 pr-1.5",
        "surface-glass-strong shadow-[inset_0_-1px_0_rgb(38_49_64/0.32)]",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn("grid size-8 shrink-0 place-items-center rounded-lg [&_svg]:size-4", TONE_BOX[tone])}
      >
        {icon}
      </span>
      <button
        type="button"
        onClick={() => {
          if (onActivate) onActivate();
          onDismiss();
        }}
        className={cn(
          "flex min-w-0 flex-1 cursor-pointer rounded-sm text-left",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
        )}
      >
        {body}
      </button>
      <IconButton
        variant="ghost"
        size="sm"
        label={t("buttons.close")}
        tooltipSide="left"
        onClick={onDismiss}
        className="size-7 rounded-sm [&_svg]:size-3.5"
      >
        <X aria-hidden />
      </IconButton>
    </m.div>
  );
}
