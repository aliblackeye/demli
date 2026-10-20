// @vitest-environment jsdom
/**
 * The settings layer must never drop an unsaved section draft on a nav click.
 *
 * Store-driven sections were always parked behind the dirty guard (ui-store
 * `setSettingsSection`), but the LOCAL sections (Mikrofon, Sesler, Dil, …) were
 * switched with plain component state — clicking one unmounted the profile
 * form, whose unmount cleanup cleared the dirty latch, and the draft was gone
 * without a prompt. This mounts the REAL SettingsShell and the REAL ui-store;
 * only the section bodies are stubs (the profile stub declares a draft the way
 * ProfileSettings does and offers the prompt's two answers).
 */
import { createElement, useEffect } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// lucide-react resolves its own physical react copy under the hoisted layout, so
// a real icon render throws. Icons are decoration here.
vi.mock("lucide-react", () => {
  const Icon = (): JSX.Element => createElement("svg");
  const real = (name: string | symbol): boolean =>
    typeof name === "string" && name !== "then" && name !== "__esModule";
  return new Proxy({ __esModule: true } as Record<string | symbol, unknown>, {
    get: (target, name) => (real(name) ? Icon : target[name]),
    has: (target, name) => real(name) || name in target,
  });
});

vi.mock("../lib/i18n", () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../hooks/useMediaQuery", () => ({ useIsMobileViewport: () => false }));
vi.mock("../lib/account-manager", () => ({ logoutActiveAccount: async () => undefined }));
vi.mock("../notifications/visible-conversation", () => ({ useOverlayCovering: () => undefined }));

// `react-remove-scroll` ships CJS whose `require("react")` escapes the vitest
// React aliases and reaches a second physical React (the hoisted layout), so
// Radix's modal would render with a null hook dispatcher. Same stand-in as
// packages/app-ui/src/test/react-remove-scroll-stub.tsx: jsdom has no scroll,
// and the focus/dismiss behaviour under test comes from the other Radix parts.
vi.mock("react-remove-scroll", async () => {
  const { forwardRef, Fragment, createElement: h } = await import("react");
  const RemoveScroll = Object.assign(
    forwardRef<HTMLElement, { children?: unknown }>(function RemoveScrollStub({ children }) {
      return h(Fragment, null, children as never);
    }),
    { classNames: { fullWidth: "", zeroRight: "" } },
  );
  return { RemoveScroll, default: RemoveScroll };
});

// Section bodies are stubs: each mock factory builds a marker <div>. Factories
// are hoisted, so this helper is hoisted with them.
const { section } = vi.hoisted(() => ({
  section: (name: string) => async () => {
    const { createElement: h } = await import("react");
    return () => h("div", { "data-stub": name });
  },
}));
vi.mock("./BlockedUsersSettings", async () => ({ BlockedUsersSettings: await section("blocked")() }));
vi.mock("./DeviceSettingsForm", async () => ({ DeviceSettingsForm: await section("voice")() }));
vi.mock("./IgnoredUsersSettings", async () => ({ IgnoredUsersSettings: await section("ignored")() }));
vi.mock("./NicknamesSettings", async () => ({ NicknamesSettings: await section("nicknames")() }));
vi.mock("./SessionsSettings", async () => ({ SessionsSettings: await section("sessions")() }));
vi.mock("./LanguageSettings", async () => ({ LanguageSettings: await section("language")() }));
vi.mock("./MicSettingsForm", async () => ({ MicSettingsForm: await section("microphone")() }));
vi.mock("./NotificationSettings", async () => ({ NotificationSettings: await section("notifications")() }));
vi.mock("./SoundSettings", async () => ({ SoundSettings: await section("sounds")() }));
vi.mock("./SystemSettings", async () => ({ SystemSettings: await section("system")() }));
vi.mock("./VideoSettingsForm", async () => ({ VideoSettingsForm: await section("video")() }));
vi.mock("./UpdateSettings", async () => ({ UpdateSettings: await section("updates")() }));

vi.mock("./ProfileSettings", async () => {
  const { useUiStore } = await import("../stores/ui-store");
  function ProfileSettings(): JSX.Element {
    const pending = useUiStore((s) => s.pendingSettingsNav);
    useEffect(() => {
      useUiStore.getState().setSettingsDirty(true);
      return () => useUiStore.getState().setSettingsDirty(false);
    }, []);
    return createElement(
      "div",
      { "data-stub": "profile" },
      pending !== null &&
        createElement(
          "span",
          null,
          createElement("button", { onClick: () => useUiStore.getState().confirmSettingsNav() }, "discard"),
          createElement("button", { onClick: () => useUiStore.getState().cancelSettingsNav() }, "keep"),
        ),
    );
  }
  return { ProfileSettings };
});

import { SettingsShell } from "./SettingsShell";
import { useUiStore } from "../stores/ui-store";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const shown = (): string[] =>
  [...document.querySelectorAll<HTMLElement>("[data-stub]")].map((el) => el.dataset.stub ?? "");
const navButton = (id: string): HTMLButtonElement => {
  const el = [...document.querySelectorAll<HTMLButtonElement>("[data-settings-nav]")].find(
    (b) => b.textContent === `desktop:settings.nav.${id}`,
  );
  expect(el).toBeDefined();
  return el!;
};
const button = (text: string): HTMLButtonElement => {
  const el = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text);
  expect(el).toBeDefined();
  return el!;
};
const click = (el: HTMLElement): void => act(() => el.click());

beforeEach(() => {
  useUiStore.setState({
    settingsOpen: true,
    settingsSection: "profile",
    settingsDirty: false,
    pendingSettingsNav: null,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(createElement(SettingsShell)));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useUiStore.setState({ settingsOpen: false, settingsDirty: false, pendingSettingsNav: null });
});

describe("SettingsShell — an unsaved draft survives every nav click", () => {
  it("a LOCAL section switch is parked behind the prompt, the draft stays mounted", () => {
    expect(useUiStore.getState().settingsDirty).toBe(true);
    click(navButton("language"));
    expect(useUiStore.getState().pendingSettingsNav).not.toBeNull();
    expect(shown()).toContain("profile");
    expect(shown()).not.toContain("language");
  });

  it("discarding finishes the parked switch", () => {
    click(navButton("language"));
    click(button("discard"));
    expect(shown()).toContain("language");
    expect(shown()).not.toContain("profile");
    expect(useUiStore.getState().pendingSettingsNav).toBeNull();
  });

  it("keep editing drops the parked switch for good", () => {
    click(navButton("microphone"));
    click(button("keep"));
    expect(shown()).toContain("profile");
    // A later save (draft no longer dirty) must not replay the abandoned switch.
    act(() => useUiStore.getState().setSettingsDirty(false));
    expect(shown()).toContain("profile");
    expect(shown()).not.toContain("microphone");
  });

  it("a STORE section switch is parked too (unchanged guard)", () => {
    click(navButton("sessions"));
    expect(useUiStore.getState().pendingSettingsNav).toBe("sessions");
    expect(shown()).toContain("profile");
  });

  it("with no draft, a local section opens at once", () => {
    act(() => useUiStore.getState().setSettingsDirty(false));
    click(navButton("sounds"));
    expect(shown()).toContain("sounds");
  });
});
