// @vitest-environment jsdom
/**
 * When this machine cannot capture share sound (macOS, Windows < 19041, missing
 * helper) the picker says so — and must then start the share WITHOUT sound.
 * Asking for sound anyway made the share carry a false amber "viewers hear
 * nothing" warning on top of the notice the sharer had just read (audit, LOW).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createI18n, createMemoryStorage, type i18n as I18n } from "@demli/i18n";
import { TooltipProvider } from "@demli/ui";
import type * as SourcePickerModule from "./SourcePicker";
import type { ShareAudioCapability } from "../lib/screen-share";

vi.mock("lucide-react", async (importOriginal) => {
  const icons = await importOriginal<Record<string, unknown>>();
  const Icon = (): JSX.Element => <svg />;
  return Object.fromEntries(Object.keys(icons).map((name) => [name, Icon]));
});

// Radix Dialog's scroll lock (react-remove-scroll) resolves its own nested React
// copy under vitest; the dialog shell is not what this test checks.
vi.mock("@demli/ui", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const Pass = ({ children }: { children?: unknown }): JSX.Element => <div>{children as never}</div>;
  return {
    ...actual,
    Dialog: ({ open, children }: { open: boolean; children?: unknown }) =>
      open ? <div>{children as never}</div> : null,
    DialogContent: Pass,
    DialogBody: Pass,
    DialogHeader: Pass,
    DialogFooter: Pass,
    DialogTitle: Pass,
    DialogDescription: Pass,
  };
});

let capability: ShareAudioCapability = { supported: false, notice: "unsupported_platform" };

vi.mock("../lib/screen-share", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/screen-share")>();
  return {
    ...actual,
    isScreenCaptureAvailable: () => true,
    isWebPlatform: () => false,
    isWebDisplayAudioCapable: () => false,
    getShareAudioCapability: async () => capability,
    listScreenSources: async () => [
      { id: "screen:0:0", name: "Ekran 1", kind: "screen", thumbnailDataUrl: "" },
    ],
    // A screen remembers "system sound" — the default a sharer would carry over.
    loadScreenSharePrefs: () => ({
      quality: "1080p30",
      audioMode: { window: "app", screen: "system" },
    }),
    saveScreenSharePrefs: () => undefined,
  };
});

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let i18n: I18n;
let Picker: typeof SourcePickerModule;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  i18n = await createI18n({ lng: "tr", storage: createMemoryStorage() });
  Picker = await import("./SourcePicker");
}, 60_000);

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function pickAndStart(): Promise<ReturnType<typeof vi.fn>> {
  const onSelect = vi.fn();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <TooltipProvider>
          <Picker.SourcePicker open onOpenChange={() => undefined} onSelect={onSelect} />
        </TooltipProvider>
      </I18nextProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const card = document.querySelector<HTMLButtonElement>('[data-testid="source-card"]');
  if (!card) throw new Error("source card not rendered");
  await act(async () => card.click());
  const start = document.querySelector<HTMLButtonElement>('[data-testid="source-start"]');
  if (!start) throw new Error("start button not rendered");
  await act(async () => start.click());
  return onSelect;
}

describe("SourcePicker on a machine without share-sound capture", () => {
  it("starts the share with no sound when capture is unsupported", async () => {
    capability = { supported: false, notice: "unsupported_platform" };
    const onSelect = await pickAndStart();
    expect(onSelect).toHaveBeenCalledWith("screen:0:0", expect.objectContaining({ audioMode: "none" }));
  });

  it("keeps the remembered sound choice where capture works", async () => {
    capability = { supported: true };
    const onSelect = await pickAndStart();
    expect(onSelect).toHaveBeenCalledWith("screen:0:0", expect.objectContaining({ audioMode: "system" }));
  });
});
