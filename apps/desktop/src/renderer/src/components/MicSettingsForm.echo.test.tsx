// @vitest-environment jsdom
/**
 * Yankı Engelleme in Ayarlar → Mikrofon must not turn off on a single click: the
 * switch only opens the headphones warning, and AEC goes off solely through its
 * confirm button. Rendered for real against the real media-settings store, because
 * the guarantee is about what the user can actually do on screen.
 */
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isEchoCancellationOn } from "@demli/media";

// lucide-react resolves its own physical react copy under the hoisted layout, so a
// real icon render throws. Icons are decoration here.
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

vi.mock("../stores/voice-store", () => {
  const state = {
    status: "idle",
    setMicActive: () => undefined,
    selfMonitoring: false,
    toggleSelfMonitoring: () => undefined,
  };
  return { useVoiceStore: (select: (s: typeof state) => unknown) => select(state) };
});

import { MicSettingsForm } from "./MicSettingsForm";
import { useMediaSettings } from "../stores/media-settings";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useMediaSettings.getState().setEchoCancellation("on");
  useMediaSettings.getState().setMusicMode(false);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(createElement(MicSettingsForm)));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function echoSwitch(): HTMLButtonElement {
  const el = host.querySelector<HTMLButtonElement>(
    'button[role="switch"][aria-label="desktop:micSettings.echoCancellation"]',
  );
  expect(el).not.toBeNull();
  return el!;
}

function buttonWithText(text: string): HTMLButtonElement | null {
  return (
    [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === text,
    ) ?? null
  );
}

const click = (el: HTMLElement): void => act(() => el.click());

describe("MicSettingsForm — echo cancellation needs a headphones confirmation", () => {
  it("one click on the switch only shows the warning; AEC stays on", () => {
    click(echoSwitch());
    expect(host.textContent).toContain("desktop:micSettings.echoOffWarning");
    expect(echoSwitch().getAttribute("aria-checked")).toBe("true");
    expect(isEchoCancellationOn(useMediaSettings.getState().audio)).toBe(true);
  });

  it("cancel keeps AEC on and closes the warning", () => {
    click(echoSwitch());
    click(buttonWithText("desktop:micSettings.echoOffCancel")!);
    expect(host.textContent).not.toContain("desktop:micSettings.echoOffWarning");
    expect(isEchoCancellationOn(useMediaSettings.getState().audio)).toBe(true);
  });

  it("the confirm button turns AEC off, records headphones, and says so", () => {
    click(echoSwitch());
    click(buttonWithText("desktop:micSettings.echoOffConfirm")!);
    const audio = useMediaSettings.getState().audio;
    expect(isEchoCancellationOn(audio)).toBe(false);
    expect(audio.headphonesConfirmed).toBe(true);
    expect(echoSwitch().getAttribute("aria-checked")).toBe("false");
    expect(host.textContent).toContain("desktop:micSettings.echoOffActive");
  });

  it("switching back on is one click and clears the confirmation", () => {
    click(echoSwitch());
    click(buttonWithText("desktop:micSettings.echoOffConfirm")!);
    click(echoSwitch());
    const audio = useMediaSettings.getState().audio;
    expect(isEchoCancellationOn(audio)).toBe(true);
    expect(audio.headphonesConfirmed).toBe(false);
    expect(host.textContent).not.toContain("desktop:micSettings.echoOffActive");
  });

  it("music mode locks the switch on", () => {
    act(() => useMediaSettings.getState().setMusicMode(true));
    expect(echoSwitch().disabled).toBe(true);
    expect(echoSwitch().getAttribute("aria-checked")).toBe("true");
  });
});
