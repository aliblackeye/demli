/**
 * Guards the two things that must not regress about the Android audio profile
 * (task #121):
 *
 *  1. The DEFAULT stays `communication` and maps to the SDK preset UNTOUCHED —
 *     i.e. every existing install keeps byte-identical audio behaviour and the
 *     setting is genuinely opt-in.
 *  2. The `media` opt-in keeps `forceHandleAudioRouting: true`, without which
 *     LiveKit turns Android audio routing off for a non-`inCommunication`
 *     audioMode and the in-call output picker (speaker / earpiece / bluetooth)
 *     would silently become a dead button (§35).
 *
 * `@livekit/react-native` is mocked because the module imports it at load time
 * and this suite runs in the node env (no native runtime). The mock carries the
 * SDK's real preset values so the assertions are about OUR mapping, not the copy.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { communication, media } = vi.hoisted(() => ({
  communication: {
    manageAudioFocus: true,
    audioMode: "inCommunication",
    audioFocusMode: "gain",
    audioStreamType: "voiceCall",
    audioAttributesUsageType: "voiceCommunication",
    audioAttributesContentType: "speech",
  },
  media: {
    manageAudioFocus: true,
    audioMode: "normal",
    audioFocusMode: "gain",
    audioStreamType: "music",
    audioAttributesUsageType: "media",
    audioAttributesContentType: "unknown",
  },
}));

vi.mock("@livekit/react-native", () => ({
  AndroidAudioTypePresets: { communication, media },
}));

import {
  androidAudioTypeOptionsFor,
  DEFAULT_ANDROID_AUDIO_PROFILE,
  getActiveAudioProfile,
  normalizeAndroidAudioProfile,
  setActiveAudioProfile,
} from "./audio-profile";

describe("android audio profile", () => {
  beforeEach(() => {
    setActiveAudioProfile(DEFAULT_ANDROID_AUDIO_PROFILE);
  });

  it("defaults to the VoIP (communication) profile — the setting is opt-in", () => {
    expect(DEFAULT_ANDROID_AUDIO_PROFILE).toBe("communication");
    expect(getActiveAudioProfile()).toBe("communication");
  });

  it("passes the communication preset through unchanged", () => {
    expect(androidAudioTypeOptionsFor("communication")).toEqual(communication);
  });

  it("keeps audio routing alive on the media preset (output picker must work)", () => {
    const options = androidAudioTypeOptionsFor("media");
    expect(options).toEqual({ ...media, forceHandleAudioRouting: true });
    // The media stream is the whole point: media volume + no speech DSP.
    expect(options.audioStreamType).toBe("music");
    expect(options.audioAttributesUsageType).toBe("media");
  });

  it("coerces an unknown / corrupted persisted value back to the default", () => {
    expect(normalizeAndroidAudioProfile("nonsense")).toBe("communication");
    expect(normalizeAndroidAudioProfile(undefined)).toBe("communication");
    expect(normalizeAndroidAudioProfile(null)).toBe("communication");
    expect(normalizeAndroidAudioProfile(7)).toBe("communication");
    expect(normalizeAndroidAudioProfile("media")).toBe("media");
  });

  it("remembers the pushed selection for the next connect", () => {
    setActiveAudioProfile("media");
    expect(getActiveAudioProfile()).toBe("media");
    expect(androidAudioTypeOptionsFor(getActiveAudioProfile())).toEqual({
      ...media,
      forceHandleAudioRouting: true,
    });
  });
});
