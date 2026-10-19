/**
 * The mobile media-settings store against the echo policy: a blob persisted before
 * the policy is migrated ONCE (echo cancellation back on, version bumped and written
 * back), and AEC can only be turned off through the confirmed-headphones setter.
 *
 * expo-secure-store is backed by an in-memory map so the real zustand persist
 * middleware runs its real hydrate → migrate → merge → write path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const backing = vi.hoisted(() => new Map<string, string>());

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => backing.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    backing.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    backing.delete(key);
  }),
}));

vi.mock("@livekit/react-native", () => ({
  AndroidAudioTypePresets: { communication: {}, media: {} },
}));

import { AUDIO_SETTINGS_SCHEMA_VERSION, isEchoCancellationOn } from "@demli/media";
import { useMediaSettings } from "../media-settings";

const KEY = "demli.media-settings";

function stored(): { state: { audio: Record<string, unknown> }; version: number } {
  return JSON.parse(backing.get(KEY)!);
}

describe("mobile media-settings — echo policy", () => {
  beforeEach(() => {
    backing.clear();
  });

  it("migrates a pre-policy blob once: AEC back on, version written back", async () => {
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
        },
        version: 0,
      }),
    );

    await useMediaSettings.persist.rehydrate();

    const audio = useMediaSettings.getState().audio;
    expect(audio.processing.echoCancellation).toBe(true);
    expect(audio.processing.autoGainControl).toBe(false);
    expect(audio.inputMode).toBe("open_mic");
    expect(isEchoCancellationOn(audio)).toBe(true);
    expect(stored().version).toBe(AUDIO_SETTINGS_SCHEMA_VERSION);
    expect(stored().state.audio.processing).toMatchObject({ echoCancellation: true });
  });

  it("a confirmed headphones off survives a restart at the current version", async () => {
    useMediaSettings.getState().setEchoCancellation("off_headphones");
    await vi.waitFor(() => expect(backing.has(KEY)).toBe(true));
    const before = backing.get(KEY)!;
    expect(JSON.parse(before).version).toBe(AUDIO_SETTINGS_SCHEMA_VERSION);

    useMediaSettings.getState().setEchoCancellation("on");
    backing.set(KEY, before);
    await useMediaSettings.persist.rehydrate();

    const audio = useMediaSettings.getState().audio;
    expect(audio.processing.echoCancellation).toBe(false);
    expect(audio.headphonesConfirmed).toBe(true);
    expect(isEchoCancellationOn(audio)).toBe(false);
  });

  it("turning AEC back on clears the confirmation", () => {
    useMediaSettings.getState().setEchoCancellation("off_headphones");
    useMediaSettings.getState().setEchoCancellation("on");
    const audio = useMediaSettings.getState().audio;
    expect(audio.processing.echoCancellation).toBe(true);
    expect(audio.headphonesConfirmed).toBe(false);
  });

  it("exposes no setter that turns AEC off without the confirmation", () => {
    const state = useMediaSettings.getState() as unknown as Record<string, unknown>;
    expect(state.setProcessing).toBeUndefined();
  });

  it("moves a Medya profile picked before the headphones confirmation back to Görüşme", async () => {
    backing.set(
      KEY,
      JSON.stringify({ state: { audioProfile: "media" }, version: 1 }),
    );

    await useMediaSettings.persist.rehydrate();

    expect(useMediaSettings.getState().audioProfile).toBe("communication");
    expect(JSON.parse(backing.get(KEY)!).state.audioProfile).toBe("communication");
  });

  it("keeps a Medya profile confirmed at the current version", async () => {
    useMediaSettings.getState().setAudioProfile("media_headphones");
    await vi.waitFor(() =>
      expect(JSON.parse(backing.get(KEY) ?? "{}").state?.audioProfile).toBe("media"),
    );
    const saved = backing.get(KEY)!;
    useMediaSettings.getState().setAudioProfile("communication");
    backing.set(KEY, saved);

    await useMediaSettings.persist.rehydrate();

    expect(useMediaSettings.getState().audioProfile).toBe("media");
  });

  it("reaches the Medya profile only through the headphones choice", () => {
    useMediaSettings.getState().setAudioProfile("communication");
    expect(useMediaSettings.getState().audioProfile).toBe("communication");
    useMediaSettings.getState().setAudioProfile("media_headphones");
    expect(useMediaSettings.getState().audioProfile).toBe("media");
  });
});
