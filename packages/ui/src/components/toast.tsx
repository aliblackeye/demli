import * as React from "react";
import { X } from "lucide-react";
import { cn } from "../lib/cn";

export type ToastVariant = "neutral" | "success" | "accent" | "danger";

export interface ToastOptions {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** Auto-dismiss after this many ms. `Infinity` keeps it until dismissed. Default 5000. */
  duration?: number;
  action?: { label: string; onClick: () => void };
}

interface ToastRecord extends Required<Pick<ToastOptions, "title" | "variant" | "duration">> {
  id: number;
  description?: string;
  action?: ToastOptions["action"];
  closing: boolean;
}

/**
 * Module-level queue so any code (a store action, a media callback) can raise
 * a toast without threading a context through. Exactly one <Toaster/> renders
 * it — mounted once at the app root.
 */
let records: ToastRecord[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const MAX_VISIBLE = 3;
/** Removal fallback when no exit animation runs (stylesheet absent, jsdom). */
const EXIT_FALLBACK_MS = 400;

function emit(): void {
  for (const listener of listeners) listener();
}

/** Show a toast; returns its id for {@link dismissToast}. */
export function toast(options: ToastOptions): number {
  const id = nextId++;
  records = [
    ...records,
    {
      id,
      title: options.title,
      description: options.description,
      variant: options.variant ?? "neutral",
      duration: options.duration ?? 5000,
      action: options.action,
      closing: false,
    },
  ];
  emit();
  return id;
}

/** Start the exit animation; the toast unmounts when it ends. */
export function dismissToast(id: number): void {
  if (!records.some((r) => r.id === id && !r.closing)) return;
  records = records.map((r) => (r.id === id ? { ...r, closing: true } : r));
  emit();
  setTimeout(() => removeToast(id), EXIT_FALLBACK_MS);
}

function removeToast(id: number): void {
  if (!records.some((r) => r.id === id)) return;
  records = records.filter((r) => r.id !== id);
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = (): ToastRecord[] => records;

const toastClass = cn(
  "pointer-events-auto relative flex w-[min(22rem,calc(100vw-2rem))] items-start gap-3 rounded-xl surface-glass-strong",
  "py-3 pl-4 pr-11 text-sm",
  "data-[state=open]:animate-toast-in data-[state=closed]:animate-toast-out",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
);

const DOT_CLASS: Record<ToastVariant, string> = {
  neutral: "bg-fg-subtle",
  success: "bg-success",
  accent: "bg-accent",
  danger: "bg-danger",
};

function ToastItem({
  record,
  dismissLabel,
  paused,
}: {
  record: ToastRecord;
  dismissLabel: string;
  paused: boolean;
}): JSX.Element {
  React.useEffect(() => {
    if (record.closing || paused || !Number.isFinite(record.duration)) return;
    const timer = setTimeout(() => dismissToast(record.id), record.duration);
    return () => clearTimeout(timer);
  }, [record.closing, record.duration, record.id, paused]);

  return (
    <li
      role={record.variant === "danger" ? "alert" : "status"}
      aria-atomic="true"
      data-state={record.closing ? "closed" : "open"}
      data-variant={record.variant}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") dismissToast(record.id);
      }}
      onAnimationEnd={(event) => {
        if (record.closing && event.target === event.currentTarget) removeToast(record.id);
      }}
      className={toastClass}
    >
      <span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", DOT_CLASS[record.variant])} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-medium text-fg">{record.title}</span>
        {record.description && <span className="text-label text-fg-muted">{record.description}</span>}
        {record.action && (
          <button
            type="button"
            onClick={() => {
              record.action?.onClick();
              dismissToast(record.id);
            }}
            className={cn(
              "mt-1.5 self-start rounded-sm text-label font-semibold text-accent transition-colors motion-hover hover:text-accent-hover",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
            )}
          >
            {record.action.label}
          </button>
        )}
      </span>
      <button
        type="button"
        aria-label={dismissLabel}
        onClick={() => dismissToast(record.id)}
        className={cn(
          "absolute right-2 top-2 flex size-7 items-center justify-center rounded-md text-fg-faint",
          "transition-colors motion-hover hover:bg-raised hover:text-fg",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        )}
      >
        <X aria-hidden className="size-3.5" />
      </button>
    </li>
  );
}

export interface ToasterProps {
  /** Accessible name of the region ("Bildirimler"). */
  label: string;
  /** Accessible name of each toast's close button ("Kapat"). */
  dismissLabel: string;
  position?: "bottom-center" | "bottom-right" | "top-center";
  className?: string;
}

/**
 * The one toast region. Polite live region (danger toasts are `role="alert"`,
 * so they interrupt); hovering or focusing the stack pauses every timer, Esc
 * on a focused toast dismisses it. At most three show at once; later ones wait
 * their turn.
 */
export function Toaster({ label, dismissLabel, position = "bottom-center", className }: ToasterProps): JSX.Element {
  const all = React.useSyncExternalStore(subscribe, snapshot, snapshot);
  const [paused, setPaused] = React.useState(false);
  const visible = all.slice(0, MAX_VISIBLE);

  return (
    <section
      aria-label={label}
      aria-live="polite"
      className={cn(
        "pointer-events-none fixed z-[60] flex flex-col gap-2 p-4",
        position === "bottom-center" && "inset-x-0 bottom-0 items-center",
        position === "bottom-right" && "bottom-0 right-0 items-end",
        position === "top-center" && "inset-x-0 top-0 items-center",
        className,
      )}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPaused(false);
      }}
    >
      <ol className="flex flex-col gap-2">
        {visible.map((record) => (
          <ToastItem key={record.id} record={record} dismissLabel={dismissLabel} paused={paused} />
        ))}
      </ol>
    </section>
  );
}
