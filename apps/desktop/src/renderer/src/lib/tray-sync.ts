/**
 * The renderer half of the system-tray readout: pushes "is there unread?" and
 * "what is my voice state?" across the validated `window.demli.system` bridge
 * so main can paint the tray icon (main/tray-icon-variant.ts decides WHICH icon —
 * the renderer only reports state, it never picks art).
 *
 * WHY THIS EXISTS AS A SEAM instead of two `useEffect`s calling the bridge
 * inline: every push crosses the process boundary and repaints a native tray
 * icon, and both sources tick far more often than they change. The chat store
 * fires on every incoming message and presence update; the voice store fires on
 * every speaking/connection-quality tick of a live call. Sending an identical
 * payload on each of those would be a per-tick IPC round trip for nothing
 * (CLAUDE.md §27), so the change detection lives here — one place, unit-tested,
 * with no React or Electron in the way.
 *
 * The bridge is resolved lazily on every call rather than captured once: this
 * same renderer builds for the web, where `window.demli` does not exist at
 * all, and a captured `undefined` would silently disable the tray forever if the
 * module happened to load before the preload bridge was installed.
 */

/**
 * The voice half of the payload, derived FROM the bridge so it cannot drift and
 * so the renderer never imports across the `main/` boundary (same convention as
 * `UpdateStatus` in lib/update-status.ts).
 */
export type TrayVoiceStatus = Parameters<
  Window["demli"]["system"]["setVoiceStatus"]
>[0];

/** The two bridge calls this module needs — injectable so tests can spy. */
export interface TraySyncTarget {
  setUnreadBadge(hasUnread: boolean): Promise<void>;
  setVoiceStatus(status: TrayVoiceStatus): Promise<void>;
}

export interface TraySync {
  /** Report unread. Sends only when the value actually changed. */
  pushUnread(hasUnread: boolean): void;
  /** Report own voice state. Sends only when a field actually changed. */
  pushVoice(status: TrayVoiceStatus): void;
  /**
   * Return the tray to neutral (no dot, no voice glyph) and forget what was last
   * sent. For sign-out and unmount: the tray outlives the signed-in session, so
   * without this a logged-out app keeps advertising the last user's unread dot.
   * Pushes unconditionally — the point is to overwrite whatever main is showing.
   */
  reset(): void;
}

/** Neutral tray state. Mirrors `IDLE_TRAY_STATE` in main/tray-icon-variant.ts. */
const NEUTRAL_VOICE: TrayVoiceStatus = {
  inVoiceSession: false,
  micEnabled: true,
  deafened: false,
};

function sameVoice(a: TrayVoiceStatus, b: TrayVoiceStatus): boolean {
  return (
    a.inVoiceSession === b.inVoiceSession &&
    a.micEnabled === b.micEnabled &&
    a.deafened === b.deafened
  );
}

/**
 * Build a tray sync over a lazily-resolved bridge.
 *
 * @param resolveTarget Returns the bridge, or null/undefined where there is none
 *   (web build). Called per push, never cached.
 */
export function createTraySync(
  resolveTarget: () => TraySyncTarget | null | undefined,
): TraySync {
  // `undefined` = nothing sent yet, which is NOT the same as "sent false": on a
  // fresh mount main may still be showing a previous session's tray, so the
  // first push always goes out even when it equals the neutral value.
  let lastUnread: boolean | undefined;
  let lastVoice: TrayVoiceStatus | undefined;

  // A rejected bridge call must never surface as an unhandled rejection: the tray
  // is decoration, and main throws on a payload it refuses. Swallow and move on —
  // the next real change re-sends, because the memo below is only updated after
  // the call was issued.
  const send = (call: (target: TraySyncTarget) => Promise<void>): boolean => {
    const target = resolveTarget();
    if (!target) {
      return false;
    }
    void call(target).catch(() => undefined);
    return true;
  };

  return {
    pushUnread(hasUnread: boolean): void {
      if (lastUnread === hasUnread) {
        return;
      }
      if (send((t) => t.setUnreadBadge(hasUnread))) {
        lastUnread = hasUnread;
      }
    },

    pushVoice(status: TrayVoiceStatus): void {
      if (lastVoice && sameVoice(lastVoice, status)) {
        return;
      }
      // Copied, not stored by reference: the caller may be handing us a live
      // store slice, and a mutated object would make the next comparison lie.
      const next: TrayVoiceStatus = {
        inVoiceSession: status.inVoiceSession,
        micEnabled: status.micEnabled,
        deafened: status.deafened,
      };
      if (send((t) => t.setVoiceStatus(next))) {
        lastVoice = next;
      }
    },

    reset(): void {
      lastUnread = undefined;
      lastVoice = undefined;
      send((t) => t.setUnreadBadge(false));
      send((t) => t.setVoiceStatus({ ...NEUTRAL_VOICE }));
    },
  };
}

/**
 * The app-wide tray sync. One instance: the tray is one icon, so two syncs would
 * fight over it and each would think it already sent the current value.
 */
export const traySync = createTraySync(() => window.demli?.system);
