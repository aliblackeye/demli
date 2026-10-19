/**
 * The desktop media-settings store against the echo policy. The founder's own
 * install had `demli.media-settings` stored with echo cancellation, auto gain and
 * noise suppression all off (version 0, no headphones confirmation): this pins that
 * exact blob being migrated ONCE to AEC on, and that a confirmed headphones off is
 * kept across restarts. A Map-backed localStorage runs the real zustand persist path.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AUDIO_SETTINGS_SCHEMA_VERSION, isEchoCancellationOn } from "@demli/media";
import type { useMediaSettings as UseMediaSettings } from "./media-settings";

const KEY = "demli.media-settings";
const backing = new Map<string, string>();

// zustand's persist reads `window.localStorage`; the desktop tests run in `node`.
vi.stubGlobal("window", {
  localStorage: {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
    clear: () => backing.clear(),
    key: (i: number) => [...backing.keys()][i] ?? null,
    get length() {
      return backing.size;
    },
  },
});

// The founder's stored blob before this change (values decoded from his leveldb).
backing.set(
  KEY,
  JSON.stringify({
    state: {
      audio: {
        inputMode: "open_mic",
        vadThreshold: 0.5,
        noiseSuppression: "off",
        processing: { echoCancellation: false, autoGainControl: false },
        musicMode: false,
        quality: "standard",
      },
      video: {},
      pttKey: "Backquote",
    },
    version: 0,
  }),
);

let useMediaSettings: typeof UseMediaSettings;

beforeAll(async () => {
  ({ useMediaSettings } = await import("./media-settings"));
});

function stored(): { state: { audio: Record<string, unknown> }; version: number } {
  return JSON.parse(backing.get(KEY)!);
}

describe("desktop media-settings — echo policy", () => {
  it("migrates the pre-policy blob on first load: AEC on, other choices kept", () => {
    const audio = useMediaSettings.getState().audio;
    expect(audio.processing).toEqual({ echoCancellation: true, autoGainControl: false });
    expect(audio.noiseSuppression).toBe("off");
    expect(audio.inputMode).toBe("open_mic");
    expect(audio.headphonesConfirmed).toBe(false);
    expect(isEchoCancellationOn(audio)).toBe(true);
    expect(stored().version).toBe(AUDIO_SETTINGS_SCHEMA_VERSION);
    expect(stored().state.audio.processing).toMatchObject({ echoCancellation: true });
  });

  it("keeps a confirmed headphones off across a restart (the migration ran once)", async () => {
    useMediaSettings.getState().setEchoCancellation("off_headphones");
    const saved = backing.get(KEY)!;
    useMediaSettings.getState().setEchoCancellation("on");
    backing.set(KEY, saved);

    await useMediaSettings.persist.rehydrate();

    const audio = useMediaSettings.getState().audio;
    expect(audio.processing.echoCancellation).toBe(false);
    expect(audio.headphonesConfirmed).toBe(true);
    expect(isEchoCancellationOn(audio)).toBe(false);
  });

  it("turning AEC back on clears the confirmation; no plain off setter exists", () => {
    useMediaSettings.getState().setEchoCancellation("on");
    expect(useMediaSettings.getState().audio.headphonesConfirmed).toBe(false);
    const state = useMediaSettings.getState() as unknown as Record<string, unknown>;
    expect(state.setProcessing).toBeUndefined();
  });
});
