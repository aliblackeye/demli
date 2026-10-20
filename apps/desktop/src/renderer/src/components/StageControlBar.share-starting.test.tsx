// @vitest-environment jsdom
/**
 * While a screen share is being acquired the in-stage share button must be
 * disabled and say so — otherwise the picker reopens and a second share is
 * started over the first (pre-release audit, MED). VoicePanel and CallDock use
 * the same `screenShareStarting` gate from the voice store.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createI18n, createMemoryStorage, type i18n as I18n } from "@demli/i18n";
import { TooltipProvider } from "@demli/ui";
import type * as StageControlBarModule from "./StageControlBar";

vi.mock("lucide-react", async (importOriginal) => {
  const icons = await importOriginal<Record<string, unknown>>();
  const Icon = (): JSX.Element => <svg />;
  return Object.fromEntries(Object.keys(icons).map((name) => [name, Icon]));
});

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let i18n: I18n;
let Bar: typeof StageControlBarModule;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  i18n = await createI18n({ lng: "tr", storage: createMemoryStorage() });
  Bar = await import("./StageControlBar");
}, 60_000);

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(starting: boolean, onToggleScreenShare = vi.fn()): HTMLButtonElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <TooltipProvider>
          <Bar.StageControlBar
            visible
            micEnabled
            onToggleMic={() => undefined}
            cameraEnabled={false}
            onToggleCamera={() => undefined}
            canUseCamera
            screenShareEnabled={false}
            screenShareStarting={starting}
            onToggleScreenShare={onToggleScreenShare}
            canShareScreen
            screenShareDisabledHint="x"
            disconnectLabel="Ayrıl"
            onDisconnect={() => undefined}
            canFullscreen={false}
            fullscreen={false}
            onToggleFullscreen={() => undefined}
            onInteract={() => undefined}
          />
        </TooltipProvider>
      </I18nextProvider>,
    );
  });
  const startLabel = i18n.t("desktop:voice.shareStarting");
  const shareLabel = i18n.t("desktop:voice.shareScreen");
  const button = host.querySelector<HTMLButtonElement>(
    `button[aria-label="${starting ? startLabel : shareLabel}"]`,
  );
  if (!button) throw new Error("share button not found");
  return button;
}

describe("StageControlBar share button while a share is starting", () => {
  it("is disabled and reads 'starting' while the share is coming up", () => {
    const onToggle = vi.fn();
    const button = render(true, onToggle);
    expect(button.disabled).toBe(true);
    act(() => button.click());
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("is a normal share button otherwise", () => {
    const onToggle = vi.fn();
    const button = render(false, onToggle);
    expect(button.disabled).toBe(false);
    act(() => button.click());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
