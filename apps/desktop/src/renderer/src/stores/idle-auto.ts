/**
 * Automatic "idle" (away) presence for the desktop/web renderer.
 *
 * After a stretch of inactivity, an ONLINE session is auto-flipped to "idle" and
 * the gateway is told so peers see the amber dot; the first activity afterwards
 * flips it straight back (founder: "bilgisayarda herhangi belli bi süre bi yere
 * dokunmayınca olmalı. mouse oynatınca çevrimiçiye dönmeli").
 *
 * TWO SOURCES, ONE RULE
 * ---------------------
 * "Inactivity" means the MACHINE, not this window — a user busy in a browser,
 * game or editor is at their computer and must stay online. So:
 *
 *   - DESKTOP: the main process watches the OS-wide inactivity clock
 *     (`powerMonitor.getSystemIdleTime()`) plus lock/sleep, and pushes the
 *     ANSWER over `window.demli.systemIdle` (see main/system-idle.ts).
 *     This module just applies it.
 *   - WEB: a browser tab has no such API, so the DOM listeners below remain the
 *     fallback. They only observe our own page — a real limitation of the
 *     surface, honestly scoped rather than pretended away.
 *
 * The split is decided by the platform BRIDGE (`lib/surface.ts`), never by a
 * User-Agent guess, and a desktop build whose watcher fails to arm degrades to
 * the DOM path instead of losing auto-away entirely.
 *
 * A MANUAL status choice (dnd / invisible / idle) is authoritative and suppresses
 * auto-away entirely — this only ever AUGMENTS the "online" pick, mirroring how
 * `getEffectiveSelfPresenceStatus` computes the broadcast status. The live
 * away-flag lives on `self-presence-store` (never persisted); the gateway push is
 * INJECTED (`startIdleAutoPresence(push)`) so this module has no dependency on the
 * realtime wiring — connection.ts owns the socket and hands us the push fn.
 *
 * IN A VOICE ROOM auto-away still applies. The dot means
 * "not at the keyboard", which is exactly true, and it drives nothing functional
 * — only `dnd` gates notifications/calls, and who is actually present in a call
 * is answered by the voice panel's mic/speaking indicators, not the presence dot.
 * Suppressing it would also mean importing the voice store (and with it LiveKit's
 * whole module graph) into a boot-path store for a cosmetic nuance — a bad trade
 * (§23, §27).
 *
 * Performance (§27): the desktop path costs one cheap syscall per poll IN MAIN
 * and IPC only on transitions. The web path's hot listener only writes a
 * timestamp; the store + socket are touched solely on the transitions, and a
 * coarse interval polls the clock instead of debouncing every mousemove into a
 * fresh timer.
 */

import type { SelectablePresenceStatus } from "@demli/types";
import { isDesktopSurface } from "../lib/surface";
import {
  getEffectiveSelfPresenceStatus,
  getSelfPresenceStatus,
  useSelfPresenceStore,
} from "./self-presence-store";

/**
 * No activity for this long → flip an ONLINE session to "idle". ~5 min.
 *
 * THE single knob: the desktop watcher is handed this exact number over IPC
 * (`systemIdle.start`) and the web fallback below measures against it, so both
 * surfaces are configured from here and cannot drift.
 */
export const IDLE_THRESHOLD_MS = 5 * 60_000;

/** How often the WEB fallback checks its inactivity clock. Coarse — not time-critical. */
const CHECK_INTERVAL_MS = 30_000;

/** DOM signals that count as "the user is present". All passive + capturing. */
const ACTIVITY_EVENTS = [
  "mousemove",
  "mousedown",
  "keydown",
  "wheel",
  "touchstart",
  "scroll",
] as const;

type PushPresence = (status: SelectablePresenceStatus) => void;

// ---------------------------------------------------------------------------
// Desktop bridge access
// ---------------------------------------------------------------------------

/**
 * The slice of `window.demli.systemIdle` this module uses, declared LOCALLY
 * and structurally.
 *
 * Why not import the preload's `SystemIdleBridge`: this same renderer tree is
 * also the web app, where `window.demli` is typed as @demli/app-ui's
 * `PlatformBridge` (which mirrors the cross-platform namespaces and has no
 * `systemIdle`). A structural local type + a runtime capability check compiles
 * on both surfaces and is honest about the fact that the namespace genuinely may
 * not be there.
 */
interface SystemIdleStateLike {
  idle: boolean;
}

interface SystemIdleBridgeLike {
  start(options: { thresholdMs: number }): Promise<SystemIdleStateLike>;
  stop(): Promise<void>;
  onChanged(listener: (state: SystemIdleStateLike) => void): () => void;
}

interface MaybeIdleWindow {
  demli?: { systemIdle?: Partial<SystemIdleBridgeLike> };
}

/** The desktop watcher, or null on web / any build without the namespace. */
function systemIdleBridge(): SystemIdleBridgeLike | null {
  if (!isDesktopSurface()) return null;
  const candidate = (window as unknown as MaybeIdleWindow).demli?.systemIdle;
  if (
    !candidate ||
    typeof candidate.start !== "function" ||
    typeof candidate.stop !== "function" ||
    typeof candidate.onChanged !== "function"
  ) {
    return null;
  }
  return candidate as SystemIdleBridgeLike;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let pushPresence: PushPresence | null = null;
/** Whether a session is currently being watched (guards late async callbacks). */
let running = false;
/**
 * Bumped on every start/stop so an in-flight `systemIdle.start()` that settles
 * after a teardown (or after a restart) cannot act on the new session.
 */
let generation = 0;
/** Undoes whichever source is currently attached. */
let detach: (() => void) | null = null;

/** Web fallback only: timestamp of the last observed DOM activity. */
let lastActivityAt = 0;

// ---------------------------------------------------------------------------
// Presence transitions (shared by both sources)
// ---------------------------------------------------------------------------

/** Cross into away (once). No-op broadcast if the pick isn't "online". */
function goAway(): void {
  const store = useSelfPresenceStore.getState();
  if (store.autoAway) return; // already away
  store.setAutoAway(true);
  // A manual dnd/invisible/idle stays authoritative and must never be
  // overwritten by the automatic idle — only an "online" pick gets augmented.
  if (getSelfPresenceStatus() !== "online") return;
  pushPresence?.(getEffectiveSelfPresenceStatus()); // -> "idle"
}

/** Come back from away (once), restoring the user's OWN choice — never a blind "online". */
function goActive(): void {
  const store = useSelfPresenceStore.getState();
  if (!store.autoAway) return; // common hot path: nothing to undo
  store.setAutoAway(false);
  // If they picked dnd/invisible/idle (possibly WHILE away), the gateway already
  // holds that status and there is nothing to restore.
  if (getSelfPresenceStatus() !== "online") return;
  pushPresence?.(getEffectiveSelfPresenceStatus()); // -> the chosen status
}

/** Apply a source's verdict. Both sources funnel through here. */
function applyIdle(idle: boolean): void {
  if (idle) goAway();
  else goActive();
}

// ---------------------------------------------------------------------------
// Source 1 — desktop: OS-wide idle, measured in the main process
// ---------------------------------------------------------------------------

function attachSystemIdleSource(bridge: SystemIdleBridgeLike): void {
  const mine = generation;
  const unsubscribe = bridge.onChanged((state) => {
    if (generation === mine) applyIdle(state.idle === true);
  });
  detach = () => {
    unsubscribe();
    void bridge.stop().catch(() => undefined);
  };

  void bridge.start({ thresholdMs: IDLE_THRESHOLD_MS }).then(
    (state) => {
      if (generation === mine) applyIdle(state.idle === true);
    },
    (err: unknown) => {
      if (generation !== mine || !running) return;
      // Never lose auto-away because the OS clock was unavailable: degrade to
      // the window-activity path (worse, but better than nothing).
      console.warn(
        "[idle-auto] system-wide idle watch unavailable; falling back to window activity:",
        err,
      );
      detach?.();
      attachWindowActivitySource();
    },
  );
}

// ---------------------------------------------------------------------------
// Source 2 — web fallback: this window's own activity
// ---------------------------------------------------------------------------

const ADD_OPTS: AddEventListenerOptions = { passive: true, capture: true };
const REMOVE_OPTS: EventListenerOptions = { capture: true };

function onActivity(): void {
  lastActivityAt = Date.now();
  goActive();
}

function checkIdle(): void {
  if (Date.now() - lastActivityAt >= IDLE_THRESHOLD_MS) goAway();
}

function attachWindowActivitySource(): void {
  lastActivityAt = Date.now();
  for (const type of ACTIVITY_EVENTS) {
    window.addEventListener(type, onActivity, ADD_OPTS);
  }
  const timer = window.setInterval(checkIdle, CHECK_INTERVAL_MS);
  detach = () => {
    for (const type of ACTIVITY_EVENTS) {
      window.removeEventListener(type, onActivity, REMOVE_OPTS);
    }
    window.clearInterval(timer);
  };
}

// ---------------------------------------------------------------------------
// Public API (UNCHANGED — realtime/connection.ts calls these two)
// ---------------------------------------------------------------------------

/**
 * Begin watching for inactivity. Idempotent (safe to call on every session
 * start). `push` broadcasts a presence status to the gateway + paints our own dot
 * WITHOUT persisting it as the chosen status.
 */
export function startIdleAutoPresence(push: PushPresence): void {
  // Tear down any previous wiring first, so a re-start never leaves two sources
  // (or two intervals) racing.
  stopIdleAutoPresence();
  pushPresence = push;
  running = true;

  const bridge = systemIdleBridge();
  if (bridge) attachSystemIdleSource(bridge);
  else attachWindowActivitySource();
}

/** Stop watching and clear any live away-state. Idempotent (safe on logout). */
export function stopIdleAutoPresence(): void {
  generation += 1;
  running = false;
  detach?.();
  detach = null;
  useSelfPresenceStore.getState().setAutoAway(false);
  pushPresence = null;
}
