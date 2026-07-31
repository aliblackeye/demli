/**
 * Unsaved-changes guard for the settings shell.
 *
 * Founder rule: "ben avatarı kaydetmediğim sürece kaydedilmemeliydi. bu herhangi
 * bir profil ayarım için geçerlidir." The other half of that rule is that a draft
 * must not be lost by accident either — so every close/navigate path out of a
 * dirty settings section has to be intercepted, not silently obeyed.
 *
 * These assert the store contract the profile panel relies on. (The renderer has
 * no DOM harness — node environment only — so this covers the guard logic itself
 * rather than the rendered prompt.)
 */

import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "./ui-store";

const store = () => useUiStore.getState();

describe("settings unsaved-changes guard", () => {
  beforeEach(() => {
    useUiStore.setState({
      settingsOpen: true,
      settingsSection: "profile",
      settingsDirty: false,
      pendingSettingsNav: null,
    });
  });

  it("closes immediately when nothing is dirty", () => {
    store().closeSettings();
    expect(store().settingsOpen).toBe(false);
    expect(store().pendingSettingsNav).toBeNull();
  });

  it("blocks the close and parks the intent while dirty", () => {
    store().setSettingsDirty(true);
    store().closeSettings();
    // Still open — the draft survives an Esc / backdrop click.
    expect(store().settingsOpen).toBe(true);
    expect(store().pendingSettingsNav).toBe("close");
  });

  it("blocks a section switch while dirty and parks the target section", () => {
    store().setSettingsDirty(true);
    store().setSettingsSection("sessions");
    expect(store().settingsSection).toBe("profile");
    expect(store().pendingSettingsNav).toBe("sessions");
  });

  it("does not block re-selecting the section already open", () => {
    store().setSettingsDirty(true);
    store().setSettingsSection("profile");
    expect(store().pendingSettingsNav).toBeNull();
  });

  it("confirm discards the draft and performs the parked close", () => {
    store().setSettingsDirty(true);
    store().closeSettings();
    store().confirmSettingsNav();
    expect(store().settingsOpen).toBe(false);
    expect(store().settingsDirty).toBe(false);
    expect(store().pendingSettingsNav).toBeNull();
  });

  it("confirm performs the parked section switch", () => {
    store().setSettingsDirty(true);
    store().setSettingsSection("voice");
    store().confirmSettingsNav();
    expect(store().settingsSection).toBe("voice");
    expect(store().settingsOpen).toBe(true);
    expect(store().settingsDirty).toBe(false);
  });

  it("cancel keeps the user editing — nothing closes, the draft stays dirty", () => {
    store().setSettingsDirty(true);
    store().closeSettings();
    store().cancelSettingsNav();
    expect(store().settingsOpen).toBe(true);
    expect(store().settingsSection).toBe("profile");
    expect(store().settingsDirty).toBe(true);
    expect(store().pendingSettingsNav).toBeNull();
  });

  it("saving (dirty → false) clears any parked prompt", () => {
    store().setSettingsDirty(true);
    store().closeSettings();
    expect(store().pendingSettingsNav).toBe("close");
    store().setSettingsDirty(false);
    expect(store().pendingSettingsNav).toBeNull();
    // …and the next close goes straight through.
    store().closeSettings();
    expect(store().settingsOpen).toBe(false);
  });

  it("confirmSettingsNav is a no-op with nothing parked", () => {
    store().confirmSettingsNav();
    expect(store().settingsOpen).toBe(true);
    expect(store().settingsSection).toBe("profile");
  });

  it("an account switch clears the departing account's draft latch", () => {
    store().setSettingsDirty(true);
    store().closeSettings();
    store().resetForAccountSwitch();
    expect(store().settingsDirty).toBe(false);
    expect(store().pendingSettingsNav).toBeNull();
    // The next account can close settings normally.
    store().closeSettings();
    expect(store().settingsOpen).toBe(false);
  });
});
