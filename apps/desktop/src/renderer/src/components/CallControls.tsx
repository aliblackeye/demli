/**
 * The call-surface control vocabulary, shared by every place a call can be
 * driven from: the voice panel and the DM call dock in the sidebar, the floating
 * call pill, the in-stage control bar and the incoming-call card.
 *
 * One component on purpose. The founder's rule is that a server voice room, a
 * group call and a DM call must not feel different (M16 §1); five hand-rolled
 * button styles is exactly how they drifted apart before. The STATE vocabulary
 * is the design system's (Koyu Masa §1.4), read the same way on every surface:
 *
 *   neutral  the control is idle (camera off, not sharing)
 *   on       something of yours is LIVE (camera on, screen shared) — coral wash
 *   off      something you normally have is cut (mic muted, deafened) — pink wash
 *   leave    ends your presence in the room — the only SOLID pink fill, with the
 *            dark `on-accent` ink (white on #ff6fb5 is 2.6:1)
 *   accept   answers a ring — solid online green, dark ink
 *
 * Colour never carries the meaning alone: every state also swaps its glyph
 * (Mic → MicOff, Video → VideoOff) and its accessible name, and toggles announce
 * `aria-pressed`. Hover is a tone change only (200ms base layer); press gives a
 * tiny scale "give" — the only transform, and only on press (design doc §4).
 *
 * A disabled control keeps its tooltip (wrapped in a span, because a disabled
 * button receives no pointer events) so it always says WHY it is unavailable —
 * a dead-looking button with no reason is the §35 failure this guards against.
 */

import type { LucideIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger, cn } from "@demli/ui";

export type CallControlTone = "neutral" | "on" | "off" | "leave" | "accept";

/**
 * `panel` — a square cell of the sidebar control grid (fills its column).
 * `round` — a 40px circle on a glass bar (stage bar, call pill).
 * `round-sm` — a 32px circle (call pill, banners).
 * `hero` — the 56px answer / decline circles of the incoming-call card.
 */
export type CallControlSize = "panel" | "round" | "round-sm" | "hero";

/**
 * `solid` sits on an opaque surface (sidebar card): neutral is the raised tone.
 * `glass` sits on a translucent bar over video: neutral is a white wash, which
 * lifts whatever is underneath instead of painting an opaque disc on the film.
 */
export type CallControlSurface = "solid" | "glass";

const TONE: Record<CallControlSurface, Record<CallControlTone, string>> = {
  solid: {
    neutral: "bg-raised text-fg hover:bg-raised-hover active:bg-raised-pressed",
    on: "bg-accent-surface text-accent-hover hover:bg-accent/20 active:bg-accent/28",
    off: "bg-danger/12 text-danger hover:bg-danger/20 active:bg-danger/28",
    leave: "bg-danger text-on-accent hover:bg-danger/90 active:bg-danger/80",
    accept: "bg-online text-on-accent hover:bg-online/90 active:bg-online/80",
  },
  glass: {
    neutral: "bg-wash text-fg hover:bg-wash-strong active:bg-wash",
    on: "bg-accent-surface text-accent-hover hover:bg-accent/20 active:bg-accent/28",
    off: "bg-danger/16 text-danger hover:bg-danger/24 active:bg-danger/30",
    leave: "bg-danger text-on-accent hover:bg-danger/90 active:bg-danger/80",
    accept: "bg-online text-on-accent hover:bg-online/90 active:bg-online/80",
  },
};

const SIZE: Record<CallControlSize, string> = {
  panel: "h-8 w-full rounded-lg [&_svg]:size-4",
  round: "size-10 rounded-full [&_svg]:size-[18px]",
  "round-sm": "size-8 rounded-full [&_svg]:size-4",
  hero: "size-14 rounded-full [&_svg]:size-6",
};

/** The wide pill keeps the height of its size step and lets the width grow. */
const WIDE: Record<CallControlSize, string> = {
  panel: "h-8 rounded-lg px-4 [&_svg]:size-4",
  round: "h-10 rounded-full px-5 [&_svg]:size-[18px]",
  "round-sm": "h-8 rounded-full px-4 [&_svg]:size-4",
  hero: "h-14 rounded-full px-6 [&_svg]:size-6",
};

export interface CallControlProps {
  /** What pressing it does, in words — accessible name AND tooltip text. */
  label: string;
  icon: LucideIcon;
  tone?: CallControlTone;
  size?: CallControlSize;
  surface?: CallControlSurface;
  /**
   * Toggle state for `aria-pressed` (mic, camera, share, fullscreen). Leave
   * undefined for a one-shot action (leave, accept, decline) — announcing those
   * as "not pressed" would be wrong.
   */
  pressed?: boolean;
  disabled?: boolean;
  /** Shown instead of `label` while disabled: why it is unavailable right now. */
  disabledHint?: string;
  onClick?: () => void;
  tooltipSide?: "top" | "right" | "bottom" | "left";
  /** Wider pill for the leave control on a bar, so danger reads by SHAPE too. */
  wide?: boolean;
  className?: string;
  "data-testid"?: string;
}

export function CallControl({
  label,
  icon: Icon,
  tone = "neutral",
  size = "panel",
  surface = "solid",
  pressed,
  disabled = false,
  disabledHint,
  onClick,
  tooltipSide = "top",
  wide = false,
  className,
  "data-testid": testId,
}: CallControlProps): JSX.Element {
  const button = (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      data-tone={tone}
      data-testid={testId}
      className={cn(
        "relative inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-1.5",
        // Tone change on hover (200ms), a small give on press. The base
        // transition layer deliberately leaves transforms out, so the press
        // scale (Tailwind v4 `scale` property) is named here.
        "transition-[background-color,color,opacity,scale] motion-hover active:scale-[0.96]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-app",
        "disabled:pointer-events-none disabled:opacity-40",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0",
        wide ? WIDE[size] : SIZE[size],
        TONE[surface][tone],
        className,
      )}
    >
      <Icon aria-hidden />
    </button>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {disabled ? (
          // A disabled button gets no pointer events, so the tooltip anchors on
          // a focusable wrapper — keyboard users reach the reason too.
          <span tabIndex={0} className={cn("inline-flex rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent", size === "panel" && "w-full")}>
            {button}
          </span>
        ) : (
          button
        )}
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>{disabled ? (disabledHint ?? label) : label}</TooltipContent>
    </Tooltip>
  );
}

export type LiveDotTone = "live" | "pending" | "error" | "idle";

const DOT_TONE: Record<LiveDotTone, string> = {
  live: "bg-accent",
  pending: "bg-warning",
  error: "bg-danger",
  idle: "bg-fg-subtle",
};

/**
 * The connection-state dot that leads every call status line. A PENDING state
 * (joining, reconnecting, ringing) breathes so "still working on it" is visible
 * at a glance; a settled state is still. The halo is the coral "dem" light of a
 * live room. Infinite animations stop entirely under reduced motion
 * (`motion-reduce:animate-none`) — the global guard only shortens them, which
 * for an infinite loop would strobe.
 */
export function LiveDot({
  tone,
  small = false,
  className,
}: {
  tone: LiveDotTone;
  /** 6px instead of 8px — for a dot inside a secondary text line. */
  small?: boolean;
  className?: string;
}): JSX.Element {
  const dim = small ? "size-1.5" : "size-2";
  return (
    <span aria-hidden className={cn("relative inline-flex shrink-0", dim, className)}>
      {tone === "pending" && (
        <span
          className={cn(
            "absolute inline-flex size-full animate-ping rounded-full opacity-60 motion-reduce:animate-none",
            DOT_TONE[tone],
          )}
        />
      )}
      <span
        className={cn(
          "relative inline-flex rounded-full transition-colors motion-hover",
          dim,
          DOT_TONE[tone],
          tone === "live" && "shadow-[0_0_8px_var(--color-accent-glow)]",
        )}
      />
    </span>
  );
}

/**
 * The "CANLI" pill: someone's screen is going out right now. Solid coral with
 * dark ink — the one place coral is a FILL on a call surface, so it is never
 * confused with the speaking light (a ring/glow) or a selected row (a wash).
 */
export function LivePill({
  label,
  className,
  srLabel,
}: {
  label: string;
  /** Spoken form when the pill stands in for a longer phrase ("Ekran paylaşıyor"). */
  srLabel?: string;
  className?: string;
}): JSX.Element {
  return (
    <span
      role={srLabel ? "img" : undefined}
      aria-label={srLabel}
      className={cn(
        "inline-flex shrink-0 select-none items-center rounded-pill bg-accent px-1.5 py-px",
        "text-badge font-bold uppercase leading-4 tracking-wide text-on-accent",
        className,
      )}
    >
      <span aria-hidden={srLabel ? true : undefined}>{label}</span>
    </span>
  );
}
