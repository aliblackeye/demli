/**
 * Which tray image the current app state should show — the whole decision, as one
 * pure function, importing NOTHING (no electron, no node). That is deliberate:
 * `system.ts` cannot be unit-tested without an Electron runtime, so the rule that
 * actually encodes founder-visible behaviour lives here where a test can reach it.
 *
 * THE TRAY ICON IS ONE IMAGE and three signals compete for it. The priority:
 *
 *   1. BASE = voice state (default / mic muted / deafened).
 *      Voice state is something the user deliberately turned on and that STAYS on
 *      until they turn it off, and CLAUDE.md §6 puts voice first. It is also the
 *      state people get wrong ("why can't they hear me?"), which is exactly what
 *      a permanent glance-able readout is for.
 *   2. DEAFENED OVERRIDES MUTED. Not a style choice — in this product deafening
 *      forcibly disables the mic (packages/media/src/engine.ts `setDeafened`
 *      stashes `micBeforeDeafen` and sets `micEnabled: false`), so `deafened`
 *      always implies `!micEnabled`. Showing both would be showing the same fact
 *      twice, and "deafened" is the stronger, more surprising one.
 *   3. UNREAD = an overlay dot on whichever base won, never a base of its own.
 *      A notification is transient and gets cleared by reading it; it must not
 *      erase the persistent voice readout while it is up. So it composites onto
 *      all three bases (the asset table in tray-icon.ts is shaped to guarantee it).
 *
 * NO VOICE SESSION => ALWAYS THE DEFAULT BASE. `micEnabled` / `deafened` survive
 * across sessions on purpose (the engine keeps them as preferences, see
 * engine.ts's leave path), so out of a call they describe what WILL happen on the
 * next join, not anything currently true. Painting a muted-mic tray at that point
 * would claim the user is muted in a call they are not in.
 */

/** The three tray artworks, keyed into the generated table in `tray-icon.ts`. */
export type TrayIconBase = "default" | "micOff" | "deafened";

/** Everything the tray needs to know about the app, and nothing else. */
export interface TrayIconState {
  /**
   * Whether the user is in a voice surface at all — a voice channel OR a DM call
   * (both drive the same engine, so one flag covers both). False makes the mic /
   * deafen flags irrelevant, see the module note.
   */
  inVoiceSession: boolean;
  /** Mic on. Only meaningful while `inVoiceSession`. */
  micEnabled: boolean;
  /** Deafened. Only meaningful while `inVoiceSession`. Implies `!micEnabled`. */
  deafened: boolean;
  /** Any unread notification the user has not seen yet. */
  hasUnread: boolean;
}

/** The chosen artwork: which base, and whether the unread dot rides on it. */
export interface TrayIconSelection {
  base: TrayIconBase;
  unread: boolean;
}

/** The neutral state — used before the renderer has reported anything. */
export const IDLE_TRAY_STATE: TrayIconState = {
  inVoiceSession: false,
  micEnabled: true,
  deafened: false,
  hasUnread: false,
};

/** Pick the base artwork for a state (voice only — the unread dot is separate). */
export function trayIconBase(state: TrayIconState): TrayIconBase {
  if (!state.inVoiceSession) {
    return "default";
  }
  if (state.deafened) {
    return "deafened";
  }
  return state.micEnabled ? "default" : "micOff";
}

/** Pick the full tray image: base artwork + whether the unread dot rides on it. */
export function selectTrayIcon(state: TrayIconState): TrayIconSelection {
  return { base: trayIconBase(state), unread: state.hasUnread };
}

/**
 * Tray tooltip for a selection. Turkish, matching the hard-coded tray menu labels
 * ("Aç / Göster" / "Çıkış") — the main process has no i18n runtime, and wiring one
 * in just for a tooltip would pull the renderer's locale into the privileged
 * process for no user-visible gain.
 */
export function trayTooltip(selection: TrayIconSelection): string {
  const base =
    selection.base === "deafened"
      ? "Demli — sesler kapalı"
      : selection.base === "micOff"
        ? "Demli — mikrofon kapalı"
        : "Demli";
  return selection.unread ? `${base} · okunmamış bildirimler` : base;
}
