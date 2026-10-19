/**
 * Share-audio contract (M16 H1/H3). The published screen-share sound must never
 * contain Demli's own playback of the call (people hear themselves), must never
 * be the microphone, and must never be swapped behind the sharer's back.
 *
 * These tests drive the real `screen-share.ts` against stubbed browser/bridge
 * APIs (vitest runs in `node`). What they pin:
 *  - the desktop ladder only ever asks main for process capture ("app" include
 *    or "system" exclude) and never arms endpoint loopback or calls getUserMedia;
 *  - "app" that cannot be isolated sends NO sound (never everything else) and
 *    leaves "system" to the sharer's explicit choice;
 *  - an unsupported OS gets no sound and an honest notice;
 *  - the supervisor only reports (waiting / live / failed), never captures;
 *  - pre-M16 storage (the poisoned film-audio memory) is migrated away;
 *  - the web request shape and the surface → guidance mapping.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ScreenShareModule from "./screen-share";

let screenShare: typeof ScreenShareModule;

/**
 * Loaded ONCE: `screen-share.ts` holds no module state and reads every browser
 * global at call time, so the per-test stubs below apply to the one instance.
 * Re-importing per test cost seconds of transform on a loaded full-workspace
 * run and let a timed-out test keep running against the NEXT test's stubs.
 */
beforeAll(async () => {
  screenShare = await import("./screen-share");
}, 60_000);

class FakeTrack {
  stopped = false;
  readyState: "live" | "ended" = "live";
  settings: Record<string, unknown> = {};
  private listeners = new Set<() => void>();
  constructor(readonly kind: "video" | "audio" = "audio") {}
  addEventListener(type: string, l: () => void): void {
    if (type === "ended") this.listeners.add(l);
  }
  removeEventListener(_type: string, l: () => void): void {
    this.listeners.delete(l);
  }
  getSettings(): Record<string, unknown> {
    return this.settings;
  }
  stop(): void {
    this.stopped = true;
    this.readyState = "ended";
  }
}

type StartRequest = { mode: "app"; sourceId: string } | { mode: "system" };
type StartResult =
  | { ok: true; captureId: number; mode: "app" | "system"; format: object }
  | { ok: false; reason: string };

interface Harness {
  startRequests: StartRequest[];
  stopped: number[];
  selectRequests: unknown[];
  displayRequests: unknown[];
  getUserMedia: ReturnType<typeof vi.fn>;
  enumerateDevices: ReturnType<typeof vi.fn>;
  audioContexts: () => number;
  storage: Map<string, string>;
  /** Peak value the fake analyser reports (0 = silence). */
  setSignal: (peak: number) => void;
}

function install(opts: {
  platform?: string;
  support?: { supported: true } | { supported: false; reason: string };
  start?: (req: StartRequest) => StartResult;
  displayAudio?: FakeTrack[];
  videoSettings?: Record<string, unknown>;
  storage?: Record<string, string>;
  userAgentData?: boolean;
}): Harness {
  const storage = new Map(Object.entries(opts.storage ?? {}));
  let contexts = 0;
  let peak = 0;
  const startRequests: StartRequest[] = [];
  const stopped: number[] = [];
  const selectRequests: unknown[] = [];
  const displayRequests: unknown[] = [];

  vi.stubGlobal(
    "AudioContext",
    vi.fn(() => {
      contexts++;
      return {
        resume: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        createMediaStreamDestination: () => {
          const track = new FakeTrack("audio");
          return { stream: { getAudioTracks: () => [track], getTracks: () => [track] } };
        },
        createScriptProcessor: () => ({ connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null }),
        createMediaStreamSource: () => ({ connect: vi.fn() }),
        createAnalyser: () => ({
          fftSize: 2048,
          connect: vi.fn(),
          getFloatTimeDomainData: (b: Float32Array) => b.fill(peak),
        }),
      };
    }),
  );
  vi.stubGlobal("MediaStream", vi.fn(() => ({})));

  const localStorage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  };

  const demli = {
    appInfo: { platform: opts.platform ?? "win32" },
    capture: {
      listSources: vi.fn(async () => []),
      selectSource: vi.fn(async (req: { sourceId: string }) => {
        selectRequests.push(req);
        return { ok: true, sourceId: req.sourceId };
      }),
      clearSelection: vi.fn(async () => undefined),
    },
    processAudio: {
      support: vi.fn(async () => opts.support ?? { supported: true }),
      start: vi.fn(async (req: StartRequest) => {
        startRequests.push(req);
        return (
          opts.start?.(req) ?? {
            ok: true,
            captureId: startRequests.length,
            mode: req.mode,
            format: { sampleRate: 48000, channels: 2, bitDepth: 16 },
          }
        );
      }),
      stop: vi.fn(async (id: number) => void stopped.push(id)),
      onData: () => () => undefined,
      onEnded: () => () => undefined,
    },
  };
  vi.stubGlobal("window", { demli, localStorage });

  const getUserMedia = vi.fn(async () => {
    throw new Error("getUserMedia must never be called for share audio");
  });
  const enumerateDevices = vi.fn(async () => []);
  vi.stubGlobal("navigator", {
    ...(opts.userAgentData ? { userAgentData: {} } : {}),
    mediaDevices: {
      getDisplayMedia: vi.fn(async (request: unknown) => {
        displayRequests.push(request);
        const video = new FakeTrack("video");
        video.settings = opts.videoSettings ?? {};
        const audio = opts.displayAudio ?? [];
        return {
          getVideoTracks: () => [video],
          getAudioTracks: () => audio,
          getTracks: () => [video, ...audio],
        };
      }),
      getUserMedia,
      enumerateDevices,
    },
  });

  return {
    startRequests,
    stopped,
    selectRequests,
    displayRequests,
    getUserMedia,
    enumerateDevices,
    audioContexts: () => contexts,
    storage,
    setSignal: (p) => {
      peak = p;
    },
  };
}

/** Under every path: no recording device was ever opened as share sound. */
function expectNoMicrophone(h: Harness): void {
  expect(h.getUserMedia).not.toHaveBeenCalled();
  expect(h.enumerateDevices).not.toHaveBeenCalled();
}

/** Under every desktop path: the display-media request asks for video only. */
function expectNoEndpointLoopback(h: Harness): void {
  for (const req of h.selectRequests) expect(req).not.toHaveProperty("audio");
  for (const req of h.displayRequests) expect((req as { audio: unknown }).audio).toBe(false);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("desktop share-audio ladder", () => {
  it("window + 'app' captures only that window's process tree", async () => {
    const h = install({});
    const { acquireScreenShare } = screenShare;
    const acquired = await acquireScreenShare("window:123:0", { quality: "1080p30", audioMode: "app" });

    expect(h.startRequests).toEqual([{ mode: "app", sourceId: "window:123:0" }]);
    expect(acquired.audioSource).toBe("app");
    expect(acquired.audio).not.toBeNull();
    expect(acquired.audioNotice).toBeNull();
    expectNoMicrophone(h);
    expectNoEndpointLoopback(h);
  });

  it("screen + 'system' captures everything except Demli", async () => {
    const h = install({});
    const { acquireScreenShare } = screenShare;
    const acquired = await acquireScreenShare("screen:0:0", { quality: "1080p30", audioMode: "system" });

    expect(h.startRequests).toEqual([{ mode: "system" }]);
    expect(acquired.audioSource).toBe("system");
    expectNoMicrophone(h);
    expectNoEndpointLoopback(h);
  });

  it("keeps a healthy capture that has carried no bytes yet (play not pressed)", async () => {
    const h = install({});
    const { acquireScreenShare } = screenShare;
    await acquireScreenShare("window:123:0", { quality: "1080p30", audioMode: "app" });
    expect(h.stopped).toEqual([]);
  });

  it.each(["includes_demli", "pid_unresolved", "activation_failed"])(
    "'app' that cannot be isolated (%s) sends no sound — never the whole system unasked",
    async (reason) => {
      const h = install({
        start: (req) =>
          req.mode === "app"
            ? { ok: false, reason }
            : { ok: true, captureId: 9, mode: "system", format: { sampleRate: 48000, channels: 2, bitDepth: 16 } },
      });
      const { acquireScreenShare } = screenShare;
      const acquired = await acquireScreenShare("window:123:0", { quality: "1080p30", audioMode: "app" });

      expect(h.startRequests).toEqual([{ mode: "app", sourceId: "window:123:0" }]);
      expect(acquired.audio).toBeNull();
      expect(acquired.audioSource).toBeNull();
      expect(acquired.audioNotice).toBe("app_unavailable");
      expect(acquired.audioRequested).toBe(true);
      expectNoMicrophone(h);
      expectNoEndpointLoopback(h);
    },
  );

  it("system sound for a live share starts only on request, Demli excluded", async () => {
    const h = install({});
    const { captureSystemShareAudio } = screenShare;
    const capture = await captureSystemShareAudio();

    expect(h.startRequests).toEqual([{ mode: "system" }]);
    expect(capture).not.toBeNull();
    capture?.stop();
    expect(h.stopped).toEqual([1]);
    expectNoMicrophone(h);
    expectNoEndpointLoopback(h);
  });

  it("a refused on-request system capture returns null", async () => {
    const h = install({ start: () => ({ ok: false, reason: "activation_failed" }) });
    const { captureSystemShareAudio } = screenShare;
    expect(await captureSystemShareAudio()).toBeNull();
    expect(h.startRequests).toEqual([{ mode: "system" }]);
  });

  it("a refused 'system' capture shares picture only — nothing else is tried", async () => {
    const h = install({ start: () => ({ ok: false, reason: "activation_failed" }) });
    const { acquireScreenShare } = screenShare;
    const acquired = await acquireScreenShare("screen:0:0", { quality: "1080p30", audioMode: "system" });

    expect(h.startRequests).toEqual([{ mode: "system" }]);
    expect(acquired.audio).toBeNull();
    expect(acquired.audioSource).toBeNull();
    expect(acquired.audioNotice).toBe("capture_failed");
    expect(acquired.audioRequested).toBe(true);
    expectNoMicrophone(h);
    expectNoEndpointLoopback(h);
  });

  it("Windows older than 19041: no capture attempt, honest notice", async () => {
    const h = install({ support: { supported: false, reason: "unsupported_os" } });
    const { acquireScreenShare } = screenShare;
    const acquired = await acquireScreenShare("screen:0:0", { quality: "1080p30", audioMode: "system" });

    expect(h.startRequests).toEqual([]);
    expect(acquired.audio).toBeNull();
    expect(acquired.audioNotice).toBe("unsupported_os");
    expectNoMicrophone(h);
    expectNoEndpointLoopback(h);
  });

  it("'none' publishes video only and is not a failure", async () => {
    const h = install({});
    const { acquireScreenShare } = screenShare;
    const acquired = await acquireScreenShare("window:123:0", { quality: "1080p30", audioMode: "none" });

    expect(h.startRequests).toEqual([]);
    expect(acquired.audio).toBeNull();
    expect(acquired.audioNotice).toBeNull();
    expect(acquired.audioRequested).toBe(false);
    expectNoMicrophone(h);
    expectNoEndpointLoopback(h);
  });

  it("defaults: a window shares its app, a screen the system", async () => {
    install({});
    const { defaultShareAudioMode } = screenShare;
    expect(defaultShareAudioMode("window:1:0")).toBe("app");
    expect(defaultShareAudioMode("screen:0:0")).toBe("system");
  });
});

describe("pre-M16 share storage migration", () => {
  it("kills a poisoned mix-input memory and carries the old 'sound off' choice", async () => {
    const h = install({
      storage: {
        "demli:screen-share:film-audio-source": "mixinput:Voicemeeter Out B1 (VB-Audio Voicemeeter VAIO)",
        "demli:screen-share:system-audio": "false",
      },
    });
    const { loadScreenSharePrefs } = screenShare;
    const prefs = loadScreenSharePrefs();

    expect(h.storage.has("demli:screen-share:film-audio-source")).toBe(false);
    expect(h.storage.has("demli:screen-share:system-audio")).toBe(false);
    expect(prefs.audioMode).toEqual({ window: "none", screen: "none" });
  });

  it("kills a remembered endpoint loopback and starts from the new defaults", async () => {
    const h = install({
      storage: {
        "demli:screen-share:film-audio-source": "loopback",
        "demli:screen-share:system-audio": "true",
      },
    });
    const { loadScreenSharePrefs } = screenShare;
    const prefs = loadScreenSharePrefs();

    expect(h.storage.has("demli:screen-share:film-audio-source")).toBe(false);
    expect(prefs.audioMode).toEqual({ window: "app", screen: "system" });
  });

  it("never lets a screen start in 'app' mode", async () => {
    install({ storage: { "demli:screen-share:audio-mode:screen": "app" } });
    const { loadScreenSharePrefs } = screenShare;
    expect(loadScreenSharePrefs().audioMode.screen).toBe("system");
  });
});

describe("share-audio supervisor (watch-only)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("reports 'unavailable' when no share audio is published", async () => {
    install({});
    const { superviseFilmAudio } = screenShare;
    const statuses: string[] = [];
    superviseFilmAudio({ track: null, onStatus: (s) => statuses.push(s) })();
    expect(statuses).toEqual(["unavailable"]);
  });

  it("a long-silent track stays 'waiting' and nothing else is ever captured", async () => {
    const h = install({});
    const { superviseFilmAudio } = screenShare;
    const statuses: string[] = [];
    const stop = superviseFilmAudio({
      track: new FakeTrack("audio") as unknown as MediaStreamTrack,
      onStatus: (s) => statuses.push(s),
    });
    await vi.advanceTimersByTimeAsync(120_000);
    stop();

    expect(statuses).toEqual(["waiting"]);
    expect(h.audioContexts()).toBe(1);
    expectNoMicrophone(h);
  });

  it("reports 'live' once real sound is measured", async () => {
    const h = install({});
    const { superviseFilmAudio } = screenShare;
    const statuses: string[] = [];
    const stop = superviseFilmAudio({
      track: new FakeTrack("audio") as unknown as MediaStreamTrack,
      onStatus: (s) => statuses.push(s),
    });
    h.setSignal(0.2);
    await vi.advanceTimersByTimeAsync(300);
    stop();
    expect(statuses).toEqual(["waiting", "live"]);
  });

  it("reports 'failed' when the capture dies mid-share, even after it went live", async () => {
    const h = install({});
    const { superviseFilmAudio } = screenShare;
    const statuses: string[] = [];
    const track = new FakeTrack("audio");
    const stop = superviseFilmAudio({
      track: track as unknown as MediaStreamTrack,
      onStatus: (s) => statuses.push(s),
    });
    h.setSignal(0.2);
    await vi.advanceTimersByTimeAsync(300);
    track.readyState = "ended";
    await vi.advanceTimersByTimeAsync(1_100);
    stop();
    expect(statuses).toEqual(["waiting", "live", "failed"]);
  });

  it("the share sound is swapped only by the sharer's explicit action, never by the supervisor", () => {
    const store = readFileSync(
      fileURLToPath(new URL("../stores/voice-store.ts", import.meta.url)),
      "utf8",
    ).replace(/\r\n/g, "\n");
    expect(store.match(/replaceScreenShareAudio/g) ?? []).toHaveLength(1);
    const actionStart = store.indexOf("  sendSystemShareSound: () => {");
    expect(actionStart).toBeGreaterThan(-1);
    const action = store.slice(actionStart, store.indexOf("\n  },\n", actionStart));
    expect(action).toContain("engine.replaceScreenShareAudio(");
    // Only as the answer to "this window's sound could not be isolated".
    expect(action).toContain('screenShareAudio.notice !== "app_unavailable"');
    const watcherStart = store.indexOf("function watchShareAudio(");
    expect(watcherStart).toBeGreaterThan(-1);
    const watcher = store.slice(watcherStart, store.indexOf("\n}\n", watcherStart));
    expect(watcher).not.toContain("replaceScreenShareAudio");
    expect(watcher).not.toContain("captureSystemShareAudio");
  });
});

describe("web share audio", () => {
  it("asks for a tab first, keeps Demli's own tab and playback out", async () => {
    install({ platform: "web" });
    const { webDisplayMediaRequest } = screenShare;
    const req = webDisplayMediaRequest(true, "1080p30", "browser") as Record<string, unknown> & {
      video: Record<string, unknown>;
      audio: Record<string, unknown>;
    };

    expect(req.video.displaySurface).toBe("browser");
    expect(req.audio).toMatchObject({
      restrictOwnAudio: true,
      suppressLocalAudioPlayback: false,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
    expect(req.selfBrowserSurface).toBe("exclude");
    expect(req.surfaceSwitching).toBe("include");
    expect(req.systemAudio).toBe("include");
    expect(req.windowAudio).toBe("window");
  });

  it("asks for no audio at all when the sharer chose no sound", async () => {
    install({ platform: "web" });
    const { webDisplayMediaRequest } = screenShare;
    const req = webDisplayMediaRequest(false, "720p30", "monitor") as Record<string, unknown>;
    expect(req.audio).toBe(false);
    expect(req).not.toHaveProperty("systemAudio");
    expect(req).not.toHaveProperty("windowAudio");
  });

  it("maps the surface the user actually picked to honest guidance", async () => {
    install({ platform: "web" });
    const { webShareAudioOutcome } = screenShare;
    const base = { wantAudio: true, audioCapable: true, restrictOwnAudioApplied: false };

    expect(webShareAudioOutcome({ ...base, surface: "browser", hasAudio: true })).toEqual({
      source: "browser-tab",
      notice: null,
    });
    expect(webShareAudioOutcome({ ...base, surface: "browser", hasAudio: false }).notice).toBe("web_tab_unticked");
    expect(webShareAudioOutcome({ ...base, surface: "window", hasAudio: false }).notice).toBe("web_window_no_audio");
    expect(webShareAudioOutcome({ ...base, surface: "monitor", hasAudio: false }).notice).toBe("web_monitor_unticked");
    expect(webShareAudioOutcome({ ...base, surface: null, hasAudio: false }).notice).toBe("web_no_audio");
    // System sound without own-audio filtering would carry the call back.
    expect(webShareAudioOutcome({ ...base, surface: "monitor", hasAudio: true })).toEqual({
      source: "browser-system",
      notice: "web_echo_risk",
    });
    expect(
      webShareAudioOutcome({ ...base, surface: "monitor", hasAudio: true, restrictOwnAudioApplied: true }),
    ).toEqual({ source: "browser-system", notice: null });
    expect(webShareAudioOutcome({ ...base, audioCapable: false, surface: "browser", hasAudio: false }).notice).toBe(
      "web_unsupported_browser",
    );
    expect(webShareAudioOutcome({ ...base, wantAudio: false, surface: "browser", hasAudio: false })).toEqual({
      source: null,
      notice: null,
    });
  });

  it("a window share returns no sound and the window guidance; the picker hint is honoured", async () => {
    const h = install({ platform: "web", userAgentData: true, videoSettings: { displaySurface: "window" } });
    const { acquireScreenShare } = screenShare;
    const acquired = await acquireScreenShare("web:display:window", { quality: "1080p30", audioMode: "system" });

    expect((h.displayRequests[0] as { video: { displaySurface: string } }).video.displaySurface).toBe("window");
    expect(acquired.audio).toBeNull();
    expect(acquired.audioNotice).toBe("web_window_no_audio");
    expect(h.startRequests).toEqual([]);
    expectNoMicrophone(h);
  });

  it("a tab share with sound publishes the tab audio, labelled as the tab", async () => {
    const tabAudio = new FakeTrack("audio");
    const h = install({
      platform: "web",
      userAgentData: true,
      videoSettings: { displaySurface: "browser" },
      displayAudio: [tabAudio],
    });
    const { acquireScreenShare } = screenShare;
    const acquired = await acquireScreenShare("web:display:browser", { quality: "1080p30", audioMode: "system" });

    expect(acquired.audio).toBe(tabAudio);
    expect(acquired.audioSource).toBe("browser-tab");
    expect(acquired.audioNotice).toBeNull();
    expectNoMicrophone(h);
  });
});
