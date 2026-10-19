/**
 * Settings building blocks (M16 Dalga 3, Koyu Masa).
 *
 * Product-specific composition of the `@demli/ui` primitives that every settings
 * surface shares — the user settings layer, the server-settings tabs, and the
 * channel/category/invite dialogs:
 *
 *   SettingsGroup / SettingRow   the "ayar satırı" recipe: a borderless surface
 *                                card, rows split by a functional hairline (an
 *                                inset shadow, never a box border)
 *   ListSkeleton / InlineError   loading + failure states for every list
 *   DangerZone                   the danger-soft "tehlike alanı" card with an
 *                                inline two-step confirm
 *   ConfirmDialog                destructive confirmation: ghost cancel + action,
 *                                bottom-right (design doc §5 "Kiplikler")
 *   UnsavedChangesBar            Discord-style "you have unsaved changes" bar
 *                                that refuses to be ignored (it nudges)
 *   SegmentedTabs                tablist with a sliding tone indicator and
 *                                WAI-ARIA keyboard behaviour
 *   CharCount                    live `n/max` counter for capped fields
 *
 * Motion: `m.*` only (the renderer root is `LazyMotion strict`), transform +
 * opacity only, authored position spring for anything that moves. Reduced
 * motion is handled once at the root (`MotionConfig reducedMotion="user"`).
 * Hover is a tone change — nothing here lifts, scales or slides on hover.
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { AnimatePresence, m } from "framer-motion";
import { Loader2, TriangleAlert, type LucideIcon } from "lucide-react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Skeleton,
  cn,
} from "@demli/ui";
import { springs, transitions } from "@demli/app-ui";

/* ── Layout ─────────────────────────────────────────────────────────────── */

/** Uppercase group label above a settings card (12px, faint, tracked). */
export function SettingsLabel({
  children,
  className,
  id,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
}): JSX.Element {
  return (
    <h3
      id={id}
      className={cn("px-1 text-2xs font-semibold uppercase tracking-wider text-fg-faint", className)}
    >
      {children}
    </h3>
  );
}

/**
 * A titled group of setting rows on one surface card. Rows are separated by a
 * 1px functional hairline drawn as an inset shadow on every row after the
 * first — the card itself has no border (Koyu Masa: tone + radius separate).
 */
export function SettingsGroup({
  title,
  description,
  children,
  className,
  cardClassName,
}: {
  title?: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  cardClassName?: string;
}): JSX.Element {
  const labelId = useId();
  return (
    <section aria-labelledby={title ? labelId : undefined} className={cn("space-y-2", className)}>
      {(title || description) && (
        <header className="space-y-1">
          {title && <SettingsLabel id={labelId}>{title}</SettingsLabel>}
          {description && (
            <p className="px-1 text-label leading-relaxed text-fg-faint">{description}</p>
          )}
        </header>
      )}
      <div
        className={cn(
          "overflow-hidden rounded-xl bg-surface",
          "[&>*+*]:shadow-[inset_0_1px_0_var(--color-stroke)]",
          cardClassName,
        )}
      >
        {children}
      </div>
    </section>
  );
}

/**
 * One setting: icon box + title + description on the left, the control on the
 * right. `disabled` dims the TEXT only — a disabled control already paints its
 * own 40%, so dimming the whole row would stack the two.
 */
export function SettingRow({
  icon: Icon,
  title,
  description,
  children,
  disabled = false,
  className,
  titleId,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  /** The control (a Switch, a Button, a value chip …). */
  children?: ReactNode;
  disabled?: boolean;
  className?: string;
  /** Lets a control point `aria-labelledby` at the visible title. */
  titleId?: string;
}): JSX.Element {
  return (
    <div className={cn("flex items-start gap-3 px-4 py-3.5", className)}>
      {Icon && (
        <span
          aria-hidden
          className={cn(
            "mt-px flex size-8 shrink-0 items-center justify-center rounded-lg bg-raised/60 text-fg-muted",
            disabled && "opacity-50",
          )}
        >
          <Icon className="size-4" />
        </span>
      )}
      <div className={cn("min-w-0 flex-1", disabled && "opacity-50")}>
        <p id={titleId} className="text-sm font-medium leading-5 text-fg">
          {title}
        </p>
        {description && (
          <p className="mt-0.5 text-label leading-relaxed text-fg-faint">{description}</p>
        )}
      </div>
      {children !== undefined && <div className="flex shrink-0 items-center self-center">{children}</div>}
    </div>
  );
}

/** A plain block inside a {@link SettingsGroup} card (sliders, grids, notices). */
export function SettingsBlock({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return <div className={cn("px-4 py-3.5", className)}>{children}</div>;
}

/** Footnote under a group of settings — what the settings actually do. */
export function SettingsNote({
  icon: Icon,
  children,
}: {
  icon?: LucideIcon;
  children: ReactNode;
}): JSX.Element {
  return (
    <p className="flex gap-2 px-1 text-label leading-relaxed text-fg-faint">
      {Icon && <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0" />}
      <span>{children}</span>
    </p>
  );
}

/* ── States ─────────────────────────────────────────────────────────────── */

/**
 * Row-shaped skeletons (avatar circle + two text lines + an action pill) on a
 * surface card — the loading state of every people/session list. Skeletons, not
 * spinners, for content (founder rule).
 */
export function ListSkeleton({
  rows = 3,
  label,
  avatar = "circle",
  action = true,
}: {
  rows?: number;
  /** Spoken while loading, e.g. "Yükleniyor…". */
  label: string;
  avatar?: "circle" | "square" | "none";
  action?: boolean;
}): JSX.Element {
  const widths = ["w-28", "w-36", "w-24", "w-32", "w-20", "w-40"];
  return (
    <div role="status" aria-label={label} className="overflow-hidden rounded-xl bg-surface">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className={cn(
            "flex items-center gap-3 px-4 py-3",
            index > 0 && "shadow-[inset_0_1px_0_var(--color-stroke)]",
          )}
        >
          {avatar !== "none" && (
            <Skeleton shape={avatar === "circle" ? "circle" : "rect"} width={32} height={32} />
          )}
          <div className="min-w-0 flex-1">
            <Skeleton shape="line" height={13} className={widths[index % widths.length]} />
            <Skeleton shape="line" height={11} className="mt-2 w-20" />
          </div>
          {action && <Skeleton shape="rect" width={72} height={29} className="rounded-md" />}
        </div>
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}

/**
 * Inline failure block for a section that could not load: what happened (the
 * localized error) and the one thing the user can do about it (retry).
 */
export function InlineError({
  message,
  retryLabel,
  onRetry,
  retrying = false,
}: {
  message: string;
  retryLabel?: string;
  onRetry?: () => void;
  retrying?: boolean;
}): JSX.Element {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-xl bg-danger-surface px-4 py-3.5"
    >
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
      <p className="min-w-0 flex-1 text-sm leading-relaxed text-fg">{message}</p>
      {onRetry && retryLabel && (
        <Button variant="secondary" size="sm" onClick={onRetry} loading={retrying} className="shrink-0">
          {retryLabel}
        </Button>
      )}
    </div>
  );
}

/* ── Destructive ────────────────────────────────────────────────────────── */

/**
 * The "tehlike alanı" card: danger-soft surface, the consequence in plain words,
 * and a two-step inline confirm — the first press swaps the button for an
 * explicit "Evet, sil" + "İptal" pair, so a stray click never destroys anything.
 */
export function DangerZone({
  title,
  body,
  actionLabel,
  confirmLabel,
  cancelLabel,
  onConfirm,
  pending,
  disabled = false,
  confirming,
  onConfirmingChange,
  innerRef,
}: {
  title: string;
  body: ReactNode;
  actionLabel: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  pending: boolean;
  disabled?: boolean;
  confirming: boolean;
  onConfirmingChange: (next: boolean) => void;
  innerRef?: React.Ref<HTMLDivElement>;
}): JSX.Element {
  return (
    <section ref={innerRef} className="rounded-xl bg-danger-surface p-4">
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      <p className="mt-1 text-label leading-relaxed text-fg-muted">{body}</p>
      <div className="mt-3 min-h-[29px]">
        <AnimatePresence mode="wait" initial={false}>
          {confirming ? (
            <m.div
              key="confirm"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0, transition: springs.position }}
              exit={{ opacity: 0, transition: transitions.instant }}
              className="flex flex-wrap gap-2"
            >
              <Button variant="danger" size="sm" loading={pending} disabled={disabled} onClick={onConfirm}>
                {confirmLabel}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={pending || disabled}
                onClick={() => onConfirmingChange(false)}
              >
                {cancelLabel}
              </Button>
            </m.div>
          ) : (
            <m.div
              key="ask"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: transitions.fast }}
              exit={{ opacity: 0, transition: transitions.instant }}
            >
              <Button
                variant="danger"
                size="sm"
                disabled={pending || disabled}
                onClick={() => onConfirmingChange(true)}
              >
                {actionLabel}
              </Button>
            </m.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}

/**
 * Destructive confirmation dialog. `layer="settings"` lifts scrim AND card
 * above the full-screen settings layer (z-[55]) — a confirm opened from inside
 * settings must never render behind it.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel,
  closeLabel,
  onConfirm,
  pending,
  error,
  tone = "danger",
  layer = "base",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  /** Body copy (the consequence) and any inline error. */
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  closeLabel: string;
  onConfirm: () => void;
  pending: boolean;
  error?: ReactNode;
  tone?: "danger" | "primary";
  layer?: "base" | "settings";
}): JSX.Element {
  const layerClass = layer === "settings" ? "z-[58]" : undefined;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // A request in flight must finish (or fail) before the dialog goes away,
        // or its outcome lands on a surface the user can no longer see.
        if (!next && pending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        closeLabel={closeLabel}
        className={cn("max-w-md", layerClass)}
        overlayClassName={layerClass}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {(children || error) && (
          <DialogBody className="space-y-3 pb-2">
            {children}
            {error}
          </DialogBody>
        )}
        <DialogFooter className="pt-4">
          <Button variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button variant={tone === "danger" ? "danger" : "primary"} loading={pending} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Unsaved changes ────────────────────────────────────────────────────── */

/**
 * "Kaydedilmemiş değişikliklerin var" bar. Rises in on the position spring when a
 * form turns dirty and sinks away once it is saved or reset. When the user tries
 * to leave anyway, the owner bumps `nudge`: the bar turns to the danger wash,
 * says why nothing happened and gives one short shake (transform only, dropped
 * under reduced motion) — feedback, not decoration.
 */
export function UnsavedChangesBar({
  open,
  saving,
  nudge,
  message,
  nudgeMessage,
  resetLabel,
  saveLabel,
  onReset,
  onSave,
  saveDisabled = false,
  className,
}: {
  open: boolean;
  saving: boolean;
  /** Increment to flag a blocked leave attempt. */
  nudge: number;
  message: string;
  nudgeMessage: string;
  resetLabel: string;
  saveLabel: string;
  onReset: () => void;
  onSave: () => void;
  saveDisabled?: boolean;
  className?: string;
}): JSX.Element {
  const [alert, setAlert] = useState(false);
  const lastNudge = useRef(nudge);

  useEffect(() => {
    if (nudge === lastNudge.current) return;
    lastNudge.current = nudge;
    if (!open) return;
    setAlert(true);
    const timer = window.setTimeout(() => setAlert(false), 1800);
    return () => window.clearTimeout(timer);
  }, [nudge, open]);

  useEffect(() => {
    if (!open) setAlert(false);
  }, [open]);

  return (
    <AnimatePresence initial={false}>
      {open && (
        <m.div
          key="unsaved"
          role="region"
          aria-label={message}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0, transition: springs.position }}
          exit={{ opacity: 0, y: 12, transition: transitions.fast }}
          className={cn("pointer-events-auto", className)}
        >
          <m.div
            key={alert ? `alert-${nudge}` : "calm"}
            animate={alert ? { x: [0, -6, 6, -3, 3, 0] } : { x: 0 }}
            transition={{ duration: 0.36, ease: "easeOut" }}
            className={cn(
              "relative flex items-center gap-3 overflow-hidden rounded-xl py-2 pl-4 pr-2 surface-glass-strong",
              "shadow-[inset_0_-1px_0_rgb(38_49_64/0.32)]",
            )}
          >
            {/* The danger wash is its own layer so the glass underneath keeps
                its blur — swapping the background would drop the frost. */}
            <span
              aria-hidden
              className={cn(
                "pointer-events-none absolute inset-0 bg-danger-surface transition-opacity motion-fast",
                alert ? "opacity-100" : "opacity-0",
              )}
            />
            <p
              aria-live="polite"
              className={cn(
                "relative min-w-0 flex-1 truncate text-sm font-medium transition-colors motion-fast",
                alert ? "text-danger" : "text-fg",
              )}
            >
              {alert ? nudgeMessage : message}
            </p>
            <Button variant="ghost" size="sm" disabled={saving} onClick={onReset}>
              {resetLabel}
            </Button>
            <Button variant="accent" size="sm" loading={saving} disabled={saveDisabled} onClick={onSave}>
              {saveLabel}
            </Button>
          </m.div>
        </m.div>
      )}
    </AnimatePresence>
  );
}

/* ── Tabs ───────────────────────────────────────────────────────────────── */

export interface SegmentedTab<T extends string> {
  id: T;
  label: string;
  /** Count bubble (pending requests). Rendered only above zero. */
  badge?: number;
  /** Spoken form of the badge ("3 bekleyen istek"). */
  badgeLabel?: string;
}

/** DOM id of the panel a {@link SegmentedTabs} tab controls. */
export const tabPanelId = (prefix: string, id: string): string => `${prefix}-panel-${id}`;
const tabId = (prefix: string, id: string): string => `${prefix}-tab-${id}`;

/**
 * A row of tabs with ONE sliding tone pill behind the selected tab (measured
 * offset + width, travelling on the position spring — `domAnimation` has no
 * layout animations, so it is a plain transform). WAI-ARIA tabs: one tab stop,
 * Arrow keys move and select, Home/End jump to the ends. Pair each panel with
 * {@link TabPanel}.
 */
export function SegmentedTabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  idPrefix,
  className,
  size = "md",
}: {
  tabs: readonly SegmentedTab<T>[];
  value: T;
  onChange: (next: T) => void;
  label: string;
  idPrefix: string;
  className?: string;
  size?: "sm" | "md";
}): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<{ x: number; width: number } | null>(null);

  const measure = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLElement>(`[data-tab-id="${value}"]`);
    if (!active) return;
    setIndicator({ x: active.offsetLeft, width: active.offsetWidth });
  }, [value]);

  useLayoutEffect(() => {
    measure();
  }, [measure, tabs]);

  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(list);
    return () => observer.disconnect();
  }, [measure]);

  const focusTab = (id: T): void => {
    listRef.current?.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    if (next === null) return;
    event.preventDefault();
    const target = tabs[next];
    if (!target) return;
    onChange(target.id);
    focusTab(target.id);
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      className={cn("relative flex min-w-0 items-center gap-1", className)}
    >
      {indicator && (
        <m.span
          aria-hidden
          data-tab-indicator
          className={cn(
            "pointer-events-none absolute left-0 top-0 rounded-lg bg-raised",
            size === "sm" ? "h-7" : "h-8",
          )}
          initial={false}
          animate={{ x: indicator.x, width: indicator.width }}
          transition={springs.position}
        />
      )}
      {tabs.map((tab, index) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={tabId(idPrefix, tab.id)}
            data-tab-id={tab.id}
            aria-selected={selected}
            aria-controls={tabPanelId(idPrefix, tab.id)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "relative z-[1] flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-lg font-medium",
              size === "sm" ? "h-7 px-2.5 text-label" : "h-8 px-3 text-sm",
              "transition-colors motion-hover",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
              selected ? "text-fg" : "text-fg-muted hover:bg-wash hover:text-fg",
            )}
          >
            {tab.label}
            {tab.badge !== undefined && tab.badge > 0 && (
              <span
                role={tab.badgeLabel ? "img" : undefined}
                aria-label={tab.badgeLabel}
                className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-danger px-1.5 text-2xs font-semibold tabular-nums text-on-accent"
              >
                {tab.badge > 99 ? "99+" : tab.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** The panel half of {@link SegmentedTabs}; fades its content in on switch. */
export function TabPanel({
  idPrefix,
  id,
  children,
  className,
}: {
  idPrefix: string;
  id: string;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <m.div
      key={id}
      role="tabpanel"
      id={tabPanelId(idPrefix, id)}
      aria-labelledby={tabId(idPrefix, id)}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0, transition: springs.position }}
      className={className}
    >
      {children}
    </m.div>
  );
}

/* ── Fields ─────────────────────────────────────────────────────────────── */

/** Live `n/max` counter; turns to the warning tone in the last 10%. */
export function CharCount({ value, max }: { value: string; max: number }): JSX.Element {
  const length = [...value].length;
  const near = length >= Math.floor(max * 0.9);
  return (
    <span
      aria-hidden
      className={cn("shrink-0 tabular-nums transition-colors motion-fast", near ? "text-warning" : "text-fg-faint")}
    >
      {length}/{max}
    </span>
  );
}

/** Help line with a trailing counter — the `help` slot of a capped Field. */
export function HelpWithCount({
  help,
  value,
  max,
}: {
  help?: ReactNode;
  value: string;
  max: number;
}): JSX.Element {
  return (
    <span className="flex items-start justify-between gap-3">
      <span className="min-w-0">{help}</span>
      <CharCount value={value} max={max} />
    </span>
  );
}

/** Inline busy line for a non-list region (minting an invite link). */
export function BusyLine({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div role="status" className="flex items-center gap-2 py-2 text-sm text-fg-muted">
      <Loader2 aria-hidden className="size-4 animate-spin" />
      {children}
    </div>
  );
}
