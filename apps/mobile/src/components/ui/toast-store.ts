/**
 * Toast queue — the mobile twin of the desktop `toast()` in packages/ui.
 *
 * Module-level on purpose so any code (a store action, a media callback, a
 * mutation's onError) can raise a toast without threading a context through.
 * Pure TS — no React Native import — so the queue rules are unit-tested in node.
 *
 * Hosts. On Android every RN `Modal` is its own window, and a view in the root
 * window can never draw above it — a root-only toaster would put feedback
 * BEHIND an open sheet, where its timer runs out unseen. So the queue is
 * rendered by exactly one host at a time: the most recently mounted
 * <Toaster/>. The app root mounts one; every Sheet mounts one inside its Modal
 * (the topmost window while it is open); any other Modal surface that raises
 * toasts must mount a <Toaster/> inside itself too. When a host unmounts, the
 * one beneath it takes the queue back.
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

let hosts: number[] = [];
let nextHostId = 1;
const announced = new Set<number>();

/** Register a mounted <Toaster/>; it becomes the active host. Returns its id. */
export function registerToastHost(): number {
  const id = nextHostId++;
  hosts = [...hosts, id];
  emit();
  return id;
}

export function unregisterToastHost(id: number): void {
  if (!hosts.includes(id)) return;
  hosts = hosts.filter((h) => h !== id);
  emit();
}

/** The host that renders the queue right now (the topmost window), or null. */
export function getActiveToastHost(): number | null {
  return hosts[hosts.length - 1] ?? null;
}

/**
 * True exactly once per toast: a toast that moves to another host (a sheet
 * opened over it) is drawn again there but must not be spoken twice.
 */
export function claimAnnouncement(id: number): boolean {
  if (announced.has(id)) return false;
  // Bounded: only ids still in the queue can ever be asked about again.
  for (const seen of announced) if (!records.some((r) => r.id === seen)) announced.delete(seen);
  announced.add(id);
  return true;
}

/** Test seam: start from an empty queue. */
export function resetToastsForTest(): void {
  records = [];
  nextId = 1;
  hosts = [];
  nextHostId = 1;
  announced.clear();
  emit();
}
