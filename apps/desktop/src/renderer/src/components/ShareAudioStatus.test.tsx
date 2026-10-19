// @vitest-environment jsdom
/**
 * The DM-call dock (CallDock) used to show NO share-sound status and NO voice
 * errors — a DM-call sharer whose stream went out silent was never told (M16
 * 1C). It now renders the same ShareAudioStatus as the voice-channel panel.
 *
 * The CallDock render below is real; only its data sources (the voice store,
 * the call FSM hook, the DM query) and its unrelated dialogs are stubbed.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { create } from "zustand";
import { I18nextProvider } from "react-i18next";
import { createI18n, createMemoryStorage, type i18n as I18n } from "@demli/i18n";
import { TooltipProvider } from "@demli/ui";
import type { ShareAudioState } from "../stores/voice-store";
import type { CallDock as CallDockComponent } from "./CallDock";

const voiceState = {
  status: "connected",
  cameraEnabled: false,
  screenShareEnabled: true,
  error: null as unknown,
  screenShareAudio: {
    status: "unavailable",
    source: null,
    notice: "unsupported_os",
    requested: true,
  } as ShareAudioState,
  shareAudioSwitching: false,
  toggleCamera: () => undefined,
  startScreenShare: () => undefined,
  stopScreenShare: () => undefined,
  sendSystemShareSound: vi.fn(),
};

// lucide-react ships its own nested React copy that escapes the test aliases
// ("Cannot read properties of null (reading 'useContext')"). Icons are not what
// this test checks, so each icon renders as an empty <svg>.
vi.mock("lucide-react", async (importOriginal) => {
  const icons = await importOriginal<Record<string, unknown>>();
  const Icon = (): JSX.Element => <svg />;
  return Object.fromEntries(Object.keys(icons).map((name) => [name, Icon]));
});
vi.mock("../stores/voice-store", () => ({
  useVoiceStore: create(() => voiceState),
}));
vi.mock("../hooks/useDmCallSurface", () => ({
  useDmCallSurface: () => ({
    state: { phase: "active", peer: { id: "u2", displayName: "Ayşe" }, seat: "here", pending: false },
    isDmCall: true,
    callDmId: "dm1",
    onCallDm: true,
    seatedHere: true,
  }),
}));
vi.mock("../lib/call-controller", () => ({ getCallController: () => null }));
vi.mock("../queries/social-queries", () => ({ useDms: () => ({ data: [] }) }));
vi.mock("./AloneCountdownNotice", () => ({ AloneCountdownNotice: () => null }));
vi.mock("./VoiceConnectionBars", () => ({ VoiceConnectionBars: () => null }));
vi.mock("./SourcePicker", () => ({ SourcePicker: () => null }));
vi.mock("./CameraPreviewDialog", () => ({ CameraPreviewDialog: () => null }));
vi.mock("./AddCallMemberDialog", () => ({ AddCallMemberDialog: () => null }));

declare global {
  // React 18 reads this to decide whether `act` is legal.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let i18n: I18n;
let CallDock: typeof CallDockComponent;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

// Loading CallDock's module graph is the slow part (several seconds on a busy
// full-workspace run), so it happens once here under its own budget.
beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  i18n = await createI18n({ lng: "tr", storage: createMemoryStorage() });
  ({ CallDock } = await import("./CallDock"));
}, 60_000);

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function renderCallDock(): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <TooltipProvider>
          <CallDock />
        </TooltipProvider>
      </I18nextProvider>,
    );
  });
  return host;
}

describe("CallDock shows the share sound like the voice panel", () => {
  it("tells a DM-call sharer that viewers hear nothing, and why", async () => {
    const el = await renderCallDock();
    const status = el.querySelector('[data-testid="share-audio-status"]');
    expect(status).not.toBeNull();
    expect(status?.textContent).toContain(i18n.t("desktop:shareAudio.statusNone"));
    expect(status?.textContent).toContain(i18n.t("desktop:shareAudio.noSoundTitle"));
    expect(status?.textContent).toContain(i18n.t("desktop:shareAudio.notice.unsupported_os"));
  });

  it("shows the live state and its source", async () => {
    voiceState.screenShareAudio = { status: "live", source: "system", notice: null, requested: true };
    const el = await renderCallDock();
    const text = el.querySelector('[data-testid="share-audio-status"]')?.textContent ?? "";
    expect(text).toContain(i18n.t("desktop:shareAudio.statusLive"));
    expect(text).toContain(i18n.t("desktop:shareAudio.source.system"));
  });

  it("shows voice errors, which the dock used to swallow", async () => {
    voiceState.error = { kind: "permission_denied", device: "microphone" };
    const el = await renderCallDock();
    expect(el.querySelector('[role="alert"]')).not.toBeNull();
    voiceState.error = null;
  });

  it("when the window's own sound cannot be isolated, offers system sound and sends it only on click", async () => {
    voiceState.screenShareAudio = { status: "unavailable", source: null, notice: "app_unavailable", requested: true };
    voiceState.sendSystemShareSound.mockClear();
    const el = await renderCallDock();
    const status = el.querySelector('[data-testid="share-audio-status"]');
    expect(status?.querySelector('[role="alert"]')?.textContent).toContain(
      i18n.t("desktop:shareAudio.notice.app_unavailable"),
    );
    expect(voiceState.sendSystemShareSound).not.toHaveBeenCalled();
    const button = status?.querySelector<HTMLButtonElement>('[data-testid="share-audio-send-system"]');
    expect(button?.textContent).toBe(i18n.t("desktop:shareAudio.sendSystemSound"));
    act(() => button?.click());
    expect(voiceState.sendSystemShareSound).toHaveBeenCalledTimes(1);
  });

  it("disables the system-sound button while the capture is starting", async () => {
    voiceState.screenShareAudio = { status: "unavailable", source: null, notice: "app_unavailable", requested: true };
    voiceState.shareAudioSwitching = true;
    const el = await renderCallDock();
    const button = el.querySelector<HTMLButtonElement>('[data-testid="share-audio-send-system"]');
    expect(button?.disabled).toBe(true);
    voiceState.shareAudioSwitching = false;
  });

  it("renders nothing about share sound while not sharing", async () => {
    voiceState.screenShareEnabled = false;
    const el = await renderCallDock();
    expect(el.querySelector('[data-testid="share-audio-status"]')).toBeNull();
    voiceState.screenShareEnabled = true;
  });
});

describe("every call surface uses the one status component", () => {
  it.each(["VoicePanel.tsx", "CallDock.tsx"])("%s renders <ShareAudioStatus /> and <VoiceErrorNotice />", (file) => {
    const source = readFileSync(join(process.cwd(), "src/renderer/src/components", file), "utf8");
    expect(source).toContain("<ShareAudioStatus");
    expect(source).toContain("<VoiceErrorNotice");
  });
});

describe("shareAudioView", () => {
  it("never claims sound before it is measured", async () => {
    const { shareAudioView } = await import("./ShareAudioStatus");
    const waiting = shareAudioView({ status: "waiting", source: "app", notice: null, requested: true });
    expect(waiting.statusKey).toBe("desktop:shareAudio.statusWaiting");
    expect(waiting.alert).toBeNull();
  });

  it("'only this app' that cannot be isolated is a warning with the system-sound offer; an echo risk is a warning", async () => {
    const { shareAudioView } = await import("./ShareAudioStatus");
    const unavailable = shareAudioView({
      status: "unavailable",
      source: null,
      notice: "app_unavailable",
      requested: true,
    });
    expect(unavailable.statusKey).toBe("desktop:shareAudio.statusNone");
    expect(unavailable.alert).toMatchObject({
      tone: "warn",
      titleKey: "desktop:shareAudio.noSoundTitle",
      bodyKey: "desktop:shareAudio.notice.app_unavailable",
      action: "sendSystemSound",
    });
    const otherReason = shareAudioView({
      status: "unavailable",
      source: null,
      notice: "capture_failed",
      requested: true,
    });
    expect(otherReason.alert?.action).toBeNull();
    const echo = shareAudioView({ status: "live", source: "browser-system", notice: "web_echo_risk", requested: true });
    expect(echo.alert).toMatchObject({ tone: "warn", titleKey: "desktop:shareAudio.echoRiskTitle" });
  });

  it("a deliberate no-sound share raises no warning", async () => {
    const { shareAudioView } = await import("./ShareAudioStatus");
    const none = shareAudioView({ status: "unavailable", source: null, notice: null, requested: false });
    expect(none.statusKey).toBe("desktop:shareAudio.statusNone");
    expect(none.alert).toBeNull();
  });

  it("a capture that died mid-share is a warning with the recovery step", async () => {
    const { shareAudioView } = await import("./ShareAudioStatus");
    const failed = shareAudioView({ status: "failed", source: "app", notice: null, requested: true });
    expect(failed.statusKey).toBe("desktop:shareAudio.statusFailed");
    expect(failed.alert?.bodyKey).toBe("desktop:shareAudio.failedHint");
  });
});
