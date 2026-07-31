/**
 * In-app notification store — the single, foreground toast/banner the app shows
 * while it is OPEN (a friend request arriving, a request being accepted, …). This
 * is deliberately NOT the OS push notification (that fires when the app is closed,
 * owned by push/*); this is the "you're looking at the app right now, here's a
 * visible + audible heads-up" surface the founder asked for (friend requests had
 * no in-app feedback at all — connection.ts only silently invalidated queries).
 *
 * Keeps ONE current banner (the newest wins) — a queue would be overkill for the
 * rare social events that feed it. Callers push i18n KEYS, not resolved strings,
 * so the non-React realtime layer (connection.ts) stays translation-free and the
 * banner component (which has `useAppTranslation`) resolves them at render.
 */
import { create } from "zustand";

export type InAppNotificationKind = "friend-request" | "friend-accepted" | "message";

/**
 * Where a tapped banner navigates: a plain expo-router path (friend events) or a
 * pathname + params object (a chat message → its channel/DM/group-chat route).
 * Kept loose on purpose — the banner casts it into `router.push` (expo-router's
 * Href typing is stricter than this store needs to be).
 */
export type InAppNotificationHref = string | { pathname: string; params?: Record<string, string> };

/**
 * What a caller supplies; the store stamps an id on top. A banner's title/body
 * each come from EITHER an i18n key (static social copy, resolved at render) OR a
 * raw already-dynamic string (a message's sender name / content, which the
 * translation-free realtime layer produces directly). Exactly one of each pair is
 * set per banner.
 */
export interface InAppNotificationInput {
  kind: InAppNotificationKind;
  /** i18n key for the bold title line (mutually exclusive with `titleText`). */
  titleKey?: string;
  /** Raw title string (a message's sender name) — bypasses translation. */
  titleText?: string;
  /** i18n key for the body line (mutually exclusive with `bodyText`). */
  bodyKey?: string;
  /** Raw body string (a message preview) — bypasses translation. */
  bodyText?: string;
  /** Interpolation values for a keyed body (only `name` is ever templated today). */
  bodyParams?: { name?: string };
  /** Target to open when the banner is tapped. */
  href?: InAppNotificationHref;
}

export interface InAppNotification extends InAppNotificationInput {
  /** Monotonic id — changing it is what re-triggers the banner's slide-in. */
  id: string;
}

interface InAppNotificationStore {
  current: InAppNotification | null;
  show: (input: InAppNotificationInput) => void;
  /** Dismiss the current banner; pass an id to only clear if it still matches. */
  dismiss: (id?: string) => void;
}

let seq = 0;

export const useInAppNotificationStore = create<InAppNotificationStore>((set, get) => ({
  current: null,
  show: (input) => {
    seq += 1;
    set({ current: { ...input, id: `iand-${seq}` } });
  },
  dismiss: (id) => {
    const cur = get().current;
    if (!cur) return;
    // Guard against a stale timer clearing a newer banner that replaced this one.
    if (id !== undefined && cur.id !== id) return;
    set({ current: null });
  },
}));

/** Imperative helper for non-React callers (realtime/connection.ts). */
export function showInAppNotification(input: InAppNotificationInput): void {
  useInAppNotificationStore.getState().show(input);
}
