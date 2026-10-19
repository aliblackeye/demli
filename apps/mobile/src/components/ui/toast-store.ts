/**
 * Toast queue — the mobile twin of the desktop `toast()` in packages/ui.
 *
 * Module-level on purpose so any code (a store action, a media callback, a
 * mutation's onError) can raise a toast without threading a context through.
 * Exactly one <Toaster/> renders it, mounted once at the app root. Pure TS —
 * no React Native import — so the queue rules are unit-tested in node.
 */

export type ToastVariant = "neutral" | "success" | "accent" | "danger";

export interface ToastOptions {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** Auto-dismiss after this many ms. `Infinity` keeps it until dismissed. Default 4000. */
  duration?: number;
  action?: { label: string; onPress: () => void };
  /**
   * Stable key: raising a toast with the key of one already on screen REPLACES
   * it instead of stacking a duplicate ("Kopyalandı" tapped five times = one).
   */
  key?: string;
}

export interface ToastRecord {
  id: number;
  key?: string;
  title: string;
  description?: string;
  variant: ToastVariant;
  duration: number;
  action?: ToastOptions["action"];
}

/** Older toasts beyond this are dropped — a phone screen holds three, not ten. */
export const MAX_VISIBLE = 3;
export const DEFAULT_DURATION = 4000;

let records: ToastRecord[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Show a toast; returns its id for {@link dismissToast}. */
export function toast(options: ToastOptions): number {
  const id = nextId++;
  const record: ToastRecord = {
    id,
    key: options.key,
    title: options.title,
    description: options.description,
    variant: options.variant ?? "neutral",
    duration: options.duration ?? DEFAULT_DURATION,
    action: options.action,
  };
  const rest = options.key ? records.filter((r) => r.key !== options.key) : records;
  records = [...rest, record].slice(-MAX_VISIBLE);
  emit();
  return id;
}

export function dismissToast(id: number): void {
  if (!records.some((r) => r.id === id)) return;
  records = records.filter((r) => r.id !== id);
  emit();
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getToasts(): ToastRecord[] {
  return records;
}

/** Test seam: start from an empty queue. */
export function resetToastsForTest(): void {
  records = [];
  nextId = 1;
  emit();
}
