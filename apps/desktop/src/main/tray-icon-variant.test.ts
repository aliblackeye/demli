/**
 * The tray-icon selection rule. This is founder-visible behaviour ("mikrofon
 * susturulduğunda susturulmuş mikrofon ikonu... sağır kulaklık simgesi... kırmızı
 * bi nokta") and it lives in a pure function precisely so it can be pinned here
 * without an Electron runtime.
 */
import { describe, expect, it } from "vitest";
import { TRAY_ICONS } from "./tray-icon";
import {
  IDLE_TRAY_STATE,
  selectTrayIcon,
  trayIconBase,
  trayTooltip,
  type TrayIconBase,
  type TrayIconState,
} from "./tray-icon-variant";

const state = (overrides: Partial<TrayIconState> = {}): TrayIconState => ({
  ...IDLE_TRAY_STATE,
  ...overrides,
});

/** In a call, mic on, nothing unread — the baseline the other cases deviate from. */
const inCall = state({ inVoiceSession: true, micEnabled: true });

describe("trayIconBase — voice state picks the artwork", () => {
  it("shows the brand mark while in a call with the mic live", () => {
    expect(trayIconBase(inCall)).toBe("default");
  });

  it("shows the muted-mic glyph when the mic is off", () => {
    expect(trayIconBase({ ...inCall, micEnabled: false })).toBe("micOff");
  });

  it("shows the deafened glyph when deafened", () => {
    expect(trayIconBase({ ...inCall, micEnabled: false, deafened: true })).toBe(
      "deafened",
    );
  });

  it("lets deafened OVERRIDE muted rather than showing both", () => {
    // The engine forces micEnabled=false when deafening (packages/media
    // setDeafened stashes micBeforeDeafen), so this is the state that actually
    // reaches us — and it must resolve to exactly one icon, the stronger one.
    const deafened = trayIconBase({
      ...inCall,
      micEnabled: false,
      deafened: true,
    });
    const merelyMuted = trayIconBase({ ...inCall, micEnabled: false });
    expect(deafened).toBe("deafened");
    expect(deafened).not.toBe(merelyMuted);
  });

  it("still prefers deafened if a mic-on state somehow arrives with it", () => {
    // Defensive: the pair should be impossible, but a tray that renders "mic is
    // fine" for a deafened user would be actively misleading.
    expect(trayIconBase({ ...inCall, micEnabled: true, deafened: true })).toBe(
      "deafened",
    );
  });
});

describe("trayIconBase — no voice session means no voice glyph", () => {
  it("shows the brand mark when idle, even though mic/deafen preferences persist", () => {
    // The engine keeps micEnabled/deafened across sessions as preferences for the
    // next join. Painting a muted tray here would claim the user is muted in a
    // call they are not in.
    expect(
      trayIconBase(state({ inVoiceSession: false, micEnabled: false })),
    ).toBe("default");
    expect(
      trayIconBase(
        state({ inVoiceSession: false, micEnabled: false, deafened: true }),
      ),
    ).toBe("default");
  });

  it("shows the brand mark for the neutral startup state", () => {
    expect(trayIconBase(IDLE_TRAY_STATE)).toBe("default");
  });
});

describe("selectTrayIcon — the unread dot layers onto every base", () => {
  const bases: Array<[string, TrayIconState]> = [
    ["default", inCall],
    ["micOff", { ...inCall, micEnabled: false }],
    ["deafened", { ...inCall, micEnabled: false, deafened: true }],
  ];

  it.each(bases)("carries unread=true on the %s base", (expected, base) => {
    const selection = selectTrayIcon({ ...base, hasUnread: true });
    expect(selection.base).toBe(expected);
    expect(selection.unread).toBe(true);
  });

  it.each(bases)("carries unread=false on the %s base", (expected, base) => {
    const selection = selectTrayIcon({ ...base, hasUnread: false });
    expect(selection.base).toBe(expected);
    expect(selection.unread).toBe(false);
  });

  it("does not let unread change which base is chosen", () => {
    for (const [, base] of bases) {
      expect(selectTrayIcon({ ...base, hasUnread: true }).base).toBe(
        selectTrayIcon({ ...base, hasUnread: false }).base,
      );
    }
  });

  it("shows the dot on the plain mark when unread arrives outside a call", () => {
    expect(selectTrayIcon(state({ hasUnread: true }))).toEqual({
      base: "default",
      unread: true,
    });
  });
});

describe("the generated asset table backs every selection", () => {
  // The type system already forces a key per base, but not that the PAYLOAD is
  // there: a half-finished `pnpm gen:icons` could emit an empty string and the
  // tray would silently go blank. These assert the bytes exist.
  const bases: TrayIconBase[] = ["default", "micOff", "deafened"];

  it.each(bases)("has both sizes, normal and unread, for %s", (base) => {
    for (const state of ["normal", "unread"] as const) {
      const asset = TRAY_ICONS[base][state];
      for (const png of [asset.png16, asset.png32]) {
        expect(png.length).toBeGreaterThan(100);
        // base64-encoded PNG signature: \x89PNG -> "iVBORw0KGgo".
        expect(png.startsWith("iVBORw0KGgo")).toBe(true);
      }
    }
  });

  it.each(bases)("gives %s a DIFFERENT image with the unread dot", (base) => {
    // Guards the composite step: if withUnreadDot silently no-opped, the tray
    // would keep the same icon and the founder's red dot would never appear.
    expect(TRAY_ICONS[base].unread.png32).not.toBe(TRAY_ICONS[base].normal.png32);
    expect(TRAY_ICONS[base].unread.png16).not.toBe(TRAY_ICONS[base].normal.png16);
  });

  it("gives every base distinct artwork", () => {
    const marks = bases.map((base) => TRAY_ICONS[base].normal.png32);
    expect(new Set(marks).size).toBe(bases.length);
  });

  it("draws 16px on its own grid rather than reusing the 32px bytes", () => {
    for (const base of bases) {
      expect(TRAY_ICONS[base].normal.png16).not.toBe(
        TRAY_ICONS[base].normal.png32,
      );
    }
  });

  it("resolves an asset for every reachable selection", () => {
    for (const inVoiceSession of [true, false]) {
      for (const micEnabled of [true, false]) {
        for (const deafened of [true, false]) {
          for (const hasUnread of [true, false]) {
            const selection = selectTrayIcon({
              inVoiceSession,
              micEnabled,
              deafened,
              hasUnread,
            });
            const asset =
              TRAY_ICONS[selection.base][selection.unread ? "unread" : "normal"];
            expect(asset.png16.length).toBeGreaterThan(100);
            expect(asset.png32.length).toBeGreaterThan(100);
          }
        }
      }
    }
  });
});

describe("trayTooltip", () => {
  it("names the voice state and appends unread", () => {
    expect(trayTooltip({ base: "default", unread: false })).toBe("Demli");
    expect(trayTooltip({ base: "micOff", unread: false })).toBe(
      "Demli — mikrofon kapalı",
    );
    expect(trayTooltip({ base: "deafened", unread: false })).toBe(
      "Demli — sesler kapalı",
    );
    expect(trayTooltip({ base: "deafened", unread: true })).toBe(
      "Demli — sesler kapalı · okunmamış bildirimler",
    );
    expect(trayTooltip({ base: "default", unread: true })).toBe(
      "Demli · okunmamış bildirimler",
    );
  });
});
