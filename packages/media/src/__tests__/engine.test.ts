/**
 * Voice engine FSM tests against a fake livekit Room (no SDK, no network).
 * Covers the CLAUDE.md §11 transition table: join/leave, reconnect paths,
 * error paths, command guards, participants, and speaking efficiency.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AcquireScreenShare,
  AudioCaptureOptionsLike,
  AudioSettings,
  AudioTrackProcessorLike,
  ConnectionQualityLevel,
  ConnectionQualityProbe,
  LocalAudioMeter,
  LocalParticipantLike,
  LocalTrackPublicationLike,
  MicMonitor,
  MicMonitorConfig,
  MicPublishOptionsLike,
  RemoteCamera,
  RemoteParticipantLike,
  RemoteScreenShare,
  RemoteTrackLike,
  RemoteTrackPublicationLike,
  RoomEventName,
  RoomListener,
  ScreenShareAssets,
  SeededRemoteVideoTrack,
  TrackPublishOptionsLike,
  VideoCaptureOptionsLike,
  VideoPublishOptionsLike,
  VideoSettings,
  VoiceEngine,
  VoiceRoomAdapter,
  VoiceState,
} from "../index.js";
import {
  ALONE_GRACE_MS,
  BANDWIDTH_SOURCE_WATCH_PARTY,
  CAMERA_LOW_SIMULCAST_LAYER,
  constrainedCameraPublishOptions,
  DEFAULT_AUDIO_SETTINGS,
  DEFAULT_VIDEO_SETTINGS,
  PRESSURE_CAMERA_MAX_BITRATE_BPS,
} from "../index.js";
import {
  connectionQualityLevelFromLiveKit,
  CONNECTION_QUALITY_POLL_MS,
  createVoiceEngine,
  DISCONNECT_REASON,
  InvalidVoiceCommandError,
  PARTICIPANT_ATTR,
  ROOM_EVENT,
  TRACK_SOURCE,
  VoiceOperationError,
} from "../index.js";

/** Let queued microtask notifications flush. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Minimal MediaStreamTrack stand-in (Node has no DOM) — supports ended + stop. */
class FakeMediaStreamTrack {
  stopped = false;
  /** Live by default; set to "ended" to simulate a dead loopback capture. */
  readyState: "live" | "ended" = "live";
  private endedListeners = new Set<() => void>();
  constructor(readonly kind: "video" | "audio" = "video") {}
  addEventListener(type: string, listener: () => void): void {
    if (type === "ended") this.endedListeners.add(listener);
  }
  removeEventListener(type: string, listener: () => void): void {
    if (type === "ended") this.endedListeners.delete(listener);
  }
  stop(): void {
    this.stopped = true;
  }
  /** Simulate the OS ending the capture (Stop-sharing overlay / window closed). */
  endFromOs(): void {
    for (const listener of this.endedListeners) listener();
  }
}

function makeAssets(withAudio: boolean): ScreenShareAssets {
  return {
    video: new FakeMediaStreamTrack("video") as unknown as MediaStreamTrack,
    audio: withAudio
      ? (new FakeMediaStreamTrack("audio") as unknown as MediaStreamTrack)
      : null,
  };
}

/** An acquire() callback that resolves to fixed assets. */
function acquireFixed(assets: ScreenShareAssets): AcquireScreenShare {
  return async () => assets;
}

/** A subscribed remote screen-share video track stand-in. */
class FakeRemoteTrack implements RemoteTrackLike {
  attach = vi.fn((el: HTMLMediaElement) => el);
  detach = vi.fn((el: HTMLMediaElement) => el);
  constructor(
    readonly kind: string,
    readonly mediaStreamTrack: MediaStreamTrack,
  ) {}
}

class FakeLocalParticipant implements LocalParticipantLike {
  identity = "local-user";
  isMicrophoneEnabled = false;
  isScreenShareEnabled = false;
  isCameraEnabled = false;
  published: TrackPublishOptionsLike[] = [];
  setMicrophoneEnabled = vi.fn(
    async (
      enabled: boolean,
      _captureOptions?: AudioCaptureOptionsLike,
      _publishOptions?: MicPublishOptionsLike,
    ) => {
      this.isMicrophoneEnabled = enabled;
    },
  );
  /** Camera enable/disable (task #18) — livekit acquires+publishes internally. */
  setCameraEnabled = vi.fn(
    async (
      enabled: boolean,
      _captureOptions?: VideoCaptureOptionsLike,
      _publishOptions?: VideoPublishOptionsLike,
    ): Promise<LocalTrackPublicationLike | undefined> => {
      this.isCameraEnabled = enabled;
      return enabled ? { source: TRACK_SOURCE.Camera } : undefined;
    },
  );
  publishTrack = vi.fn(
    async (
      _track: MediaStreamTrack,
      options: TrackPublishOptionsLike,
    ): Promise<LocalTrackPublicationLike> => {
      this.published.push(options);
      if (options.source === TRACK_SOURCE.ScreenShare) this.isScreenShareEnabled = true;
      return { source: options.source };
    },
  );
  unpublishTrack = vi.fn(
    async (
      _track: MediaStreamTrack,
      _stopOnUnpublish?: boolean,
    ): Promise<LocalTrackPublicationLike | undefined> => {
      this.isScreenShareEnabled = false;
      return undefined;
    },
  );
  /** Make the next setMicrophoneEnabled call fail with a DOMException-like error. */
  failNextMicWith(name: string): void {
    this.setMicrophoneEnabled.mockImplementationOnce(async () => {
      const err = new Error(name);
      err.name = name;
      throw err;
    });
  }
  /** Make the next publishTrack call reject (publish failure path). */
  failNextPublishWith(message: string): void {
    this.publishTrack.mockImplementationOnce(async () => {
      throw new Error(message);
    });
  }
  /** Make the next setCameraEnabled call fail with a DOMException-like error. */
  failNextCameraWith(name: string): void {
    this.setCameraEnabled.mockImplementationOnce(async () => {
      const err = new Error(name);
      err.name = name;
      throw err;
    });
  }
}

class FakeRemoteParticipant implements RemoteParticipantLike {
  isMicrophoneEnabled = true;
  isScreenShareEnabled = false;
  isCameraEnabled = false;
  /** Per-source playout volume: `volume` is the VOICE (mic) level (default source). */
  volume = 1;
  /** The SEPARATE per-share (screen_share_audio / film) level. */
  screenShareVolume = 1;
  /** Broadcast attributes (deafen flag lives here — PARTICIPANT_ATTR.deafened). */
  attributes: Record<string, string> = {};
  constructor(readonly identity: string) {}
  setVolume(volume: number, source: "microphone" | "screen_share_audio" = "microphone"): void {
    if (source === "screen_share_audio") this.screenShareVolume = volume;
    else this.volume = volume;
  }
}

class FakeRoom implements VoiceRoomAdapter {
  localParticipant = new FakeLocalParticipant();
  remoteParticipants = new Map<string, FakeRemoteParticipant>();
  connect = vi.fn(async (_url: string, _token: string) => {});
  disconnect = vi.fn(async () => {});
  switchActiveDevice = vi.fn(async (_kind: string, _deviceId: string) => {});
  /** Live mic-capture re-apply (audio-settings change) — optional adapter surface. */
  restartAudioTrack = vi.fn(async (_captureOptions: AudioCaptureOptionsLike) => {});
  /**
   * In-place DSP retune (`applyConstraints`) — the ZERO-interruption capture path.
   * Defaults to succeeding; a test can `mockResolvedValue(false)` to exercise the
   * re-acquire fallback.
   */
  applyMicCaptureConstraints = vi.fn(async (_captureOptions: AudioCaptureOptionsLike) => true);
  /** Full mic RE-PUBLISH (bitrate/codec change) — optional adapter surface. */
  republishMicTrack = vi.fn(
    async (
      _captureOptions: AudioCaptureOptionsLike | undefined,
      _publishOptions: MicPublishOptionsLike | undefined,
    ) => {},
  );
  /** Attach/detach the RNNoise worklet (Yüksek NS tier) — optional adapter surface. */
  applyNoiseFilter = vi.fn(async (_processor: AudioTrackProcessorLike | null) => {});
  /** Deafen: mute all remote audio playout (RN path) — optional adapter surface. */
  setRemoteAudioMuted = vi.fn((_muted: boolean) => {});
  /** Per-share (film) volume → native playout (RN path) — optional adapter surface. */
  setRemoteScreenShareVolume = vi.fn((_identity: string, _volume: number) => {});
  /** Remote camera preferred layer (focus → high) — optional adapter surface. */
  setRemoteCameraQuality = vi.fn((_identity: string, _quality: "high" | "auto") => {});
  /** Remote camera subscription toggle (hidden → unsubscribe) — optional adapter surface. */
  setRemoteCameraSubscribed = vi.fn((_identity: string, _subscribed: boolean) => {});
  /** Late-joiner AUDIO seed (force-subscribe pre-existing film/voice audio) — optional. */
  ensureRemoteAudioSubscribed = vi.fn(() => {});
  /** Publish a LOCAL attribute (deafen broadcast) — optional adapter surface. */
  setLocalAttribute = vi.fn(async (key: string, value: string) => {
    if (value === "") delete this.localAttributes[key];
    else this.localAttributes[key] = value;
  });
  /** The local participant's published attributes (what setLocalAttribute merged). */
  localAttributes: Record<string, string> = {};

  private handlers = new Map<string, Set<RoomListener>>();

  on(event: RoomEventName, listener: RoomListener): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)?.add(listener);
  }
  off(event: RoomEventName, listener: RoomListener): void {
    this.handlers.get(event)?.delete(listener);
  }
  emit(event: RoomEventName, ...args: unknown[]): void {
    for (const listener of this.handlers.get(event) ?? []) {
      (listener as (...a: unknown[]) => void)(...args);
    }
  }
  listenerCount(): number {
    let count = 0;
    for (const set of this.handlers.values()) count += set.size;
    return count;
  }
  addRemote(identity: string): FakeRemoteParticipant {
    const p = new FakeRemoteParticipant(identity);
    this.remoteParticipants.set(identity, p);
    this.emit(ROOM_EVENT.ParticipantConnected, p);
    return p;
  }
  removeRemote(identity: string): void {
    const p = this.remoteParticipants.get(identity);
    this.remoteParticipants.delete(identity);
    if (p) this.emit(ROOM_EVENT.ParticipantDisconnected, p);
  }
  /**
   * Simulate a remote (un)deafening: merge the attribute change onto that remote's
   * `attributes` and fire `ParticipantAttributesChanged` (as livekit does). Adds the
   * remote first if absent so a seed-at-connect scenario can preset attributes.
   */
  setRemoteAttribute(identity: string, key: string, value: string): FakeRemoteParticipant {
    const p = this.remoteParticipants.get(identity) ?? this.addRemote(identity);
    if (value === "") delete p.attributes[key];
    else p.attributes[key] = value;
    this.emit(ROOM_EVENT.ParticipantAttributesChanged, { [key]: value }, p);
    return p;
  }
  /** Simulate a remote participant's screen-share VIDEO track being subscribed. */
  subscribeScreenShare(identity: string): FakeRemoteTrack {
    const p = this.remoteParticipants.get(identity) ?? this.addRemote(identity);
    p.isScreenShareEnabled = true;
    const track = new FakeRemoteTrack(
      "video",
      new FakeMediaStreamTrack("video") as unknown as MediaStreamTrack,
    );
    this.emit(ROOM_EVENT.TrackSubscribed, track, { source: TRACK_SOURCE.ScreenShare }, p);
    return track;
  }
  /** Simulate that screen-share track being unsubscribed. */
  unsubscribeScreenShare(identity: string, track: FakeRemoteTrack): void {
    const p = this.remoteParticipants.get(identity);
    if (p) p.isScreenShareEnabled = false;
    this.emit(ROOM_EVENT.TrackUnsubscribed, track, { source: TRACK_SOURCE.ScreenShare }, p);
  }
  /** Simulate a remote participant's CAMERA video track being subscribed (task #18). */
  subscribeCamera(identity: string): FakeRemoteTrack {
    const p = this.remoteParticipants.get(identity) ?? this.addRemote(identity);
    p.isCameraEnabled = true;
    const track = new FakeRemoteTrack(
      "video",
      new FakeMediaStreamTrack("video") as unknown as MediaStreamTrack,
    );
    this.emit(ROOM_EVENT.TrackSubscribed, track, { source: TRACK_SOURCE.Camera }, p);
    return track;
  }
  /** Simulate that camera track being unsubscribed. */
  unsubscribeCamera(identity: string, track: FakeRemoteTrack): void {
    const p = this.remoteParticipants.get(identity);
    if (p) p.isCameraEnabled = false;
    this.emit(ROOM_EVENT.TrackUnsubscribed, track, { source: TRACK_SOURCE.Camera }, p);
  }
  /**
   * Simulate a remote CAMERA being turned off. livekit MUTES (does not unpublish)
   * a camera that is disabled, so only TrackMuted fires — never TrackUnsubscribed.
   */
  muteCamera(identity: string): void {
    const p = this.remoteParticipants.get(identity);
    if (p) p.isCameraEnabled = false;
    this.emit(
      ROOM_EVENT.TrackMuted,
      { source: TRACK_SOURCE.Camera, isMuted: true },
      p,
    );
  }
  /** Simulate that remote camera being turned back on, delivering the resumed track. */
  unmuteCamera(identity: string, track: FakeRemoteTrack): void {
    const p = this.remoteParticipants.get(identity);
    if (p) p.isCameraEnabled = true;
    this.emit(
      ROOM_EVENT.TrackUnmuted,
      { source: TRACK_SOURCE.Camera, isMuted: false, track },
      p,
    );
  }
  /** Simulate a remote joining with the camera published-but-MUTED (off at join). */
  subscribeCameraMuted(identity: string): FakeRemoteTrack {
    const p = this.remoteParticipants.get(identity) ?? this.addRemote(identity);
    const track = new FakeRemoteTrack(
      "video",
      new FakeMediaStreamTrack("video") as unknown as MediaStreamTrack,
    );
    this.emit(
      ROOM_EVENT.TrackSubscribed,
      track,
      { source: TRACK_SOURCE.Camera, isMuted: true },
      p,
    );
    return track;
  }

  private readonly seededVideo: SeededRemoteVideoTrack[] = [];
  seedRemoteVideoTracks(): SeededRemoteVideoTrack[] {
    return this.seededVideo;
  }
  /** A remote already screen-sharing before we joined (only reachable via the seed). */
  preexistingScreenShare(identity: string): FakeRemoteTrack {
    const p = this.remoteParticipants.get(identity) ?? this.addRemote(identity);
    p.isScreenShareEnabled = true;
    const track = new FakeRemoteTrack("video", new FakeMediaStreamTrack("video") as unknown as MediaStreamTrack);
    this.seededVideo.push({ track, publication: { source: TRACK_SOURCE.ScreenShare } as RemoteTrackPublicationLike, participant: p as unknown as RemoteParticipantLike });
    return track;
  }
  /** A remote already on-camera before we joined (only reachable via the seed). */
  preexistingCamera(identity: string): FakeRemoteTrack {
    const p = this.remoteParticipants.get(identity) ?? this.addRemote(identity);
    p.isCameraEnabled = true;
    const track = new FakeRemoteTrack("video", new FakeMediaStreamTrack("video") as unknown as MediaStreamTrack);
    this.seededVideo.push({ track, publication: { source: TRACK_SOURCE.Camera } as RemoteTrackPublicationLike, participant: p as unknown as RemoteParticipantLike });
    return track;
  }
  /** A remote whose camera is published-but-OFF at join (seed must mute-gate it out). */
  preexistingCameraMuted(identity: string): FakeRemoteTrack {
    const p = this.remoteParticipants.get(identity) ?? this.addRemote(identity);
    const track = new FakeRemoteTrack("video", new FakeMediaStreamTrack("video") as unknown as MediaStreamTrack);
    this.seededVideo.push({ track, publication: { source: TRACK_SOURCE.Camera, isMuted: true } as RemoteTrackPublicationLike, participant: p as unknown as RemoteParticipantLike });
    return track;
  }
}

function setup(overrides?: {
  fetchToken?: (channelId: string) => Promise<{ url: string; token: string }>;
  room?: FakeRoom;
  audioBitrateKbps?: number;
  createNoiseFilter?: () => AudioTrackProcessorLike;
  createMicMonitor?: () => MicMonitor;
  /** Fake clock for the alone-idle deadline (real time would take 3 minutes). */
  now?: () => number;
}) {
  const room = overrides?.room ?? new FakeRoom();
  const fetchToken =
    overrides?.fetchToken ??
    vi.fn(async (_channelId: string) => ({ url: "ws://test:7880", token: "jwt" }));
  const engine = createVoiceEngine({
    fetchToken,
    createRoom: () => room,
    ...(overrides?.audioBitrateKbps !== undefined
      ? { audioBitrateKbps: overrides.audioBitrateKbps }
      : {}),
    ...(overrides?.createNoiseFilter ? { createNoiseFilter: overrides.createNoiseFilter } : {}),
    ...(overrides?.createMicMonitor ? { createMicMonitor: overrides.createMicMonitor } : {}),
    ...(overrides?.now ? { now: overrides.now } : {}),
  });
  return { engine, room, fetchToken };
}

/**
 * A recording {@link MicMonitor} stand-in for the "Kendini dinle" tests. Captures
 * every config it is started with so a test can assert WHICH chain the monitor was
 * pointed at (capture constraints + whether the noise-filter factory was handed
 * over) — the property that makes the feature honest rather than a raw-mic lie.
 */
function makeFakeMicMonitor(): {
  monitor: MicMonitor;
  starts: MicMonitorConfig[];
  stops: () => number;
  running: () => boolean;
} {
  const starts: MicMonitorConfig[] = [];
  let stopCount = 0;
  let live = false;
  const monitor: MicMonitor = {
    async start(config) {
      starts.push(config);
      live = true;
    },
    async stop() {
      stopCount += 1;
      live = false;
    },
  };
  return { monitor, starts, stops: () => stopCount, running: () => live };
}

/** A stub RNNoise-style audio processor for the "Yüksek" NS-tier seam tests. */
function makeFakeNoiseFilter(): AudioTrackProcessorLike {
  return {
    name: "fake-rnnoise",
    init: async () => {},
    restart: async () => {},
    destroy: async () => {},
  };
}

describe("join lifecycle", () => {
  it("walks idle → joining → connected and fetches a token for the channel", async () => {
    const { engine, room, fetchToken } = setup();
    const statuses: string[] = [];
    engine.subscribe((s: VoiceState) => statuses.push(s.status));

    const joined = engine.join("channel-1");
    expect(engine.getState().status).toBe("joining"); // set synchronously
    await joined;

    expect(fetchToken).toHaveBeenCalledWith("channel-1");
    expect(room.connect).toHaveBeenCalledWith("ws://test:7880", "jwt");
    expect(engine.getState().status).toBe("connected");
    expect(engine.getState().roomId).toBe("channel-1");
    expect(engine.getState().error).toBeNull();
    await flush();
    expect(statuses).toContain("joining");
    expect(statuses.at(-1)).toBe("connected");
  });

  it("enables the mic on join per preference and lists the local participant", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
    expect(engine.getState().micEnabled).toBe(true);
    expect(engine.getState().participants).toEqual([
      expect.objectContaining({ identity: "local-user", isLocal: true, micEnabled: true }),
    ]);
  });

  it("fails to error(server_unavailable) when the token fetch fails", async () => {
    const { engine } = setup({
      fetchToken: async () => {
        throw new Error("api down");
      },
    });
    await expect(engine.join("channel-1")).rejects.toBeInstanceOf(VoiceOperationError);
    expect(engine.getState().status).toBe("error");
    expect(engine.getState().error).toEqual({ kind: "server_unavailable" });
  });

  it("fails to error(server_unavailable) and releases the room when connect fails", async () => {
    const room = new FakeRoom();
    room.connect.mockRejectedValueOnce(new Error("no route"));
    const { engine } = setup({ room });
    await expect(engine.join("channel-1")).rejects.toBeInstanceOf(VoiceOperationError);
    expect(engine.getState().status).toBe("error");
    expect(engine.getState().error).toEqual({ kind: "server_unavailable" });
    expect(room.listenerCount()).toBe(0); // no leaked listeners
  });

  it("stays connected listen-only with a typed error when mic permission is denied", async () => {
    const room = new FakeRoom();
    room.localParticipant.failNextMicWith("NotAllowedError");
    const { engine } = setup({ room });
    await engine.join("channel-1");
    expect(engine.getState().status).toBe("connected");
    expect(engine.getState().micEnabled).toBe(false);
    expect(engine.getState().error).toEqual({
      kind: "permission_denied",
      device: "microphone",
    });
  });

  it("maps a missing microphone to device_not_found", async () => {
    const room = new FakeRoom();
    room.localParticipant.failNextMicWith("NotFoundError");
    const { engine } = setup({ room });
    await engine.join("channel-1");
    expect(engine.getState().status).toBe("connected");
    expect(engine.getState().error).toEqual({ kind: "device_not_found" });
  });

  it("allows retrying join from the error state", async () => {
    const room = new FakeRoom();
    room.connect.mockRejectedValueOnce(new Error("first try fails"));
    const { engine } = setup({ room });
    await expect(engine.join("channel-1")).rejects.toBeInstanceOf(VoiceOperationError);
    expect(engine.getState().status).toBe("error");
    await engine.join("channel-1");
    expect(engine.getState().status).toBe("connected");
    expect(engine.getState().error).toBeNull();
  });
});

describe("command guards", () => {
  it("rejects JOIN while joining, connected, or reconnecting", async () => {
    const { engine, room } = setup();
    let release = () => {};
    room.connect.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const joining = engine.join("channel-1");
    await expect(engine.join("channel-2")).rejects.toBeInstanceOf(
      InvalidVoiceCommandError,
    );
    release();
    await joining;
    await expect(engine.join("channel-2")).rejects.toBeInstanceOf(
      InvalidVoiceCommandError,
    );
    room.emit(ROOM_EVENT.Reconnecting);
    await expect(engine.join("channel-2")).rejects.toBeInstanceOf(
      InvalidVoiceCommandError,
    );
  });

  it("rejects LEAVE while idle", async () => {
    const { engine } = setup();
    await expect(engine.leave()).rejects.toBeInstanceOf(InvalidVoiceCommandError);
  });

  it("rejects START_SCREEN_SHARE while idle (only legal when connected)", async () => {
    const { engine } = setup();
    await expect(
      engine.startScreenShare(acquireFixed(makeAssets(false))),
    ).rejects.toBeInstanceOf(InvalidVoiceCommandError);
    expect(engine.getState().screenShareEnabled).toBe(false);
  });

  it("rejects SET_CAMERA while idle (only legal when connected)", async () => {
    const { engine } = setup();
    await expect(engine.setCamera(true)).rejects.toBeInstanceOf(InvalidVoiceCommandError);
    expect(engine.getState().cameraEnabled).toBe(false);
  });
});

describe("screen share lifecycle", () => {
  it("publishes video + system audio and flips screenShareEnabled/hasAudio", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.startScreenShare(acquireFixed(makeAssets(true)));

    expect(engine.getState().screenShareEnabled).toBe(true);
    expect(engine.getState().screenShareHasAudio).toBe(true);
    expect(room.localParticipant.published.map((o) => o.source)).toEqual([
      TRACK_SOURCE.ScreenShare,
      TRACK_SOURCE.ScreenShareAudio,
    ]);
    // local participant row reflects the badge
    expect(engine.getState().participants[0]?.screenSharing).toBe(true);
  });

  it("publishes the film audio on the SAME participant as the video, video first (A/V sync)", async () => {
    const assets = makeAssets(true);
    const audio = assets.audio as unknown as FakeMediaStreamTrack;
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.startScreenShare(acquireFixed(assets));

    // Both tracks are published from the one local participant, video then audio —
    // co-located on a single PeerConnection, which is what lets the viewer keep
    // them RTP-synced (no drift). Publishing the film audio at all is what makes it
    // reach viewers (they auto-subscribe + auto-play the ScreenShareAudio track).
    const [first, second] = room.localParticipant.published;
    expect(first?.source).toBe(TRACK_SOURCE.ScreenShare);
    expect(second?.source).toBe(TRACK_SOURCE.ScreenShareAudio);
    // The exact acquired audio track (the film's sound) is the one that goes out,
    // carrying the MUSIC profile (#113): stereo, 256 kbps, DTX off. Without these
    // livekit's voice defaults (~48 kbps mono + DTX) would collapse the film's
    // stereo mix and gate its quiet passages for every listener.
    expect(room.localParticipant.publishTrack).toHaveBeenNthCalledWith(2, audio, {
      source: TRACK_SOURCE.ScreenShareAudio,
      audioPreset: { maxBitrate: 256_000 },
      red: true,
      dtx: false,
      forceStereo: true,
    });
    expect(engine.getState().screenShareHasAudio).toBe(true);
  });

  // -------------------------------------------------------------------------
  // FILM-AUDIO HONESTY + HOT-SWAP (the "yayın sesi gitmiyor" root cause)
  //
  // A film-audio source can only be armed at share START, but users start the
  // share and THEN press play — so at t=0 nothing is audible and no source can
  // be validated. These tests pin the contract that makes that flow work:
  // publishing does NOT claim audibility, and the source can be corrected while
  // the share runs.
  // -------------------------------------------------------------------------

  it("does NOT claim the film audio is audible just because a track was published", async () => {
    const { engine } = setup();
    await engine.join("channel-1");
    await engine.startScreenShare(acquireFixed(makeAssets(true)));

    // A track exists...
    expect(engine.getState().screenShareHasAudio).toBe(true);
    // ...but nothing has been HEARD yet. The UI must render "waiting for sound",
    // never "sharing with system audio". Claiming success here is exactly what
    // made a permanently-silent Voicemeeter loopback look like a healthy share.
    expect(engine.getState().screenShareAudioLive).toBe(false);
  });

  it("marks film audio live only once the supervisor reports real signal", async () => {
    const { engine } = setup();
    await engine.join("channel-1");
    await engine.startScreenShare(acquireFixed(makeAssets(true)));

    engine.setScreenShareAudioLive(true);
    expect(engine.getState().screenShareAudioLive).toBe(true);
  });

  it("refuses to mark film audio live when NO film audio is published", async () => {
    const { engine } = setup();
    await engine.join("channel-1");
    await engine.startScreenShare(acquireFixed(makeAssets(false)));

    // A late/buggy verdict must never claim viewers can hear a film that was
    // never published (§35 — the UI may not lie).
    engine.setScreenShareAudioLive(true);
    expect(engine.getState().screenShareAudioLive).toBe(false);
  });

  it("hot-swaps the film audio mid-share, keeping the MUSIC profile and never touching the video", async () => {
    const assets = makeAssets(true);
    const original = assets.audio as unknown as FakeMediaStreamTrack;
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.startScreenShare(acquireFixed(assets));
    room.localParticipant.publishTrack.mockClear();
    room.localParticipant.unpublishTrack.mockClear();

    const better = new FakeMediaStreamTrack("audio");
    const swapped = await engine.replaceScreenShareAudio(
      better as unknown as MediaStreamTrack,
    );

    expect(swapped).toBe(true);
    // The silent source is unpublished and released...
    expect(room.localParticipant.unpublishTrack).toHaveBeenCalledWith(original, true);
    expect(original.stopped).toBe(true);
    // ...and the replacement goes out with the SAME music profile — a swapped-in
    // film track must never fall back to livekit's voice defaults (#113).
    expect(room.localParticipant.publishTrack).toHaveBeenCalledWith(better, {
      source: TRACK_SOURCE.ScreenShareAudio,
      audioPreset: { maxBitrate: 256_000 },
      red: true,
      dtx: false,
      forceStereo: true,
    });
    // The VIDEO was never re-published — the picture must not blink on a swap.
    expect(room.localParticipant.publishTrack).toHaveBeenCalledTimes(1);
    expect(engine.getState().screenShareHasAudio).toBe(true);
    // A brand-new source is unproven until the supervisor confirms it.
    expect(engine.getState().screenShareAudioLive).toBe(false);
  });

  it("a swap resets the audible verdict so a new source must prove itself", async () => {
    const { engine } = setup();
    await engine.join("channel-1");
    await engine.startScreenShare(acquireFixed(makeAssets(true)));
    engine.setScreenShareAudioLive(true);
    expect(engine.getState().screenShareAudioLive).toBe(true);

    await engine.replaceScreenShareAudio(
      new FakeMediaStreamTrack("audio") as unknown as MediaStreamTrack,
    );
    expect(engine.getState().screenShareAudioLive).toBe(false);
  });

  it("never publishes an ENDED track on a swap (dead source → keeps the current one)", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.startScreenShare(acquireFixed(makeAssets(true)));
    room.localParticipant.publishTrack.mockClear();

    const dead = new FakeMediaStreamTrack("audio");
    dead.readyState = "ended";
    const swapped = await engine.replaceScreenShareAudio(
      dead as unknown as MediaStreamTrack,
    );

    expect(swapped).toBe(false);
    expect(dead.stopped).toBe(true);
    expect(room.localParticipant.publishTrack).not.toHaveBeenCalled();
    // The existing (live) source stays published rather than being torn out for
    // a corpse.
    expect(engine.getState().screenShareHasAudio).toBe(true);
  });

  it("a supervisor firing AFTER the share stopped cannot resurrect film audio", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.startScreenShare(acquireFixed(makeAssets(true)));
    await engine.stopScreenShare();
    room.localParticipant.publishTrack.mockClear();

    const late = new FakeMediaStreamTrack("audio");
    const swapped = await engine.replaceScreenShareAudio(
      late as unknown as MediaStreamTrack,
    );

    expect(swapped).toBe(false);
    expect(room.localParticipant.publishTrack).not.toHaveBeenCalled();
    // The orphan track is released, not leaked.
    expect(late.stopped).toBe(true);
    expect(engine.getState().screenShareEnabled).toBe(false);
    expect(engine.getState().screenShareHasAudio).toBe(false);
  });

  it("a stop that lands DURING a swap wins: the new track is never published", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.startScreenShare(acquireFixed(makeAssets(true)));
    room.localParticipant.publishTrack.mockClear();

    let releaseUnpublish: () => void = () => undefined;
    room.localParticipant.unpublishTrack.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => (releaseUnpublish = () => resolve(undefined))),
    );
    const next = new FakeMediaStreamTrack("audio");
    const swap = engine.replaceScreenShareAudio(next as unknown as MediaStreamTrack);
    await engine.stopScreenShare();
    releaseUnpublish();

    expect(await swap).toBe(false);
    expect(room.localParticipant.publishTrack).not.toHaveBeenCalled();
    expect(next.stopped).toBe(true);
    expect(engine.getState().screenShareHasAudio).toBe(false);
  });

  it("dropping to video-only mid-share unpublishes the film audio honestly", async () => {
    const assets = makeAssets(true);
    const original = assets.audio as unknown as FakeMediaStreamTrack;
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.startScreenShare(acquireFixed(assets));
    engine.setScreenShareAudioLive(true);

    const swapped = await engine.replaceScreenShareAudio(null);

    expect(swapped).toBe(true);
    expect(room.localParticipant.unpublishTrack).toHaveBeenCalledWith(original, true);
    expect(engine.getState().screenShareHasAudio).toBe(false);
    expect(engine.getState().screenShareAudioLive).toBe(false);
  });

  it("exposes the published film-audio track so the supervisor watches the REAL one", async () => {
    const assets = makeAssets(true);
    const { engine } = setup();
    await engine.join("channel-1");
    await engine.startScreenShare(acquireFixed(assets));

    expect(engine.getLocalScreenShareAudioTrack()).toBe(assets.audio);
    await engine.stopScreenShare();
    expect(engine.getLocalScreenShareAudioTrack()).toBeNull();
  });

  it("clears the audible verdict when the share stops", async () => {
    const { engine } = setup();
    await engine.join("channel-1");
    await engine.startScreenShare(acquireFixed(makeAssets(true)));
    engine.setScreenShareAudioLive(true);

    await engine.stopScreenShare();
    expect(engine.getState().screenShareAudioLive).toBe(false);
  });

  it("shares video-only when no system-audio track was captured", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.startScreenShare(acquireFixed(makeAssets(false)));

    expect(engine.getState().screenShareEnabled).toBe(true);
    expect(engine.getState().screenShareHasAudio).toBe(false);
    expect(room.localParticipant.published.map((o) => o.source)).toEqual([
      TRACK_SOURCE.ScreenShare,
    ]);
  });

  it("never publishes an already-ENDED film-audio track (dead loopback → video-only, no false hasAudio)", async () => {
    // A loopback capture that arrived dead (readyState "ended") must NOT be published
    // as ScreenShareAudio — that would stream SILENCE to viewers while hasAudio lied
    // true. The engine drops it, stops it, and shares video-only honestly.
    const assets = makeAssets(true);
    const deadAudio = assets.audio as unknown as FakeMediaStreamTrack;
    deadAudio.readyState = "ended";
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.startScreenShare(acquireFixed(assets));

    expect(engine.getState().screenShareEnabled).toBe(true);
    expect(engine.getState().screenShareHasAudio).toBe(false);
    expect(room.localParticipant.published.map((o) => o.source)).toEqual([
      TRACK_SOURCE.ScreenShare,
    ]);
    // The dead track is released, not leaked into the room.
    expect(deadAudio.stopped).toBe(true);
  });

  it("stops cleanly: unpublishes both tracks and clears the flags", async () => {
    const assets = makeAssets(true);
    const video = assets.video as unknown as FakeMediaStreamTrack;
    const audio = assets.audio as unknown as FakeMediaStreamTrack;
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.startScreenShare(acquireFixed(assets));
    await engine.stopScreenShare();

    expect(engine.getState().screenShareEnabled).toBe(false);
    expect(engine.getState().screenShareHasAudio).toBe(false);
    expect(room.localParticipant.unpublishTrack).toHaveBeenCalledTimes(2);
    expect(video.stopped).toBe(true);
    expect(audio.stopped).toBe(true);
    expect(engine.getState().participants[0]?.screenSharing).toBe(false);
  });

  it("maps a denied screen capture to permission_denied(screen)", async () => {
    const { engine } = setup();
    await engine.join("channel-1");
    const acquire: AcquireScreenShare = async () => {
      const err = new Error("denied");
      err.name = "NotAllowedError";
      throw err;
    };
    await expect(engine.startScreenShare(acquire)).rejects.toBeInstanceOf(
      VoiceOperationError,
    );
    expect(engine.getState().screenShareEnabled).toBe(false);
    expect(engine.getState().error).toEqual({
      kind: "permission_denied",
      device: "screen",
    });
  });

  it("surfaces device_unavailable and stops tracks when the publish fails", async () => {
    const assets = makeAssets(true);
    const video = assets.video as unknown as FakeMediaStreamTrack;
    const audio = assets.audio as unknown as FakeMediaStreamTrack;
    const { engine, room } = setup();
    await engine.join("channel-1");
    room.localParticipant.failNextPublishWith("publish boom");
    await expect(engine.startScreenShare(acquireFixed(assets))).rejects.toBeInstanceOf(
      VoiceOperationError,
    );
    expect(engine.getState().screenShareEnabled).toBe(false);
    expect(engine.getState().error).toEqual({
      kind: "device_unavailable",
      deviceId: "screen",
    });
    expect(video.stopped).toBe(true);
    expect(audio.stopped).toBe(true);
  });

  it("keeps sharing video-only when only the system-audio publish fails", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    // First publish (video) succeeds; second (audio) fails.
    room.localParticipant.publishTrack.mockImplementationOnce(
      async (_t: MediaStreamTrack, o: TrackPublishOptionsLike) => {
        room.localParticipant.isScreenShareEnabled = true;
        return { source: o.source };
      },
    );
    room.localParticipant.failNextPublishWith("audio boom");
    await engine.startScreenShare(acquireFixed(makeAssets(true)));
    expect(engine.getState().screenShareEnabled).toBe(true);
    expect(engine.getState().screenShareHasAudio).toBe(false);
    expect(engine.getState().error).toBeNull();
  });

  it("handles an OS-initiated track end: clean no-share + typed source-closed error", async () => {
    const assets = makeAssets(false);
    const video = assets.video as unknown as FakeMediaStreamTrack;
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.startScreenShare(acquireFixed(assets));

    video.endFromOs(); // user hit the OS "Stop sharing" overlay
    await flush();

    expect(engine.getState().screenShareEnabled).toBe(false);
    expect(engine.getState().screenShareHasAudio).toBe(false);
    expect(engine.getState().error).toEqual({
      kind: "track_ended_unexpectedly",
      track: "screen",
    });
    expect(engine.getState().status).toBe("connected"); // stays in the room
    expect(room.localParticipant.unpublishTrack).toHaveBeenCalled();
  });

  it("is idempotent: starting while already sharing does nothing", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.startScreenShare(acquireFixed(makeAssets(false)));
    const before = room.localParticipant.published.length;
    await engine.startScreenShare(acquireFixed(makeAssets(false)));
    expect(room.localParticipant.published.length).toBe(before);
  });

  it("tears the local screen share down on leave", async () => {
    const assets = makeAssets(true);
    const video = assets.video as unknown as FakeMediaStreamTrack;
    const { engine } = setup();
    await engine.join("channel-1");
    await engine.startScreenShare(acquireFixed(assets));
    await engine.leave();
    expect(engine.getState().screenShareEnabled).toBe(false);
    expect(video.stopped).toBe(true);
  });

  it("stops a live share cleanly even while RECONNECTING (guardless, never throws)", async () => {
    const assets = makeAssets(true);
    const video = assets.video as unknown as FakeMediaStreamTrack;
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.startScreenShare(acquireFixed(assets));
    expect(engine.getState().screenShareEnabled).toBe(true);

    // Network blip → reconnecting; the user hits Stop. The old connected-only
    // guard threw here and the flag stuck true — now it must stop cleanly.
    room.emit(ROOM_EVENT.Reconnecting);
    expect(engine.getState().status).toBe("reconnecting");
    await expect(engine.stopScreenShare()).resolves.toBeUndefined();
    expect(engine.getState().screenShareEnabled).toBe(false);
    expect(engine.getState().screenShareHasAudio).toBe(false);
    expect(video.stopped).toBe(true);
    expect(room.localParticipant.unpublishTrack).toHaveBeenCalled();
  });

  it("is a safe idempotent no-op when there is no share", async () => {
    const { engine } = setup();
    await engine.join("channel-1");
    await expect(engine.stopScreenShare()).resolves.toBeUndefined();
    expect(engine.getState().screenShareEnabled).toBe(false);
    await expect(engine.stopScreenShare()).resolves.toBeUndefined(); // twice, still fine
  });

  it("stop cancels an in-flight start (epoch bump) — no resurrected share", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    const assets = makeAssets(true);
    const video = assets.video as unknown as FakeMediaStreamTrack;
    let releaseAcquire!: (a: ScreenShareAssets) => void;
    const acquire: AcquireScreenShare = () =>
      new Promise<ScreenShareAssets>((resolve) => {
        releaseAcquire = resolve;
      });
    const starting = engine.startScreenShare(acquire); // in flight, waiting on the picker

    // Stop before the picker resolves — bumps the epoch so the start aborts.
    await engine.stopScreenShare();
    expect(engine.getState().screenShareEnabled).toBe(false);

    releaseAcquire(assets); // picker finally resolves
    await starting;
    // The start saw the epoch mismatch: it stopped the acquired tracks and never
    // published, so the torn-down share is NOT resurrected.
    expect(engine.getState().screenShareEnabled).toBe(false);
    expect(video.stopped).toBe(true);
    expect(room.localParticipant.published.length).toBe(0);
  });

  it("does not clear an unrelated error when stopping with nothing to tear down", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    room.emit(ROOM_EVENT.Disconnected); // → error(server_unavailable), share torn down
    expect(engine.getState().status).toBe("error");
    await engine.stopScreenShare();
    expect(engine.getState().error).toEqual({ kind: "server_unavailable" });
    expect(engine.getState().screenShareEnabled).toBe(false);
  });
});

describe("screen share quality matrix (#112)", () => {
  it("applies the 1080p30 default encoding + maintain-framerate degradation", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.startScreenShare(acquireFixed(makeAssets(false)));
    expect(room.localParticipant.published[0]).toEqual({
      source: TRACK_SOURCE.ScreenShare,
      screenShareEncoding: { maxBitrate: 4_500_000, maxFramerate: 30 },
      degradationPreference: "maintain-framerate",
    });
  });

  it("passes the selected matrix cell through to the video publish (1440p60 / 2K)", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.startScreenShare(acquireFixed(makeAssets(true)), {
      quality: "1440p60",
    });
    expect(room.localParticipant.published[0]).toEqual({
      source: TRACK_SOURCE.ScreenShare,
      screenShareEncoding: { maxBitrate: 7_000_000, maxFramerate: 60 },
      degradationPreference: "maintain-framerate",
    });
    // The system-audio track publishes with NO video encoding attached — only the
    // music-profile Opus knobs (#113).
    expect(room.localParticipant.published[1]).toEqual({
      source: TRACK_SOURCE.ScreenShareAudio,
      audioPreset: { maxBitrate: 256_000 },
      red: true,
      dtx: false,
      forceStereo: true,
    });
  });

  it("passes a lower cell (720p30 budget) — the anti-stutter lower tier", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.startScreenShare(acquireFixed(makeAssets(false)), {
      quality: "720p30",
    });
    expect(room.localParticipant.published[0]).toEqual({
      source: TRACK_SOURCE.ScreenShare,
      screenShareEncoding: { maxBitrate: 2_500_000, maxFramerate: 30 },
      degradationPreference: "maintain-framerate",
    });
  });

  it("sets the motion content hint on the published screen video track", async () => {
    const assets = makeAssets(false);
    const video = assets.video as unknown as { contentHint?: string };
    const { engine } = setup();
    await engine.join("channel-1");
    await engine.startScreenShare(acquireFixed(assets));
    expect(video.contentHint).toBe("motion");
  });
});

describe("live-apply screen-share quality (configureVideo mid-share)", () => {
  const videoSettings = (overrides: Partial<VideoSettings> = {}): VideoSettings => ({
    ...DEFAULT_VIDEO_SETTINGS,
    ...overrides,
  });

  it("republishes the SAME screen video with the new encoding when the tier changes mid-share", async () => {
    const assets = makeAssets(false);
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.startScreenShare(acquireFixed(assets)); // balanced by default
    room.localParticipant.publishTrack.mockClear();
    room.localParticipant.unpublishTrack.mockClear();

    engine.configureVideo(videoSettings({ screenShareQuality: "1080p60" }));
    await flush();

    // Unpublished WITHOUT stopping the raw capture (so capture + film audio survive),
    // then republished with the new encoder ceiling — same track object.
    expect(room.localParticipant.unpublishTrack).toHaveBeenCalledWith(assets.video, false);
    expect(room.localParticipant.publishTrack).toHaveBeenLastCalledWith(assets.video, {
      source: TRACK_SOURCE.ScreenShare,
      screenShareEncoding: { maxBitrate: 6_500_000, maxFramerate: 60 },
      degradationPreference: "maintain-framerate",
    });
    // The share stays live throughout (the intermediate unpublish is not a stop).
    expect(engine.getState().screenShareEnabled).toBe(true);
    expect(engine.getState().error).toBeNull();
  });

  it("does NOT republish when the screen-share tier is unchanged", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.startScreenShare(acquireFixed(makeAssets(false)), { quality: "720p30" });
    room.localParticipant.publishTrack.mockClear();
    room.localParticipant.unpublishTrack.mockClear();
    // Same tier (720p30) → no-op; only a camera-only field changed.
    engine.configureVideo(videoSettings({ screenShareQuality: "720p30", cameraFrameRate: 60 }));
    await flush();
    expect(room.localParticipant.unpublishTrack).not.toHaveBeenCalled();
    expect(room.localParticipant.publishTrack).not.toHaveBeenCalled();
  });

  it("does NOT touch anything when the tier changes while NOT sharing", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1"); // no share
    room.localParticipant.publishTrack.mockClear();
    room.localParticipant.unpublishTrack.mockClear();
    engine.configureVideo(videoSettings({ screenShareQuality: "1080p60" }));
    await flush();
    expect(room.localParticipant.unpublishTrack).not.toHaveBeenCalled();
    expect(room.localParticipant.publishTrack).not.toHaveBeenCalled();
  });
});

describe("mic publish bitrate (M8 audioBitrateKbps)", () => {
  it("keeps the default mic publish untouched when no bitrate is configured", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
    // No capture/publish options are ever added on the default path.
    expect(
      room.localParticipant.setMicrophoneEnabled.mock.calls.every(
        (call) => call.length === 1,
      ),
    ).toBe(true);
  });

  it("maps the engine option to a livekit audioPreset on the mic publish", async () => {
    const { engine, room } = setup({ audioBitrateKbps: 96 });
    await engine.join("channel-1");
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(
      true,
      undefined,
      { audioPreset: { maxBitrate: 96_000 } },
    );
  });

  it("snaps a non-step bitrate to the nearest AudioPreset step", async () => {
    const { engine, room } = setup({ audioBitrateKbps: 50 });
    await engine.join("channel-1");
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(
      true,
      undefined,
      { audioPreset: { maxBitrate: 48_000 } },
    );
  });

  it("applies setAudioBitrateKbps to the next mic publish and clears with null", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");

    engine.setAudioBitrateKbps(24);
    await engine.setMic(false);
    await engine.setMic(true);
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(
      true,
      undefined,
      { audioPreset: { maxBitrate: 24_000 } },
    );

    engine.setAudioBitrateKbps(null);
    await engine.setMic(false);
    await engine.setMic(true);
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(true);
  });

  it("treats invalid bitrates as unset", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    engine.setAudioBitrateKbps(Number.NaN);
    await engine.setMic(false);
    await engine.setMic(true);
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(true);
  });
});

describe("configureAudio (Ayarlar → Mikrofon)", () => {
  const audioSettings = (overrides: Partial<AudioSettings> = {}): AudioSettings => ({
    ...DEFAULT_AUDIO_SETTINGS,
    processing: { ...DEFAULT_AUDIO_SETTINGS.processing },
    ...overrides,
  });

  it("maps the NS tier + processing toggles + quality to the mic capture options + bitrate on publish", async () => {
    const { engine, room } = setup();
    engine.configureAudio(
      audioSettings({
        // `off` tier → the browser NS constraint is false; the toggles map 1:1.
        noiseSuppression: "off",
        processing: { echoCancellation: true, autoGainControl: false },
        quality: "high",
      }),
    );
    await engine.join("channel-1");
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(
      true,
      {
        noiseSuppression: false,
        echoCancellation: true,
        autoGainControl: false,
        sampleRate: 48_000,
        channelCount: 1,
      },
      { audioPreset: { maxBitrate: 96_000 }, red: true, dtx: true, forceStereo: false },
    );
  });

  it("standard tier maps to the built-in WebRTC noiseSuppression constraint, no worklet", async () => {
    const createNoiseFilter = vi.fn(makeFakeNoiseFilter);
    const { engine, room } = setup({ createNoiseFilter });
    engine.configureAudio(audioSettings({ noiseSuppression: "standard" }));
    await engine.join("channel-1");
    const [, capture] = room.localParticipant.setMicrophoneEnabled.mock.calls.at(-1)!;
    expect(capture).toMatchObject({ noiseSuppression: true });
    // A standard tier attaches no processor; a null detach is fine but never a real one.
    expect(room.applyNoiseFilter).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "fake-rnnoise" }),
    );
    expect(createNoiseFilter).not.toHaveBeenCalled();
  });

  it("high tier WITH an injected filter: turns the browser NS OFF + applies the worklet after publish", async () => {
    const createNoiseFilter = vi.fn(makeFakeNoiseFilter);
    const { engine, room } = setup({ createNoiseFilter });
    engine.configureAudio(audioSettings({ noiseSuppression: "high" }));
    await engine.join("channel-1");
    const [, capture] = room.localParticipant.setMicrophoneEnabled.mock.calls.at(-1)!;
    // The worklet does suppression, so the browser NS capture constraint is off (no
    // double-process); the RNNoise processor is attached via applyNoiseFilter, NOT
    // through capture options (which would throw in livekit 2.x).
    expect(capture).toMatchObject({ noiseSuppression: false });
    expect(createNoiseFilter).toHaveBeenCalledTimes(1);
    expect(room.applyNoiseFilter).toHaveBeenCalledWith(
      expect.objectContaining({ name: "fake-rnnoise" }),
    );
  });

  it("high tier WITHOUT a filter factory (mobile): degrades to standard NS, no worklet applied", async () => {
    const { engine, room } = setup(); // no createNoiseFilter injected
    engine.configureAudio(audioSettings({ noiseSuppression: "high" }));
    await engine.join("channel-1");
    const [, capture] = room.localParticipant.setMicrophoneEnabled.mock.calls.at(-1)!;
    expect(capture).toMatchObject({ noiseSuppression: true });
    expect(room.applyNoiseFilter).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "fake-rnnoise" }),
    );
  });

  it("High→Off detaches the worklet WITHOUT touching the mic track at all", async () => {
    const createNoiseFilter = vi.fn(makeFakeNoiseFilter);
    const { engine, room } = setup({ createNoiseFilter });
    engine.configureAudio(audioSettings({ noiseSuppression: "high" }));
    await engine.join("channel-1");
    room.republishMicTrack.mockClear();
    room.restartAudioTrack.mockClear();
    room.applyMicCaptureConstraints.mockClear();
    room.applyNoiseFilter.mockClear();
    createNoiseFilter.mockClear();
    // high (filter → browser NS off) and off (NS off) yield IDENTICAL capture
    // constraints, so the only thing that has to happen is stopping the worklet.
    engine.configureAudio(audioSettings({ noiseSuppression: "off" }));
    await flush();
    // The worklet is explicitly detached — this is the bit that used to be skipped.
    expect(room.applyNoiseFilter).toHaveBeenCalledWith(null);
    expect(createNoiseFilter).not.toHaveBeenCalled();
    // ...and nothing touched the capture or the publication, so no listener heard a gap.
    expect(room.republishMicTrack).not.toHaveBeenCalled();
    expect(room.restartAudioTrack).not.toHaveBeenCalled();
    expect(room.applyMicCaptureConstraints).not.toHaveBeenCalled();
  });

  it("an NS tier change NEVER republishes — it retunes in place and moves the worklet", async () => {
    const createNoiseFilter = vi.fn(makeFakeNoiseFilter);
    const { engine, room } = setup({ createNoiseFilter });
    engine.configureAudio(audioSettings({ noiseSuppression: "standard" }));
    await engine.join("channel-1");
    room.republishMicTrack.mockClear();
    room.restartAudioTrack.mockClear();
    room.applyMicCaptureConstraints.mockClear();
    room.applyNoiseFilter.mockClear();

    engine.configureAudio(audioSettings({ noiseSuppression: "high" }));
    await flush();

    // The browser NS constraint moved on the SAME track (zero-gap path)...
    expect(room.applyMicCaptureConstraints).toHaveBeenCalledTimes(1);
    expect(room.applyMicCaptureConstraints.mock.calls[0]?.[0]).toMatchObject({
      noiseSuppression: false,
    });
    // ...the worklet was attached...
    expect(room.applyNoiseFilter).toHaveBeenCalledWith(
      expect.objectContaining({ name: "fake-rnnoise" }),
    );
    // ...and the publication was never torn down. This is the founder-visible
    // property: choosing a filter must not drop everyone's audio.
    expect(room.republishMicTrack).not.toHaveBeenCalled();
    expect(room.restartAudioTrack).not.toHaveBeenCalled();
  });

  it("High→Standard stops the worklet BEFORE retuning constraints (ordering matters)", async () => {
    const createNoiseFilter = vi.fn(makeFakeNoiseFilter);
    const { engine, room } = setup({ createNoiseFilter });
    engine.configureAudio(audioSettings({ noiseSuppression: "high" }));
    await engine.join("channel-1");
    await flush();
    const order: string[] = [];
    room.applyNoiseFilter.mockImplementation(async (p) => {
      order.push(p ? "attach" : "detach");
    });
    room.applyMicCaptureConstraints.mockImplementation(async () => {
      order.push("constraints");
      return true;
    });

    engine.configureAudio(audioSettings({ noiseSuppression: "standard" }));
    await flush();

    // The worklet must come off FIRST: while a processor is attached the adapter's
    // `mediaStreamTrack` is the processor's OUTPUT, so retuning capture constraints
    // first would target the wrong track entirely.
    expect(order).toEqual(["detach", "constraints"]);
    expect(room.republishMicTrack).not.toHaveBeenCalled();
  });

  it("falls back to a re-acquire when an in-place retune is not possible", async () => {
    const { engine, room } = setup();
    engine.configureAudio(audioSettings());
    await engine.join("channel-1");
    await flush();
    room.applyMicCaptureConstraints.mockResolvedValue(false); // browser rejected it
    room.restartAudioTrack.mockClear();
    room.republishMicTrack.mockClear();

    engine.configureAudio(
      audioSettings({ processing: { echoCancellation: false, autoGainControl: true } }),
    );
    await flush();

    // restartTrack keeps the SAME publication (livekit replaceTrack), so listeners
    // keep the track — still far lighter than an unpublish/republish.
    expect(room.restartAudioTrack).toHaveBeenCalledTimes(1);
    expect(room.restartAudioTrack.mock.calls[0]?.[0]).toMatchObject({
      echoCancellation: false,
    });
    expect(room.republishMicTrack).not.toHaveBeenCalled();
  });

  it("a BITRATE change still republishes — bitrate lives on the publication", async () => {
    const { engine, room } = setup();
    engine.configureAudio(audioSettings({ quality: "standard" }));
    await engine.join("channel-1");
    await flush();
    room.republishMicTrack.mockClear();
    room.applyMicCaptureConstraints.mockClear();

    engine.configureAudio(audioSettings({ quality: "high" }));
    await flush();

    expect(room.republishMicTrack).toHaveBeenCalledTimes(1);
    expect(room.republishMicTrack.mock.calls[0]?.[1]).toMatchObject({
      audioPreset: { maxBitrate: 96_000 },
    });
    // The republish already carries the capture options; no separate retune.
    expect(room.applyMicCaptureConstraints).not.toHaveBeenCalled();
  });

  it("music mode re-acquires (stereo capture) and keeps the NS lock", async () => {
    const createNoiseFilter = vi.fn(makeFakeNoiseFilter);
    const { engine, room } = setup({ createNoiseFilter });
    engine.configureAudio(audioSettings({ noiseSuppression: "high" }));
    await engine.join("channel-1");
    await flush();
    room.republishMicTrack.mockClear();
    room.applyNoiseFilter.mockClear();
    createNoiseFilter.mockClear();

    engine.configureAudio(audioSettings({ noiseSuppression: "high", musicMode: true }));
    await flush();

    // Müzik Modu forces the effective tier to `off`, so the worklet comes off even
    // though the user's stored tier is still `high` — the lock must survive the
    // lighter-touch rework.
    expect(room.applyNoiseFilter).toHaveBeenCalledWith(null);
    expect(createNoiseFilter).not.toHaveBeenCalled();
    // Stereo + 256 kbps are publication/structural changes, so this one DOES republish.
    expect(room.republishMicTrack).toHaveBeenCalledTimes(1);
    const [capture, publish] = room.republishMicTrack.mock.calls[0]!;
    expect(capture).toMatchObject({ channelCount: 2, noiseSuppression: false });
    expect(publish).toMatchObject({ audioPreset: { maxBitrate: 256_000 }, forceStereo: true });
  });

  it("falls back to standard NS (republishes with browser NS on) when the worklet FAILS", async () => {
    const createNoiseFilter = vi.fn(makeFakeNoiseFilter);
    const room = new FakeRoom();
    // Worklet application rejects (WASM/CSP failure): High must degrade to Standard,
    // never sit with NS off + a dead worklet.
    room.applyNoiseFilter.mockRejectedValue(new Error("wasm blocked by CSP"));
    const { engine } = setup({ room, createNoiseFilter });
    engine.configureAudio(audioSettings({ noiseSuppression: "high" }));
    await engine.join("channel-1");
    await flush();
    // The failed attach triggered a fallback republish whose capture turns browser NS
    // back ON (the filter is now latched broken → treated as unavailable).
    expect(room.republishMicTrack).toHaveBeenCalled();
    const [fallbackCapture] = room.republishMicTrack.mock.calls.at(-1)!;
    expect(fallbackCapture).toMatchObject({ noiseSuppression: true });
  });

  it("does not attach the worklet while the mic is muted; attaches it on unmute", async () => {
    const createNoiseFilter = vi.fn(makeFakeNoiseFilter);
    const { engine, room } = setup({ createNoiseFilter });
    engine.configureAudio(audioSettings({ noiseSuppression: "high" }));
    await engine.join("channel-1");
    await engine.setMic(false);
    room.applyNoiseFilter.mockClear();
    createNoiseFilter.mockClear();
    // Muted → the worklet is detached (null), not attached.
    expect(room.applyNoiseFilter).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "fake-rnnoise" }),
    );
    await engine.setMic(true);
    expect(room.applyNoiseFilter).toHaveBeenCalledWith(
      expect.objectContaining({ name: "fake-rnnoise" }),
    );
  });

  it("music mode drops NS/AGC but KEEPS AEC, goes stereo, and raises the bitrate to 256 kbps", async () => {
    const { engine, room } = setup();
    engine.configureAudio(
      audioSettings({
        musicMode: true,
        // Even with the toggles ON + a low quality tier, music mode overrides the
        // tier and relaxes NS/AGC — but echo cancellation stays on (movie-night
        // echo-loop fix), so a phone's speaker output never feeds back into its mic.
        noiseSuppression: "standard",
        processing: { echoCancellation: true, autoGainControl: true },
        quality: "standard",
      }),
    );
    await engine.join("channel-1");
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(
      true,
      {
        noiseSuppression: false,
        echoCancellation: true,
        autoGainControl: false,
        sampleRate: 48_000,
        channelCount: 2,
      },
      { audioPreset: { maxBitrate: 256_000 }, red: true, dtx: false, forceStereo: true },
    );
  });

  it("takes the higher of the channel bitrate and the user quality tier", async () => {
    const { engine, room } = setup({ audioBitrateKbps: 32 });
    // Channel says 32; user's music mode wants 256 → 256 wins (guitar transmits clean).
    engine.configureAudio(audioSettings({ musicMode: true }));
    await engine.join("channel-1");
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(
      true,
      expect.anything(),
      { audioPreset: { maxBitrate: 256_000 }, red: true, dtx: false, forceStereo: true },
    );
  });

  it("live RE-PUBLISHES the mic when the audio tier changes mid-call (the bitrate/codec fix)", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1"); // mic on
    // Changing ONLY the quality tier used to be a no-op (capture unchanged) — the
    // founder's "nothing changed" bug. It must now republish with the new bitrate.
    engine.configureAudio(audioSettings({ quality: "music" }));
    expect(room.republishMicTrack).toHaveBeenCalledWith(
      {
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true,
        sampleRate: 48_000,
        channelCount: 2,
      },
      { audioPreset: { maxBitrate: 256_000 }, red: true, dtx: false, forceStereo: true },
    );
    // A capture-only restart would keep the old publication bitrate, so it is NOT used.
    expect(room.restartAudioTrack).not.toHaveBeenCalled();
  });

  it("does NOT live re-apply while the mic is muted (applies on next unmute instead)", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.setMic(false);
    engine.configureAudio(audioSettings({ musicMode: true }));
    expect(room.republishMicTrack).not.toHaveBeenCalled();
    expect(room.restartAudioTrack).not.toHaveBeenCalled();
  });

  it("does NOT re-apply when nothing that affects the published track changed", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    engine.configureAudio(audioSettings({ musicMode: true }));
    expect(room.republishMicTrack).toHaveBeenCalledTimes(1);
    // Music mode overrides the tier, so changing `quality` here changes NOTHING
    // effective (still stereo 256 kbps, DSP off) → no second republish.
    engine.configureAudio(audioSettings({ musicMode: true, quality: "high" }));
    expect(room.republishMicTrack).toHaveBeenCalledTimes(1);
  });
});

describe("configureVideo (Ayarlar → görüntü)", () => {
  const videoSettings = (overrides: Partial<VideoSettings> = {}): VideoSettings => ({
    ...DEFAULT_VIDEO_SETTINGS,
    ...overrides,
  });

  it("passes the camera resolution + FPS AND the explicit bitrate ceiling to setCameraEnabled", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    engine.configureVideo(videoSettings({ cameraQuality: "fhd", cameraFrameRate: 60 }));
    await engine.setCamera(true);
    expect(room.localParticipant.setCameraEnabled).toHaveBeenLastCalledWith(
      true,
      { resolution: { width: 1920, height: 1080, frameRate: 60 } },
      {
        videoEncoding: { maxBitrate: 5_000_000, maxFramerate: 60 },
        simulcast: true,
        videoSimulcastLayers: [CAMERA_LOW_SIMULCAST_LAYER],
        degradationPreference: "balanced",
      },
    );
  });

  it("raises auto @ 30fps with an explicit encoding (no longer a soft single-arg publish)", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    engine.configureVideo(videoSettings({ cameraQuality: "auto", cameraFrameRate: 30 }));
    await engine.setCamera(true);
    // Capture stays unconstrained (undefined) but the encoding is pinned to 2.5 Mbps
    // instead of livekit's ~1.7 Mbps default — this is what makes "Auto" look good —
    // and degradation is BALANCED so a busy phone sheds resolution progressively and
    // the picture never stops (maintain-resolution froze mobile cameras at ~2fps).
    expect(room.localParticipant.setCameraEnabled).toHaveBeenLastCalledWith(
      true,
      undefined,
      {
        videoEncoding: { maxBitrate: 2_500_000, maxFramerate: 30 },
        simulcast: true,
        videoSimulcastLayers: [CAMERA_LOW_SIMULCAST_LAYER],
        degradationPreference: "balanced",
      },
    );
  });

  it("live re-applies to a running camera when the video settings change mid-call", async () => {
    const { engine, room } = setup();
    engine.configureVideo(videoSettings({ cameraQuality: "hd", cameraFrameRate: 30 }));
    await engine.join("channel-1");
    await engine.setCamera(true);
    room.localParticipant.setCameraEnabled.mockClear();
    // Change to 1080p60 mid-call → republish (off, then on with the new options).
    engine.configureVideo(videoSettings({ cameraQuality: "fhd", cameraFrameRate: 60 }));
    await flush();
    expect(room.localParticipant.setCameraEnabled).toHaveBeenNthCalledWith(1, false);
    expect(room.localParticipant.setCameraEnabled).toHaveBeenNthCalledWith(
      2,
      true,
      { resolution: { width: 1920, height: 1080, frameRate: 60 } },
      {
        videoEncoding: { maxBitrate: 5_000_000, maxFramerate: 60 },
        simulcast: true,
        videoSimulcastLayers: [CAMERA_LOW_SIMULCAST_LAYER],
        degradationPreference: "balanced",
      },
    );
    expect(engine.getState().cameraEnabled).toBe(true); // not read as a track-end
    expect(engine.getState().error).toBeNull();
  });

  it("does NOT touch the camera when the video settings change while it is off", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1"); // camera off
    room.localParticipant.setCameraEnabled.mockClear();
    engine.configureVideo(videoSettings({ cameraQuality: "fhd", cameraFrameRate: 60 }));
    await flush();
    expect(room.localParticipant.setCameraEnabled).not.toHaveBeenCalled();
  });
});

describe("remote camera preferred layer (focus → high)", () => {
  it("forwards setRemoteCameraQuality to the adapter (focus high, unfocus auto)", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    room.subscribeCamera("user-b");
    engine.setRemoteCameraQuality("user-b", "high");
    expect(room.setRemoteCameraQuality).toHaveBeenLastCalledWith("user-b", "high");
    engine.setRemoteCameraQuality("user-b", "auto");
    expect(room.setRemoteCameraQuality).toHaveBeenLastCalledWith("user-b", "auto");
  });

  it("is a safe no-op when no room / adapter support is present", async () => {
    const { engine } = setup();
    // Not connected — no room; must not throw.
    expect(() => engine.setRemoteCameraQuality("user-b", "high")).not.toThrow();
  });
});

describe("remote camera subscription (hidden → unsubscribe)", () => {
  it("forwards setRemoteCameraSubscribed to the adapter (hide unsubscribe, show subscribe)", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    room.subscribeCamera("user-b");
    engine.setRemoteCameraSubscribed("user-b", false);
    expect(room.setRemoteCameraSubscribed).toHaveBeenLastCalledWith("user-b", false);
    engine.setRemoteCameraSubscribed("user-b", true);
    expect(room.setRemoteCameraSubscribed).toHaveBeenLastCalledWith("user-b", true);
  });

  it("is a safe no-op when no room / adapter support is present", async () => {
    const { engine } = setup();
    // Not connected — no room; must not throw.
    expect(() => engine.setRemoteCameraSubscribed("user-b", false)).not.toThrow();
  });
});

describe("remote screen shares", () => {
  it("exposes a subscribed remote screen-share track and marks the badge", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    const shares: RemoteScreenShare[][] = [];
    engine.subscribeScreenShares((s) => shares.push(s));

    const track = room.subscribeScreenShare("user-b");
    expect(engine.getScreenShares().map((s) => s.identity)).toEqual(["user-b"]);
    expect(engine.getScreenShares()[0]?.track).toBe(track);
    expect(shares.at(-1)?.length).toBe(1);
    expect(
      engine.getState().participants.find((p) => p.identity === "user-b")?.screenSharing,
    ).toBe(true);
  });

  it("removes the remote screen share on unsubscribe", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    const track = room.subscribeScreenShare("user-b");
    room.unsubscribeScreenShare("user-b", track);
    expect(engine.getScreenShares()).toEqual([]);
    expect(
      engine.getState().participants.find((p) => p.identity === "user-b")?.screenSharing,
    ).toBe(false);
  });

  it("ignores non-screen-share subscriptions", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    const b = room.addRemote("user-b");
    const audioTrack = new FakeRemoteTrack(
      "audio",
      new FakeMediaStreamTrack("audio") as unknown as MediaStreamTrack,
    );
    room.emit(
      ROOM_EVENT.TrackSubscribed,
      audioTrack,
      { source: TRACK_SOURCE.Microphone },
      b,
    );
    expect(engine.getScreenShares()).toEqual([]);
  });

  it("keeps the getScreenShares snapshot referentially stable when unchanged", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    room.subscribeScreenShare("user-b");
    const snap = engine.getScreenShares();
    expect(engine.getScreenShares()).toBe(snap); // no rebuild between reads
  });

  it("drops a remote screen share when the participant disconnects", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    room.subscribeScreenShare("user-b");
    expect(engine.getScreenShares()).toHaveLength(1);
    room.removeRemote("user-b");
    expect(engine.getScreenShares()).toEqual([]);
  });
});

describe("late-joiner seed (already-published share/camera at connect)", () => {
  it("surfaces an ongoing remote screen share that never re-fired TrackSubscribed", async () => {
    const { engine, room } = setup();
    const shares: RemoteScreenShare[][] = [];
    engine.subscribeScreenShares((s) => shares.push(s));
    room.preexistingScreenShare("user-b");
    await engine.join("channel-1");
    const current = engine.getScreenShares();
    expect(current).toHaveLength(1);
    expect(current[0]?.identity).toBe("user-b");
    expect(shares.at(-1)).toHaveLength(1);
    expect(engine.getState().participants.find((p) => p.identity === "user-b")?.screenSharing).toBe(true);
  });
  it("surfaces an ongoing remote camera and honours the muted-camera gate", async () => {
    const { engine, room } = setup();
    room.preexistingCamera("user-b");
    room.preexistingCameraMuted("user-c");
    await engine.join("channel-1");
    expect(engine.getCameras().map((c) => c.identity)).toEqual(["user-b"]);
  });
  it("force-subscribes pre-existing remote AUDIO on join so a late-joiner HEARS the ongoing film", async () => {
    // The AUDIO half of the seed: a viewer who joins AFTER the host started sharing must
    // subscribe the pre-existing voice + film (screen_share_audio) publications or hear
    // nothing (the RN "hears nothing" P0). Audio needs no rendering, so the engine only
    // asks the adapter to ensure the subscriptions exist.
    const { engine, room } = setup();
    await engine.join("channel-1");
    expect(room.ensureRemoteAudioSubscribed).toHaveBeenCalledTimes(1);
  });
  it("re-asserts remote audio subscriptions after a reconnect (rebuilt transport)", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    room.ensureRemoteAudioSubscribed.mockClear();
    room.emit(ROOM_EVENT.Reconnecting);
    room.emit(ROOM_EVENT.Reconnected);
    expect(room.ensureRemoteAudioSubscribed).toHaveBeenCalledTimes(1);
  });
  it("re-subscribes audio on reconnect EVEN WHEN deafened (so undeafen isn't silent)", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.setDeafened(true);
    room.ensureRemoteAudioSubscribed.mockClear();
    room.emit(ROOM_EVENT.Reconnecting);
    room.emit(ROOM_EVENT.Reconnected);
    // Unconditional: the re-subscribed film/voice track comes up muted (deafened)
    // but is ready to play the instant the user undeafens.
    expect(room.ensureRemoteAudioSubscribed).toHaveBeenCalledTimes(1);
  });
});

// ── camera (task #18) ───────────────────────────────────────────────────────

/** The local participant's camera flag, as the UI reads it from state. */
const localCamera = (engine: VoiceEngine): boolean =>
  engine.getState().participants.find((p) => p.isLocal)?.cameraEnabled ?? false;

describe("local camera lifecycle", () => {
  it("turns the camera on via setCameraEnabled and flips cameraEnabled + the local row", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.setCamera(true);

    expect(room.localParticipant.setCameraEnabled).toHaveBeenCalledWith(true);
    expect(engine.getState().cameraEnabled).toBe(true);
    expect(localCamera(engine)).toBe(true);
    expect(engine.getState().error).toBeNull();
  });

  it("turns the camera off again and clears the flag", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.setCamera(true);
    await engine.setCamera(false);

    expect(room.localParticipant.setCameraEnabled).toHaveBeenLastCalledWith(false);
    expect(engine.getState().cameraEnabled).toBe(false);
    expect(localCamera(engine)).toBe(false);
  });

  it("is idempotent: enabling an already-on camera does nothing", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.setCamera(true);
    room.localParticipant.setCameraEnabled.mockClear();
    await engine.setCamera(true);
    expect(room.localParticipant.setCameraEnabled).not.toHaveBeenCalled();
  });

  it("stays connected listen-visible-off with a typed error when camera permission is denied", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    room.localParticipant.failNextCameraWith("NotAllowedError");
    await expect(engine.setCamera(true)).rejects.toBeInstanceOf(VoiceOperationError);
    expect(engine.getState().status).toBe("connected");
    expect(engine.getState().cameraEnabled).toBe(false);
    expect(engine.getState().error).toEqual({
      kind: "permission_denied",
      device: "camera",
    });
  });

  it("maps a missing camera to device_not_found(camera)", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    room.localParticipant.failNextCameraWith("NotFoundError");
    await expect(engine.setCamera(true)).rejects.toBeInstanceOf(VoiceOperationError);
    expect(engine.getState().cameraEnabled).toBe(false);
    expect(engine.getState().error).toEqual({
      kind: "device_not_found",
      device: "camera",
    });
  });

  it("surfaces device_unavailable when the adapter cannot publish a camera", async () => {
    // A room whose local participant has no setCameraEnabled (unsupported platform).
    const room = new FakeRoom();
    (room.localParticipant as { setCameraEnabled?: unknown }).setCameraEnabled = undefined;
    const { engine } = setup({ room });
    await engine.join("channel-1");
    await expect(engine.setCamera(true)).rejects.toBeInstanceOf(VoiceOperationError);
    expect(engine.getState().cameraEnabled).toBe(false);
    expect(engine.getState().error).toEqual({
      kind: "device_unavailable",
      deviceId: "camera",
      // `device` is what stops a camera failure being messaged as an AUDIO
      // device failure (the founder's mobile-web P0).
      device: "camera",
    });
  });
});

describe("camera independence (task #18)", () => {
  it("runs the camera while the mic is muted — the two are independent", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.setMic(false);
    await engine.setCamera(true);
    expect(engine.getState().micEnabled).toBe(false);
    expect(engine.getState().cameraEnabled).toBe(true);
    expect(room.localParticipant.setCameraEnabled).toHaveBeenCalledWith(true);
  });

  it("runs the camera and a screen share at the same time (separate tracks)", async () => {
    const { engine } = setup();
    await engine.join("channel-1");
    await engine.startScreenShare(acquireFixed(makeAssets(false)));
    await engine.setCamera(true);
    expect(engine.getState().screenShareEnabled).toBe(true);
    expect(engine.getState().cameraEnabled).toBe(true);
    const local = engine.getState().participants[0];
    expect(local?.screenSharing).toBe(true);
    expect(local?.cameraEnabled).toBe(true);
  });

  it("stopping the screen share leaves the camera on (and vice versa)", async () => {
    const { engine } = setup();
    await engine.join("channel-1");
    await engine.setCamera(true);
    await engine.startScreenShare(acquireFixed(makeAssets(false)));
    await engine.stopScreenShare();
    expect(engine.getState().screenShareEnabled).toBe(false);
    expect(engine.getState().cameraEnabled).toBe(true);

    await engine.setCamera(false);
    // Turning the camera off did not touch a (now stopped) screen share.
    expect(engine.getState().cameraEnabled).toBe(false);
    expect(engine.getState().screenShareEnabled).toBe(false);
  });
});

describe("camera device selection (task #18)", () => {
  it("stores selectedVideoDeviceId while idle without touching the room", async () => {
    const { engine, room } = setup();
    await engine.setVideoDevice("cam-2");
    expect(engine.getState().selectedVideoDeviceId).toBe("cam-2");
    expect(room.switchActiveDevice).not.toHaveBeenCalled();
  });

  it("switches the live videoinput when the camera is on", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.setCamera(true);
    await engine.setVideoDevice("cam-2");
    expect(room.switchActiveDevice).toHaveBeenCalledWith("videoinput", "cam-2");
    expect(engine.getState().selectedVideoDeviceId).toBe("cam-2");
  });

  it("only stores the preference (no live switch) when the camera is off", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.setVideoDevice("cam-3");
    expect(room.switchActiveDevice).not.toHaveBeenCalledWith("videoinput", "cam-3");
    expect(engine.getState().selectedVideoDeviceId).toBe("cam-3");
  });

  it("applies a pre-set camera preference when the camera is later enabled", async () => {
    const { engine, room } = setup();
    await engine.setVideoDevice("cam-4"); // preference set before joining
    await engine.join("channel-1");
    await engine.setCamera(true);
    expect(room.switchActiveDevice).toHaveBeenCalledWith("videoinput", "cam-4");
  });

  it("keeps the camera on if applying the preferred device fails on enable", async () => {
    const { engine, room } = setup();
    await engine.setVideoDevice("cam-5");
    await engine.join("channel-1");
    room.switchActiveDevice.mockRejectedValueOnce(new Error("gone"));
    await engine.setCamera(true);
    expect(engine.getState().cameraEnabled).toBe(true); // non-fatal
    expect(engine.getState().error).toBeNull();
  });

  it("surfaces device_unavailable and keeps the old selection when a live switch fails", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.setCamera(true);
    room.switchActiveDevice.mockRejectedValueOnce(new Error("gone"));
    await expect(engine.setVideoDevice("broken-cam")).rejects.toBeInstanceOf(
      VoiceOperationError,
    );
    expect(engine.getState().selectedVideoDeviceId).toBeNull();
    expect(engine.getState().error).toEqual({
      kind: "device_unavailable",
      deviceId: "broken-cam",
    });
  });
});

describe("camera track loss (task #18)", () => {
  it("flags track_ended_unexpectedly(camera) when the camera track vanishes while on", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.setCamera(true);
    room.emit(ROOM_EVENT.LocalTrackUnpublished, { source: TRACK_SOURCE.Camera });
    expect(engine.getState().cameraEnabled).toBe(false);
    expect(engine.getState().error).toEqual({
      kind: "track_ended_unexpectedly",
      track: "camera",
    });
    expect(engine.getState().status).toBe("connected"); // stays in the room
    expect(localCamera(engine)).toBe(false);
  });

  it("ignores an intentional camera unpublish (camera already turned off)", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.setCamera(true);
    await engine.setCamera(false);
    room.emit(ROOM_EVENT.LocalTrackUnpublished, { source: TRACK_SOURCE.Camera });
    expect(engine.getState().error).toBeNull();
  });
});

describe("camera lifecycle transitions (task #18)", () => {
  it("preserves cameraEnabled across a reconnect", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.setCamera(true);
    room.emit(ROOM_EVENT.Reconnecting);
    expect(engine.getState().status).toBe("reconnecting");
    expect(engine.getState().cameraEnabled).toBe(true); // held through the drop
    room.emit(ROOM_EVENT.Reconnected);
    expect(engine.getState().status).toBe("connected");
    expect(engine.getState().cameraEnabled).toBe(true);
  });

  it("clears cameraEnabled on an unexpected disconnect", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.setCamera(true);
    room.emit(ROOM_EVENT.Disconnected);
    expect(engine.getState().status).toBe("error");
    expect(engine.getState().cameraEnabled).toBe(false);
  });

  it("clears cameraEnabled on leave but preserves the selectedVideoDeviceId preference", async () => {
    const { engine } = setup();
    await engine.join("channel-1");
    await engine.setCamera(true);
    await engine.setVideoDevice("cam-2");
    await engine.leave();
    expect(engine.getState().cameraEnabled).toBe(false);
    expect(engine.getState().selectedVideoDeviceId).toBe("cam-2"); // device pref survives
  });

  it("resets cameraEnabled on dispose", async () => {
    const { engine } = setup();
    await engine.join("channel-1");
    await engine.setCamera(true);
    await engine.dispose();
    expect(engine.getState().cameraEnabled).toBe(false);
  });
});

describe("remote cameras (task #18)", () => {
  it("exposes a subscribed remote camera track and marks the participant row", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    const cameras: RemoteCamera[][] = [];
    engine.subscribeCameras((c) => cameras.push(c));

    const track = room.subscribeCamera("user-b");
    expect(engine.getCameras().map((c) => c.identity)).toEqual(["user-b"]);
    expect(engine.getCameras()[0]?.track).toBe(track);
    expect(cameras.at(-1)?.length).toBe(1);
    expect(
      engine.getState().participants.find((p) => p.identity === "user-b")?.cameraEnabled,
    ).toBe(true);
  });

  it("removes the remote camera on unsubscribe", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    const track = room.subscribeCamera("user-b");
    room.unsubscribeCamera("user-b", track);
    expect(engine.getCameras()).toEqual([]);
    expect(
      engine.getState().participants.find((p) => p.identity === "user-b")?.cameraEnabled,
    ).toBe(false);
  });

  it("keeps the getCameras snapshot referentially stable when unchanged", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    room.subscribeCamera("user-b");
    const snap = engine.getCameras();
    expect(engine.getCameras()).toBe(snap);
  });

  it("drops a remote camera when the participant disconnects", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    room.subscribeCamera("user-b");
    expect(engine.getCameras()).toHaveLength(1);
    room.removeRemote("user-b");
    expect(engine.getCameras()).toEqual([]);
  });

  it("tracks a remote's camera and screen share independently on separate tiles", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    room.subscribeCamera("user-b");
    room.subscribeScreenShare("user-b");
    // Both snapshots hold user-b at once — camera ≠ screen share.
    expect(engine.getCameras().map((c) => c.identity)).toEqual(["user-b"]);
    expect(engine.getScreenShares().map((s) => s.identity)).toEqual(["user-b"]);
    const row = engine.getState().participants.find((p) => p.identity === "user-b");
    expect(row?.cameraEnabled).toBe(true);
    expect(row?.screenSharing).toBe(true);

    // Ending the camera leaves the screen share intact.
    const cam = engine.getCameras()[0]?.track as unknown as FakeRemoteTrack;
    room.unsubscribeCamera("user-b", cam);
    expect(engine.getCameras()).toEqual([]);
    expect(engine.getScreenShares().map((s) => s.identity)).toEqual(["user-b"]);
  });

  it("drops remote cameras on an unexpected disconnect", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    room.subscribeCamera("user-b");
    expect(engine.getCameras()).toHaveLength(1);
    room.emit(ROOM_EVENT.Disconnected);
    expect(engine.getCameras()).toEqual([]);
  });

  it("drops a remote camera on MUTE (livekit mutes, never unsubscribes, a camera turned off)", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    const cameras: RemoteCamera[][] = [];
    engine.subscribeCameras((c) => cameras.push(c));
    room.subscribeCamera("user-b");
    expect(engine.getCameras().map((c) => c.identity)).toEqual(["user-b"]);

    // Turning the remote camera off only fires TrackMuted — no TrackUnsubscribed.
    room.muteCamera("user-b");
    expect(engine.getCameras()).toEqual([]); // tile → avatar, no frozen frame
    expect(
      engine.getState().participants.find((p) => p.identity === "user-b")?.cameraEnabled,
    ).toBe(false);
    expect(cameras.at(-1)?.length).toBe(0);
  });

  it("re-binds a remote camera on UNMUTE with the resumed track", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    const track = room.subscribeCamera("user-b");
    room.muteCamera("user-b");
    expect(engine.getCameras()).toEqual([]);

    room.unmuteCamera("user-b", track);
    expect(engine.getCameras().map((c) => c.identity)).toEqual(["user-b"]);
    expect(engine.getCameras()[0]?.track).toBe(track);
    expect(
      engine.getState().participants.find((p) => p.identity === "user-b")?.cameraEnabled,
    ).toBe(true);
  });

  it("does NOT render a camera that subscribed already-muted (joined with camera off)", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    room.subscribeCameraMuted("user-b");
    expect(engine.getCameras()).toEqual([]); // no black tile
    expect(
      engine.getState().participants.find((p) => p.identity === "user-b")?.cameraEnabled,
    ).toBe(false);
  });

  it("ignores a LOCAL camera mute (the local flag is engine-driven, not in remoteCameras)", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    room.subscribeCamera("user-b");
    // A TrackMuted for OUR OWN camera must not touch the remote-camera snapshot.
    room.emit(
      ROOM_EVENT.TrackMuted,
      { source: TRACK_SOURCE.Camera, isMuted: true },
      room.localParticipant,
    );
    expect(engine.getCameras().map((c) => c.identity)).toEqual(["user-b"]);
  });
});

describe("leave lifecycle", () => {
  it("walks connected → leaving → idle, disconnects, and removes listeners", async () => {
    const { engine, room } = setup();
    const statuses: string[] = [];
    engine.subscribe((s: VoiceState) => statuses.push(s.status));
    await engine.join("channel-1");
    await engine.leave();
    await flush();

    expect(room.disconnect).toHaveBeenCalledOnce();
    expect(room.listenerCount()).toBe(0);
    expect(engine.getState()).toMatchObject({
      status: "idle",
      roomId: null,
      participants: [],
      error: null,
    });
    expect(statuses).toContain("leaving");
    expect(statuses.at(-1)).toBe("idle");
  });

  it("aborts an in-flight join when the user leaves mid-fetch", async () => {
    const room = new FakeRoom();
    let releaseToken = (_: { url: string; token: string }) => {};
    const { engine } = setup({
      room,
      fetchToken: () => new Promise((resolve) => (releaseToken = resolve)),
    });
    const joining = engine.join("channel-1");
    await flush();
    await engine.leave();
    releaseToken({ url: "ws://test:7880", token: "jwt" });
    await joining; // resolves silently as a stale command
    expect(engine.getState().status).toBe("idle");
    expect(room.connect).not.toHaveBeenCalled();
  });

  it("clears the error state on leave from error", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    room.emit(ROOM_EVENT.Disconnected);
    expect(engine.getState().status).toBe("error");
    await engine.leave();
    expect(engine.getState().status).toBe("idle");
    expect(engine.getState().error).toBeNull();
  });

  it("preserves mic/deafen/device preferences across leave", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.setInputDevice("mic-2");
    await engine.setMic(false);
    await engine.leave();
    expect(engine.getState().micEnabled).toBe(false);
    expect(engine.getState().selectedInputDeviceId).toBe("mic-2");
    expect(room.switchActiveDevice).toHaveBeenCalledWith("audioinput", "mic-2");
  });

  // Founder P0 (§35): the Leave button, every other control, and the NEXT join all
  // died after the far side left. Root cause — `leave()` awaited `disconnect()`,
  // which HANGS on a dead RN transport (peer already gone / flaky net / backgrounded),
  // so the FSM never reached its final `idle` reset: it wedged in "leaving" with a
  // stale `cameraEnabled`, jamming the controls (they gate on connected/room-active),
  // and blocking the next JOIN (illegal from "leaving"). Leaving must ALWAYS reach idle.
  it("reaches idle even when disconnect() never resolves (no 'leaving' wedge)", async () => {
    const room = new FakeRoom();
    let releaseDisconnect: () => void = () => {};
    room.disconnect.mockImplementationOnce(
      () => new Promise<void>((resolve) => (releaseDisconnect = resolve)),
    );
    const { engine } = setup({ room });
    await engine.join("channel-1");
    await engine.setCamera(true);
    expect(engine.getState().status).toBe("connected");
    expect(engine.getState().cameraEnabled).toBe(true);

    // Leave while the transport is dead — disconnect() will never resolve.
    await engine.leave();

    // The FSM must have reconciled to idle WITHOUT waiting on the hung disconnect,
    // and the stale live-track flag must be cleared (the "shows stop-camera on a
    // camera that was never on" symptom).
    expect(engine.getState().status).toBe("idle");
    expect(engine.getState().roomId).toBeNull();
    expect(engine.getState().cameraEnabled).toBe(false);
    expect(room.disconnect).toHaveBeenCalledOnce();

    // …and the founder can immediately re-join (JOIN is legal from idle) — controls
    // are not dead, mic can publish again. This is trigger (b): DM call → voice room.
    await engine.join("channel-2");
    expect(engine.getState().status).toBe("connected");
    expect(engine.getState().roomId).toBe("channel-2");

    releaseDisconnect(); // the background disconnect settles late; no effect on state
    await flush();
    expect(engine.getState().status).toBe("connected");
  });

  it("a remote leaving then the user pressing Leave still reaches idle", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    room.addRemote("peer-1");
    await flush();
    expect(engine.getState().participants).toHaveLength(2);

    // The far side leaves — we are alone but still connected (no status change).
    room.removeRemote("peer-1");
    await flush();
    expect(engine.getState().status).toBe("connected");
    expect(engine.getState().participants).toHaveLength(1);

    // Now WE press Leave — it must land on idle, not hang.
    await engine.leave();
    expect(engine.getState().status).toBe("idle");
    expect(engine.getState().roomId).toBeNull();
  });
});

describe("reconnect lifecycle", () => {
  it("maps Reconnecting → reconnecting and Reconnected → connected", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    room.emit(ROOM_EVENT.Reconnecting);
    expect(engine.getState().status).toBe("reconnecting");
    room.emit(ROOM_EVENT.Reconnected);
    expect(engine.getState().status).toBe("connected");
    expect(engine.getState().error).toBeNull();
  });

  it("maps Disconnected during reconnecting → error(reconnect_failed)", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    room.emit(ROOM_EVENT.Reconnecting);
    room.emit(ROOM_EVENT.Disconnected);
    expect(engine.getState().status).toBe("error");
    expect(engine.getState().error).toEqual({ kind: "reconnect_failed" });
    expect(engine.getState().participants).toEqual([]);
    expect(room.listenerCount()).toBe(0);
  });

  it("maps an unexpected Disconnected while connected → error(server_unavailable)", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    room.emit(ROOM_EVENT.Disconnected);
    expect(engine.getState().status).toBe("error");
    expect(engine.getState().error).toEqual({ kind: "server_unavailable" });
  });

  it("re-applies the mic preference after a successful reconnect", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    room.emit(ROOM_EVENT.Reconnecting);
    // Track was lost during the drop:
    room.localParticipant.isMicrophoneEnabled = false;
    room.emit(ROOM_EVENT.Reconnected);
    await flush();
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(true);
  });
});

describe("single-active-session eviction", () => {
  it("handleSessionReplaced for the current room → idle with endedReason, via the leave path", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    expect(engine.getState().status).toBe("connected");

    await engine.handleSessionReplaced("channel-1");

    expect(engine.getState().status).toBe("idle");
    expect(engine.getState().roomId).toBeNull();
    expect(engine.getState().error).toBeNull(); // a clean handoff, NOT an error
    expect(engine.getState().endedReason).toBe("session_replaced");
    expect(room.disconnect).toHaveBeenCalledTimes(1); // reused the leave path
    expect(room.listenerCount()).toBe(0); // no leaked listeners
  });

  it("handleSessionReplaced for a DIFFERENT room is ignored (the device that just joined elsewhere)", async () => {
    const { engine, room } = setup();
    await engine.join("channel-2"); // we are in channel-2 now

    // The eviction targets the OLD room (channel-1); we already moved on.
    await engine.handleSessionReplaced("channel-1");

    expect(engine.getState().status).toBe("connected");
    expect(engine.getState().roomId).toBe("channel-2");
    expect(engine.getState().endedReason).toBeNull();
    expect(room.disconnect).not.toHaveBeenCalled();
  });

  it("handleSessionReplaced while idle is a no-op", async () => {
    const { engine } = setup();
    await engine.handleSessionReplaced("channel-1");
    expect(engine.getState().status).toBe("idle");
    expect(engine.getState().endedReason).toBeNull();
  });

  it("maps a DUPLICATE_IDENTITY disconnect → clean idle (not server_unavailable)", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    room.emit(ROOM_EVENT.Disconnected, DISCONNECT_REASON.DuplicateIdentity);
    expect(engine.getState().status).toBe("idle");
    expect(engine.getState().error).toBeNull();
    expect(engine.getState().endedReason).toBe("session_replaced");
    expect(engine.getState().participants).toEqual([]);
    expect(room.listenerCount()).toBe(0);
  });

  it("maps a PARTICIPANT_REMOVED disconnect → clean idle (server-side cross-room eviction)", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    room.emit(ROOM_EVENT.Disconnected, DISCONNECT_REASON.ParticipantRemoved);
    expect(engine.getState().status).toBe("idle");
    expect(engine.getState().error).toBeNull();
    expect(engine.getState().endedReason).toBe("session_replaced");
  });

  it("leaves a normal (reasonless) disconnect as error(server_unavailable) — no false eviction", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    room.emit(ROOM_EVENT.Disconnected); // network drop, no reason
    expect(engine.getState().status).toBe("error");
    expect(engine.getState().error).toEqual({ kind: "server_unavailable" });
    expect(engine.getState().endedReason).toBeNull();
  });

  it("does not treat a failed reconnect as an eviction", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    room.emit(ROOM_EVENT.Reconnecting);
    room.emit(ROOM_EVENT.Disconnected); // reconnect gave up
    expect(engine.getState().status).toBe("error");
    expect(engine.getState().error).toEqual({ kind: "reconnect_failed" });
    expect(engine.getState().endedReason).toBeNull();
  });

  it("clears a prior eviction notice on the next join", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    room.emit(ROOM_EVENT.Disconnected, DISCONNECT_REASON.ParticipantRemoved);
    expect(engine.getState().endedReason).toBe("session_replaced");

    await engine.join("channel-1"); // retry / rejoin
    expect(engine.getState().status).toBe("connected");
    expect(engine.getState().endedReason).toBeNull();
  });

  it("clearEndedReason acks the notice", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    room.emit(ROOM_EVENT.Disconnected, DISCONNECT_REASON.DuplicateIdentity);
    expect(engine.getState().endedReason).toBe("session_replaced");
    engine.clearEndedReason();
    expect(engine.getState().endedReason).toBeNull();
  });

  it("is idempotent when the LiveKit disconnect and the gateway event both fire", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    // LiveKit kicks us first (cross-room removeParticipant) …
    room.emit(ROOM_EVENT.Disconnected, DISCONNECT_REASON.ParticipantRemoved);
    // … then the gateway's voice.session_replaced lands for the same room.
    await engine.handleSessionReplaced("channel-1");
    expect(engine.getState().status).toBe("idle");
    expect(engine.getState().endedReason).toBe("session_replaced");
    // Only the media disconnect drove the teardown; the late signal no-ops.
    expect(room.disconnect).not.toHaveBeenCalled();
  });
});

describe("alone-idle deadline (server sweep mirror)", () => {
  /** A controllable clock so the three-minute window is testable in microseconds. */
  function clock(start = 1_000_000) {
    let t = start;
    return {
      now: () => t,
      advance: (ms: number) => {
        t += ms;
      },
    };
  }

  it("NEVER arms in a server voice channel, however long you sit there alone", async () => {
    // THE critical case: the server's sweep deliberately exempts server voice
    // channels, so a countdown here would warn about a disconnect that is not
    // coming. Alone, connected, way past the window — still nothing.
    const c = clock();
    const { engine } = setup({ now: c.now });
    await engine.join("channel-1");
    engine.setSurfaceKind("server");

    expect(engine.getState().participants).toHaveLength(1); // alone
    expect(engine.getState().aloneDeadlineAt).toBeNull();

    c.advance(ALONE_GRACE_MS * 3);
    expect(engine.getState().aloneDeadlineAt).toBeNull();
  });

  it("stays disarmed while the surface is unresolved or unrecognized (fail-safe)", async () => {
    const c = clock();
    const { engine } = setup({ now: c.now });
    await engine.join("channel-1"); // nobody has pushed a surface kind yet
    expect(engine.getState().aloneDeadlineAt).toBeNull();

    engine.setSurfaceKind("unknown");
    expect(engine.getState().aloneDeadlineAt).toBeNull();

    engine.setSurfaceKind(null);
    expect(engine.getState().aloneDeadlineAt).toBeNull();
  });

  it("arms when alone in a DM call room and in a group-DM voice channel", async () => {
    for (const kind of ["call", "groupDm"] as const) {
      const c = clock();
      const { engine } = setup({ now: c.now });
      await engine.join("room-1");
      engine.setSurfaceKind(kind);
      expect(engine.getState().aloneDeadlineAt).toBe(c.now() + ALONE_GRACE_MS);
    }
  });

  it("disarms the INSTANT someone joins, and restarts a FULL window when they leave", async () => {
    const c = clock();
    const { engine, room } = setup({ now: c.now });
    await engine.join("dmcall:call-1");
    engine.setSurfaceKind("call");
    const armedAt = engine.getState().aloneDeadlineAt;
    expect(armedAt).toBe(c.now() + ALONE_GRACE_MS);

    // Somebody walks in half a window later → the warning vanishes at once.
    c.advance(ALONE_GRACE_MS / 2);
    room.addRemote("user-b");
    expect(engine.getState().aloneDeadlineAt).toBeNull();

    // …and when they leave again the clock starts from scratch, never resuming
    // the old one (this is what the server's own aloneSince bookkeeping does).
    room.removeRemote("user-b");
    expect(engine.getState().aloneDeadlineAt).toBe(c.now() + ALONE_GRACE_MS);
    expect(engine.getState().aloneDeadlineAt).not.toBe(armedAt);
  });

  it("does not push the deadline forward on unrelated participant updates", async () => {
    const c = clock();
    const { engine, room } = setup({ now: c.now });
    await engine.join("dmcall:call-1");
    engine.setSurfaceKind("call");
    const armedAt = engine.getState().aloneDeadlineAt;

    // Time passes and the local participant row churns (mute toggles etc.) —
    // a countdown that silently reset here would never actually count down.
    c.advance(30_000);
    await engine.setMic(false);
    room.emit(ROOM_EVENT.ParticipantAttributesChanged, {}, room.localParticipant);
    await flush();
    expect(engine.getState().aloneDeadlineAt).toBe(armedAt);
  });

  it("keeps the deadline across a reconnect (the SFU still holds the room)", async () => {
    const c = clock();
    const { engine, room } = setup({ now: c.now });
    await engine.join("dmcall:call-1");
    engine.setSurfaceKind("call");
    const armedAt = engine.getState().aloneDeadlineAt;

    room.emit(ROOM_EVENT.Reconnecting);
    expect(engine.getState().status).toBe("reconnecting");
    expect(engine.getState().aloneDeadlineAt).toBe(armedAt);

    room.emit(ROOM_EVENT.Reconnected);
    await flush();
    expect(engine.getState().aloneDeadlineAt).toBe(armedAt);
  });

  it("does NOT leave on its own when the window elapses — the server decides", async () => {
    const c = clock();
    const { engine, room } = setup({ now: c.now });
    await engine.join("dmcall:call-1");
    engine.setSurfaceKind("call");

    c.advance(ALONE_GRACE_MS + 90_000); // past the deadline AND past a sweep tick
    await flush();

    expect(engine.getState().status).toBe("connected");
    expect(engine.getState().roomId).toBe("dmcall:call-1");
    expect(engine.getState().endedReason).toBeNull();
    expect(room.disconnect).not.toHaveBeenCalled();
  });

  it("clears the deadline on leave and on the next join", async () => {
    const c = clock();
    const { engine } = setup({ now: c.now });
    await engine.join("dmcall:call-1");
    engine.setSurfaceKind("call");
    expect(engine.getState().aloneDeadlineAt).not.toBeNull();

    await engine.leave();
    expect(engine.getState().aloneDeadlineAt).toBeNull();

    // A new room starts with NO surface kind — the previous one must not leak.
    await engine.join("channel-2");
    expect(engine.getState().aloneDeadlineAt).toBeNull();
  });
});

describe("alone-idle eviction reason", () => {
  function clock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => void (t += ms) };
  }

  it("attributes an eviction AFTER the window to `alone`, not `session_replaced`", async () => {
    // The 1-1 DM call path: the server force-removes the lone participant but
    // signals the call's end through `call.ended`, so no voice.disconnected ever
    // names the reason. Our own elapsed deadline is the only evidence there.
    const c = clock();
    const { engine, room } = setup({ now: c.now });
    await engine.join("dmcall:call-1");
    engine.setSurfaceKind("call");

    c.advance(ALONE_GRACE_MS + 30_000);
    room.emit(ROOM_EVENT.Disconnected, DISCONNECT_REASON.ParticipantRemoved);

    expect(engine.getState().status).toBe("idle");
    expect(engine.getState().error).toBeNull();
    expect(engine.getState().endedReason).toBe("alone");
    expect(engine.getState().aloneDeadlineAt).toBeNull();
  });

  it("still says `session_replaced` when the window had NOT elapsed", async () => {
    const c = clock();
    const { engine, room } = setup({ now: c.now });
    await engine.join("dmcall:call-1");
    engine.setSurfaceKind("call");

    c.advance(ALONE_GRACE_MS - 1_000); // one second short
    room.emit(ROOM_EVENT.Disconnected, DISCONNECT_REASON.DuplicateIdentity);

    expect(engine.getState().endedReason).toBe("session_replaced");
  });

  it("handleForcedDisconnect for the current room leaves cleanly with the server's reason", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    engine.setSurfaceKind("groupDm");

    await engine.handleForcedDisconnect(["channel-1"], "alone");

    expect(engine.getState().status).toBe("idle");
    expect(engine.getState().roomId).toBeNull();
    expect(engine.getState().error).toBeNull(); // not a failure
    expect(engine.getState().endedReason).toBe("alone");
    expect(room.disconnect).toHaveBeenCalledTimes(1); // reused the leave path
    expect(room.listenerCount()).toBe(0);
  });

  it("matches on the SFU room name when the join used the channel id (upgrade case)", async () => {
    // The group's voice channel resolves server-side to `dmcall:<id>`, so the
    // server reports that room while our roomId is the channel id we joined by.
    const { engine } = setup();
    await engine.join("channel-1");
    engine.setSurfaceKind("groupDm");

    await engine.handleForcedDisconnect(["dmcall:call-1", "channel-1"], "alone");

    expect(engine.getState().status).toBe("idle");
    expect(engine.getState().endedReason).toBe("alone");
  });

  it("REFINES a pending session_replaced notice when the event loses the race", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    engine.setSurfaceKind("groupDm");

    // The SFU force-remove lands first and, with no elapsed local deadline to go
    // on, defaults to the single-session wording …
    room.emit(ROOM_EVENT.Disconnected, DISCONNECT_REASON.ParticipantRemoved);
    expect(engine.getState().endedReason).toBe("session_replaced");

    // … then the gateway event arrives and corrects it.
    await engine.handleForcedDisconnect(["channel-1"], "alone");
    expect(engine.getState().endedReason).toBe("alone");
    expect(engine.getState().status).toBe("idle");
    expect(room.disconnect).not.toHaveBeenCalled(); // no second teardown
  });

  it("does not resurrect a notice the user already dismissed", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    room.emit(ROOM_EVENT.Disconnected, DISCONNECT_REASON.ParticipantRemoved);
    engine.clearEndedReason();

    await engine.handleForcedDisconnect(["channel-1"], "alone");
    expect(engine.getState().endedReason).toBeNull();
  });

  it("ignores a forced disconnect naming a room we are not in", async () => {
    const { engine, room } = setup();
    await engine.join("channel-2");

    await engine.handleForcedDisconnect(["channel-1"], "alone");

    expect(engine.getState().status).toBe("connected");
    expect(engine.getState().roomId).toBe("channel-2");
    expect(engine.getState().endedReason).toBeNull();
    expect(room.disconnect).not.toHaveBeenCalled();
  });

  it("ignores an empty room-key list", async () => {
    const { engine } = setup();
    await engine.join("channel-1");
    await engine.handleForcedDisconnect([], "alone");
    expect(engine.getState().status).toBe("connected");
    expect(engine.getState().endedReason).toBeNull();
  });
});

describe("join with a pre-minted token (DM calls, ADR 0012 §2)", () => {
  const DM_ROOM = "dmcall:call-123";
  const CREDENTIAL = { url: "ws://livekit:7880", token: "dm-jwt" };

  it("skips fetchToken and connects with the supplied url+token", async () => {
    const { engine, room, fetchToken } = setup();
    const statuses: string[] = [];
    engine.subscribe((s: VoiceState) => statuses.push(s.status));

    const joined = engine.join(DM_ROOM, CREDENTIAL);
    expect(engine.getState().status).toBe("joining"); // set synchronously
    await joined;

    // The whole point of the pre-minted path: no POST /media/token hop.
    expect(fetchToken).not.toHaveBeenCalled();
    expect(room.connect).toHaveBeenCalledWith("ws://livekit:7880", "dm-jwt");
    expect(engine.getState().status).toBe("connected");
    // roomId = the call's LiveKit room (not a channel id) so eviction/reconnect key on it.
    expect(engine.getState().roomId).toBe(DM_ROOM);
    expect(engine.getState().error).toBeNull();
    await flush();
    expect(statuses).toContain("joining");
    expect(statuses.at(-1)).toBe("connected");
  });

  it("runs the SAME downstream path (mic publish + local participant) as a channel join", async () => {
    const { engine, room } = setup();
    await engine.join(DM_ROOM, CREDENTIAL);
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
    expect(engine.getState().micEnabled).toBe(true);
    expect(engine.getState().participants).toEqual([
      expect.objectContaining({ identity: "local-user", isLocal: true, micEnabled: true }),
    ]);
  });

  it("recovers across a reconnect on the same pre-minted room (no re-fetch, no room switch)", async () => {
    const { engine, room, fetchToken } = setup();
    await engine.join(DM_ROOM, CREDENTIAL);

    room.emit(ROOM_EVENT.Reconnecting);
    expect(engine.getState().status).toBe("reconnecting");
    room.emit(ROOM_EVENT.Reconnected);
    expect(engine.getState().status).toBe("connected");
    expect(engine.getState().roomId).toBe(DM_ROOM); // unchanged
    // LiveKit reconnects with its own stored token; the engine never re-mints and
    // never re-fetches for a pre-minted join.
    expect(fetchToken).not.toHaveBeenCalled();
    expect(room.connect).toHaveBeenCalledTimes(1);
  });

  it("single-session eviction keys on the call-room string (handleSessionReplaced)", async () => {
    const { engine, room } = setup();
    await engine.join(DM_ROOM, CREDENTIAL);

    // A voice.session_replaced for a DIFFERENT room is not us — ignored.
    await engine.handleSessionReplaced("dmcall:other-call");
    expect(engine.getState().status).toBe("connected");
    expect(engine.getState().roomId).toBe(DM_ROOM);

    // The eviction for OUR call room ends the session cleanly (a handoff, not error).
    await engine.handleSessionReplaced(DM_ROOM);
    expect(engine.getState().status).toBe("idle");
    expect(engine.getState().roomId).toBeNull();
    expect(engine.getState().error).toBeNull();
    expect(engine.getState().endedReason).toBe("session_replaced");
    expect(room.disconnect).toHaveBeenCalledTimes(1);
  });

  it("a DUPLICATE_IDENTITY disconnect on a call room → clean idle (single-session across devices)", async () => {
    const { engine, room } = setup();
    await engine.join(DM_ROOM, CREDENTIAL);
    room.emit(ROOM_EVENT.Disconnected, DISCONNECT_REASON.DuplicateIdentity);
    expect(engine.getState().status).toBe("idle");
    expect(engine.getState().error).toBeNull();
    expect(engine.getState().endedReason).toBe("session_replaced");
  });

  it("leaves the fetchToken path untouched when no credential is passed", async () => {
    const { engine, room, fetchToken } = setup();
    await engine.join("channel-9"); // group voice channel — the default path
    expect(fetchToken).toHaveBeenCalledWith("channel-9");
    expect(room.connect).toHaveBeenCalledWith("ws://test:7880", "jwt");
    expect(engine.getState().roomId).toBe("channel-9");
  });
});

describe("DM→group upgrade continuity (ADR 0012 §6)", () => {
  const CALL_ROOM = "dmcall:call-xyz";
  const CREDENTIAL = { url: "ws://livekit:7880", token: "dm-jwt" };

  it("keeps the live connection untouched when the third person joins (no teardown, no re-join)", async () => {
    const { engine, room } = setup();
    // The two originals are connected to the call room (local + the other original).
    await engine.join(CALL_ROOM, CREDENTIAL);
    room.addRemote("original-b");
    await flush();
    expect(engine.getState().participants.map((p) => p.identity).sort()).toEqual([
      "local-user",
      "original-b",
    ]);
    const connectCallsBefore = room.connect.mock.calls.length;

    // Upgrade: a third person joins the SAME LiveKit room (their new group voice
    // channel resolves livekit_room = dmcall:<callId>). For the two originals this
    // is an ORDINARY ParticipantConnected — never a reason to re-join or disconnect.
    room.addRemote("third-person");
    await flush();

    // Zero media disruption: same room, still connected, no reconnect, no leave.
    expect(engine.getState().status).toBe("connected");
    expect(engine.getState().roomId).toBe(CALL_ROOM); // NOT re-pointed to a channel id
    expect(room.connect).toHaveBeenCalledTimes(connectCallsBefore); // no second connect
    expect(room.disconnect).not.toHaveBeenCalled(); // no teardown
    expect(engine.getState().participants.map((p) => p.identity).sort()).toEqual([
      "local-user",
      "original-b",
      "third-person",
    ]);
  });

  it("survives a reconnect AFTER the upgrade on the same room (roomId never switches to a channel id)", async () => {
    const { engine, room, fetchToken } = setup();
    await engine.join(CALL_ROOM, CREDENTIAL);
    room.addRemote("third-person"); // the upgrade has happened
    await flush();

    room.emit(ROOM_EVENT.Reconnecting);
    expect(engine.getState().status).toBe("reconnecting");
    room.emit(ROOM_EVENT.Reconnected);
    expect(engine.getState().status).toBe("connected");
    // Still the ORIGINAL call room — the upgrade never changed the LiveKit room,
    // so reconnect lands back in the same room with no re-fetch.
    expect(engine.getState().roomId).toBe(CALL_ROOM);
    expect(fetchToken).not.toHaveBeenCalled();
    expect(room.connect).toHaveBeenCalledTimes(1);
  });
});

describe("participants and speaking indicators", () => {
  it("tracks remote join/leave", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    room.addRemote("user-b");
    expect(engine.getState().participants.map((p) => p.identity)).toEqual([
      "local-user",
      "user-b",
    ]);
    room.removeRemote("user-b");
    expect(engine.getState().participants.map((p) => p.identity)).toEqual([
      "local-user",
    ]);
  });

  it("marks active speakers and clears them when speakers change", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    const b = room.addRemote("user-b");
    room.emit(ROOM_EVENT.ActiveSpeakersChanged, [b]);
    expect(
      engine.getState().participants.find((p) => p.identity === "user-b")?.speaking,
    ).toBe(true);
    room.emit(ROOM_EVENT.ActiveSpeakersChanged, []);
    expect(engine.getState().participants.every((p) => !p.speaking)).toBe(true);
  });

  it("keeps the participants array referentially stable on no-op speaker ticks", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    const b = room.addRemote("user-b");
    room.emit(ROOM_EVENT.ActiveSpeakersChanged, [b]);
    const before = engine.getState().participants;
    room.emit(ROOM_EVENT.ActiveSpeakersChanged, [b]); // identical speakers
    expect(engine.getState().participants).toBe(before);
  });

  it("reuses unchanged participant row objects when one row changes", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    const b = room.addRemote("user-b");
    const beforeLocal = engine.getState().participants[0];
    b.isMicrophoneEnabled = false;
    room.emit(ROOM_EVENT.TrackMuted, { source: TRACK_SOURCE.Microphone }, b);
    const after = engine.getState().participants;
    expect(after[0]).toBe(beforeLocal); // local row untouched
    expect(after[1]?.micEnabled).toBe(false);
  });

  it("batches a burst of synchronous events into one notification", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    await flush();
    const listener = vi.fn();
    engine.subscribe(listener);
    const b = room.addRemote("user-b");
    room.addRemote("user-c");
    room.emit(ROOM_EVENT.ActiveSpeakersChanged, [b]);
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0].participants).toHaveLength(3);
  });
});

// ── local speaking detection (task #54) ─────────────────────────────────────

/** A test-controllable on-device mic meter (stands in for the WebAudio meter). */
class FakeLocalAudioMeter implements LocalAudioMeter {
  /** The level the next level() call reports — the test drives this directly. */
  value = 0;
  closed = false;
  level(): number {
    return this.value;
  }
  close(): void {
    this.closed = true;
  }
}

/**
 * A FakeRoom that ALSO exposes an on-device local mic meter — i.e. the
 * web/Electron path where the local ring is computed locally. The plain
 * FakeRoom (no createLocalAudioMeter) models the mobile/RN path that degrades
 * to server-driven speaking.
 */
class MeteredFakeRoom extends FakeRoom {
  readonly meter = new FakeLocalAudioMeter();
  meterCreated = 0;
  createLocalAudioMeter(): LocalAudioMeter | null {
    this.meterCreated += 1;
    return this.meter;
  }
}

describe("local speaking detection (task #54)", () => {
  // These tests drive the engine's 50ms mic-level poll with a virtual clock.
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The local participant's own speaking flag, as the UI reads it from state. */
  const localRing = (engine: VoiceEngine): boolean =>
    engine.getState().participants.find((p) => p.isLocal)?.speaking ?? false;

  it("lights the local ring from the on-device mic level, independent of the server", async () => {
    vi.useFakeTimers();
    const room = new MeteredFakeRoom();
    const { engine } = setup({ room });
    await engine.join("channel-1");
    expect(room.meterCreated).toBe(1); // engine opened the on-device meter on join
    expect(localRing(engine)).toBe(false);

    room.meter.value = 0.2; // user starts talking (well above the 0.05 threshold)
    vi.advanceTimersByTime(50); // first poll: attack window not yet satisfied
    expect(localRing(engine)).toBe(false);
    vi.advanceTimersByTime(50); // ~100ms sustained (< 150ms budget) → ring lights
    expect(localRing(engine)).toBe(true);

    // Proof it is on-device: the SFU reports NOBODY speaking, yet the ring holds.
    room.emit(ROOM_EVENT.ActiveSpeakersChanged, []);
    expect(localRing(engine)).toBe(true);
  });

  it("drops the local ring immediately on mute — even while the mic still reads loud", async () => {
    vi.useFakeTimers();
    const room = new MeteredFakeRoom();
    const { engine } = setup({ room });
    await engine.join("channel-1");
    room.meter.value = 0.2;
    vi.advanceTimersByTime(100);
    expect(localRing(engine)).toBe(true);

    await engine.setMic(false); // mute
    // The meter STILL reports a loud level — this proves it is the mute guard
    // that drops the ring, not the track happening to fall silent.
    room.meter.value = 0.2;
    vi.advanceTimersByTime(50); // next poll resets the detector
    expect(localRing(engine)).toBe(false);

    // Unmuting starts a fresh attack — no instant re-light from stale state.
    await engine.setMic(true);
    vi.advanceTimersByTime(50);
    expect(localRing(engine)).toBe(false);
    vi.advanceTimersByTime(50);
    expect(localRing(engine)).toBe(true);
  });

  it("forces the local ring off while reconnecting, regardless of the meter", async () => {
    vi.useFakeTimers();
    const room = new MeteredFakeRoom();
    const { engine } = setup({ room });
    await engine.join("channel-1");
    room.meter.value = 0.2;
    vi.advanceTimersByTime(100);
    expect(localRing(engine)).toBe(true);

    room.emit(ROOM_EVENT.Reconnecting);
    vi.advanceTimersByTime(50); // poll sees status !== "connected" → silent
    expect(localRing(engine)).toBe(false);
  });

  it("stops polling and closes the meter on leave (no leaked timer or audio context)", async () => {
    vi.useFakeTimers();
    const room = new MeteredFakeRoom();
    const { engine } = setup({ room });
    await engine.join("channel-1");
    room.meter.value = 0.2;
    vi.advanceTimersByTime(100);
    expect(localRing(engine)).toBe(true);

    await engine.leave();
    expect(room.meter.closed).toBe(true); // meter released
    expect(vi.getTimerCount()).toBe(0); // poll interval cleared
  });

  it("closes the meter and stops polling on an unexpected disconnect", async () => {
    vi.useFakeTimers();
    const room = new MeteredFakeRoom();
    const { engine } = setup({ room });
    await engine.join("channel-1");
    vi.advanceTimersByTime(50);
    room.emit(ROOM_EVENT.Disconnected);
    expect(engine.getState().status).toBe("error");
    expect(room.meter.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("falls back to server-driven speaking for the local user when the adapter has no meter", async () => {
    // The plain FakeRoom has no createLocalAudioMeter — the mobile/RN path.
    const { engine, room } = setup();
    await engine.join("channel-1");
    // The local user is driven by the SFU's activeSpeakersChanged like everyone else.
    room.emit(ROOM_EVENT.ActiveSpeakersChanged, [room.localParticipant]);
    expect(localRing(engine)).toBe(true);
    room.emit(ROOM_EVENT.ActiveSpeakersChanged, []);
    expect(localRing(engine)).toBe(false);
  });
});

/**
 * P0 (engine JS-thread saturation): on mobile the on-device meter drove a 20Hz
 * poll AND an unthrottled ~100Hz native→JS bridge storm (LK_VOLUME_PROCESSED),
 * which pegged the RN JS thread and froze calls. The mobile adapter now returns no
 * meter (createRNLocalAudioMeter → null), so the engine must:
 *  - run NO speaking-poll timer at all when there is no meter (removes the poll), and
 *  - keep notify/setState count DECOUPLED from tick count (no per-tick churn/GC) —
 *    the property that makes the whole media layer cheap regardless of poll rate.
 * These lock both in so the saturation can't silently regress. LOCAL_SPEAKING_POLL_MS
 * is 50 (speaking.ts) — used literally here as the rest of the meter suite does.
 */
describe("notify discipline & meter-driven JS load (P0 JS-thread saturation)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs NO on-device speaking-poll timer when the adapter exposes no meter (mobile: no meter → no 20Hz poll, no native storm)", async () => {
    vi.useFakeTimers();
    // Plain FakeRoom = the mobile path after the P0 fix: no createLocalAudioMeter,
    // no createConnectionQualityProbe → the engine must leave ZERO timers running.
    const room = new FakeRoom();
    const { engine } = setup({ room });
    await engine.join("channel-1");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a metered adapter DOES run one 20Hz poll timer — the load the mobile fix removes (contrast)", async () => {
    vi.useFakeTimers();
    const room = new MeteredFakeRoom(); // exposes createLocalAudioMeter (desktop-style)
    const { engine } = setup({ room });
    await engine.join("channel-1");
    // Exactly one interval: the LOCAL_SPEAKING_POLL_MS poll (no quality probe here).
    expect(vi.getTimerCount()).toBe(1);
  });

  it("never notifies subscribers or rebuilds participants across a storm of no-op meter ticks (notify count decoupled from tick count)", async () => {
    vi.useFakeTimers();
    const room = new MeteredFakeRoom();
    const { engine } = setup({ room });
    await engine.join("channel-1");
    room.addRemote("user-b"); // a real remote row so "no rebuild" is a strong claim
    // Constant silence — level stays below the speaking threshold, so the local
    // ring never flips and syncParticipants is never invoked from the poll.
    room.meter.value = 0;
    vi.advanceTimersByTime(50); // settle one tick
    await Promise.resolve(); // drain join/addRemote/settle notifications before counting

    const participantsBefore = engine.getState().participants;
    let notifications = 0;
    engine.subscribe(() => {
      notifications++;
    });

    // 200 poll ticks (10s @ 20Hz) — a synthetic tick storm.
    vi.advanceTimersByTime(50 * 200);
    await Promise.resolve(); // let any (unexpected) queued notify flush

    expect(notifications).toBe(0); // zero notify from 200 no-op ticks
    // Same array reference → no per-tick allocation surfaced to subscribers (no GC rain).
    expect(engine.getState().participants).toBe(participantsBefore);
  });
});

describe("mic, deafen, and devices", () => {
  it("mutes and unmutes through the room and clears errors on success", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.setMic(false);
    expect(engine.getState().micEnabled).toBe(false);
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);
    await engine.setMic(true);
    expect(engine.getState().micEnabled).toBe(true);
    expect(engine.getState().error).toBeNull();
  });

  it("surfaces a typed error and stays muted when unmute is denied", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.setMic(false);
    room.localParticipant.failNextMicWith("NotAllowedError");
    await expect(engine.setMic(true)).rejects.toBeInstanceOf(VoiceOperationError);
    expect(engine.getState().micEnabled).toBe(false);
    expect(engine.getState().error).toEqual({
      kind: "permission_denied",
      device: "microphone",
    });
  });

  it("updates the mic preference without a room while idle", async () => {
    const { engine, room } = setup();
    await engine.setMic(false);
    expect(engine.getState().micEnabled).toBe(false);
    await engine.join("channel-1");
    expect(room.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
    expect(engine.getState().micEnabled).toBe(false);
  });

  it("deafen silences all remotes and mutes the mic; undeafen restores both", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    const b = room.addRemote("user-b");
    await engine.setDeafened(true);
    expect(b.volume).toBe(0);
    expect(engine.getState()).toMatchObject({ deafened: true, micEnabled: false });
    const late = room.addRemote("user-late");
    expect(late.volume).toBe(0); // joined while deafened
    await engine.setDeafened(false);
    expect(b.volume).toBe(1);
    expect(late.volume).toBe(1);
    expect(engine.getState()).toMatchObject({ deafened: false, micEnabled: true });
  });

  it("unmuting while deafened undeafens first", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    const b = room.addRemote("user-b");
    await engine.setDeafened(true);
    await engine.setMic(true);
    expect(engine.getState()).toMatchObject({ deafened: false, micEnabled: true });
    expect(b.volume).toBe(1);
  });

  it("drives the adapter's setRemoteAudioMuted hook on deafen/undeafen (RN playout path)", async () => {
    // Per-element setVolume doesn't reach RN's native remote-audio playout, so the
    // engine ALSO calls the adapter hook; the RN adapter mutes the real subscription.
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.setDeafened(true);
    expect(room.setRemoteAudioMuted).toHaveBeenLastCalledWith(true);
    await engine.setDeafened(false);
    expect(room.setRemoteAudioMuted).toHaveBeenLastCalledWith(false);
  });

  it("restores the mic to its pre-deafen state on undeafen", async () => {
    const { engine } = setup();
    await engine.join("channel-1"); // mic on by default
    await engine.setDeafened(true);
    expect(engine.getState()).toMatchObject({ deafened: true, micEnabled: false });
    await engine.setDeafened(false);
    // Was unmuted before deafening → mic comes back on.
    expect(engine.getState()).toMatchObject({ deafened: false, micEnabled: true });

    // But if manually muted BEFORE deafening, undeafen must LEAVE it muted.
    await engine.setMic(false);
    await engine.setDeafened(true);
    await engine.setDeafened(false);
    expect(engine.getState()).toMatchObject({ deafened: false, micEnabled: false });
  });

  it("switches input/output devices through the room and stores the selection", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.setInputDevice("mic-2");
    await engine.setOutputDevice("speakers-2");
    expect(room.switchActiveDevice).toHaveBeenCalledWith("audioinput", "mic-2");
    expect(room.switchActiveDevice).toHaveBeenCalledWith("audiooutput", "speakers-2");
    expect(engine.getState().selectedInputDeviceId).toBe("mic-2");
    expect(engine.getState().selectedOutputDeviceId).toBe("speakers-2");
  });

  it("keeps the old selection and surfaces device_unavailable when a switch fails", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    room.switchActiveDevice.mockRejectedValueOnce(new Error("gone"));
    await expect(engine.setInputDevice("broken-mic")).rejects.toBeInstanceOf(
      VoiceOperationError,
    );
    expect(engine.getState().selectedInputDeviceId).toBeNull();
    expect(engine.getState().error).toEqual({
      kind: "device_unavailable",
      deviceId: "broken-mic",
      device: "microphone",
    });
  });

  it("stores device preferences while idle and applies them on join", async () => {
    const { engine, room } = setup();
    await engine.setInputDevice("mic-9");
    expect(room.switchActiveDevice).not.toHaveBeenCalled();
    await engine.join("channel-1");
    expect(room.switchActiveDevice).toHaveBeenCalledWith("audioinput", "mic-9");
  });
});

describe("deafen indicator (LiveKit participant attribute, #95)", () => {
  it("broadcasts the deafen flag as a participant attribute on toggle", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1"); // not deafened → no attribute written on join
    await flush();
    expect(room.setLocalAttribute).not.toHaveBeenCalled();

    await engine.setDeafened(true);
    await flush();
    expect(room.setLocalAttribute).toHaveBeenLastCalledWith(PARTICIPANT_ATTR.deafened, "1");
    expect(room.localAttributes[PARTICIPANT_ATTR.deafened]).toBe("1");

    await engine.setDeafened(false);
    await flush();
    // An empty value clears the attribute (livekit deletes the key).
    expect(room.setLocalAttribute).toHaveBeenLastCalledWith(PARTICIPANT_ATTR.deafened, "");
    expect(room.localAttributes[PARTICIPANT_ATTR.deafened]).toBeUndefined();
  });

  it("reflects the LOCAL user's own deafen in their participant row (§11)", async () => {
    const { engine } = setup();
    await engine.join("channel-1");
    await flush();
    expect(engine.getState().participants.find((p) => p.isLocal)?.deafened).toBe(false);

    await engine.setDeafened(true);
    await flush();
    expect(engine.getState().participants.find((p) => p.isLocal)?.deafened).toBe(true);

    await engine.setDeafened(false);
    await flush();
    expect(engine.getState().participants.find((p) => p.isLocal)?.deafened).toBe(false);
  });

  it("reflects a REMOTE's deafen from its attribute change (both directions)", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    room.addRemote("user-b");
    await flush();
    const findB = () => engine.getState().participants.find((p) => p.identity === "user-b");
    expect(findB()?.deafened).toBe(false);

    room.setRemoteAttribute("user-b", PARTICIPANT_ATTR.deafened, "1");
    await flush();
    expect(findB()?.deafened).toBe(true);

    room.setRemoteAttribute("user-b", PARTICIPANT_ATTR.deafened, "");
    await flush();
    expect(findB()?.deafened).toBe(false);
  });

  it("only re-renders the toggling remote's row on an attribute change (§27)", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    room.addRemote("user-b");
    room.addRemote("user-c");
    await flush();
    const before = engine.getState().participants;
    const cBefore = before.find((p) => p.identity === "user-c");

    room.setRemoteAttribute("user-b", PARTICIPANT_ATTR.deafened, "1");
    await flush();
    const after = engine.getState().participants;
    // b's row is a NEW object (deafened flipped); c's + local's rows are reused refs.
    expect(after.find((p) => p.identity === "user-c")).toBe(cBefore);
    expect(after.find((p) => p.identity === "user-b")?.deafened).toBe(true);
  });

  it("SEEDS a remote already deafened at connect (late joiner reads current attributes)", async () => {
    const room = new FakeRoom();
    // Preset the remote's attribute WITHOUT firing an event — it must be read from
    // the participant's current attributes during the join sync, not from a delta.
    const b = new FakeRemoteParticipant("user-b");
    b.attributes[PARTICIPANT_ATTR.deafened] = "1";
    room.remoteParticipants.set("user-b", b);
    const { engine } = setup({ room });
    await engine.join("channel-1");
    await flush();
    expect(engine.getState().participants.find((p) => p.identity === "user-b")?.deafened).toBe(
      true,
    );
  });

  it("re-asserts the deafen attribute on reconnect and on a rejoin while deafened", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.setDeafened(true);
    await flush();

    // Reconnect rebuilds the transport → re-assert "1".
    room.setLocalAttribute.mockClear();
    room.emit(ROOM_EVENT.Reconnecting);
    room.emit(ROOM_EVENT.Reconnected);
    await flush();
    expect(room.setLocalAttribute).toHaveBeenCalledWith(PARTICIPANT_ATTR.deafened, "1");

    // Deafen survives leave; rejoining must re-broadcast into the (new) room.
    await engine.leave();
    expect(engine.getState().deafened).toBe(true);
    room.setLocalAttribute.mockClear();
    await engine.join("channel-1");
    await flush();
    expect(room.setLocalAttribute).toHaveBeenCalledWith(PARTICIPANT_ATTR.deafened, "1");
  });
});

describe("per-user volume (listener-side, per remote)", () => {
  it("applies a personal volume to a connected remote and clamps to 0..2", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    const b = room.addRemote("user-b");

    engine.setParticipantVolume("user-b", 0.5);
    expect(b.volume).toBe(0.5);
    expect(engine.getParticipantVolume("user-b")).toBe(0.5);

    engine.setParticipantVolume("user-b", 5); // over the ceiling
    expect(b.volume).toBe(2);
    engine.setParticipantVolume("user-b", -3); // below the floor
    expect(b.volume).toBe(0);
  });

  it("reflects the level into the participant row; the local user stays 100%", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    room.addRemote("user-b");
    engine.setParticipantVolume("user-b", 1.5);
    await flush();

    const rows = engine.getState().participants;
    const local = rows.find((p) => p.isLocal);
    const remote = rows.find((p) => p.identity === "user-b");
    expect(local?.volume).toBe(1); // you can't attenuate yourself
    expect(remote?.volume).toBe(1.5);
  });

  it("re-applies a stored level when the participant joins LATER (late-joiner reapply)", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    // Set BEFORE the participant exists — stored, no live target yet.
    engine.setParticipantVolume("user-b", 0.25);
    const b = room.addRemote("user-b"); // ParticipantConnected → reapply
    expect(b.volume).toBe(0.25);
  });

  it("restores a saved level from persisted prefs on join (persist round-trip)", async () => {
    const room = new FakeRoom();
    const engine = createVoiceEngine({
      fetchToken: async () => ({ url: "ws://test:7880", token: "jwt" }),
      createRoom: () => room,
      initialParticipantVolumes: { "user-b": 0.4, "user-c": 5, "user-d": 1 },
    });
    // user-b already present at connect time.
    room.remoteParticipants.set("user-b", new FakeRemoteParticipant("user-b"));
    await engine.join("channel-1");
    expect(room.remoteParticipants.get("user-b")?.volume).toBe(0.4);
    // Clamp + default-drop survive the seed: 5 → 2, 1 → default (absent).
    expect(engine.getParticipantVolume("user-c")).toBe(2);
    expect(engine.getParticipantVolume("user-d")).toBe(1);
    // A later-joining seeded remote is reapplied too.
    const c = room.addRemote("user-c");
    expect(c.volume).toBe(2);
  });

  it("returns the default for an unknown participant", () => {
    const { engine } = setup();
    expect(engine.getParticipantVolume("nobody")).toBe(1);
  });

  it("composes with deafen: deafen forces 0 live, undeafen restores the personal level", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    const b = room.addRemote("user-b");
    engine.setParticipantVolume("user-b", 0.5);
    expect(b.volume).toBe(0.5);

    // Deafen is a master mute — everyone goes to 0, personal level is preserved.
    await engine.setDeafened(true);
    expect(b.volume).toBe(0);
    // Changing the personal level WHILE deafened does not un-mute the remote…
    engine.setParticipantVolume("user-b", 1.8);
    expect(b.volume).toBe(0);
    // …but undeafen restores it to the NEW personal level (not a blanket 100%).
    await engine.setDeafened(false);
    expect(b.volume).toBe(1.8);
  });

  it("re-applies personal levels (not deafen's 0) across a reconnect", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    const b = room.addRemote("user-b");
    engine.setParticipantVolume("user-b", 0.3);
    room.emit(ROOM_EVENT.Reconnecting);
    room.emit(ROOM_EVENT.Reconnected);
    expect(b.volume).toBe(0.3);
  });

  it("setting a remote back to 100% prunes the stored entry", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    const b = room.addRemote("user-b");
    engine.setParticipantVolume("user-b", 0.5);
    expect(engine.getParticipantVolume("user-b")).toBe(0.5);
    engine.setParticipantVolume("user-b", 1);
    expect(b.volume).toBe(1);
    expect(engine.getParticipantVolume("user-b")).toBe(1); // back to default (pruned)
  });
});

describe("volume apply is fault-isolated (a per-remote setVolume throw must not cascade)", () => {
  /**
   * Mirrors livekit's WEB playout path: `RemoteParticipant.setVolume` forwards to the
   * `<audio>` element's `volume` setter, which throws `IndexSizeError` for any value
   * outside [0,1] — i.e. a per-user BOOST above 100% (our range is 0..2). This is the
   * exact throw that, UNGUARDED, aborts the `applyRemoteVolumes` loop mid-room and, on
   * join, escapes before `applyMicPreference()` so the LOCAL mic never publishes.
   */
  class WebLikeRemote extends FakeRemoteParticipant {
    setVolume(volume: number, source: "microphone" | "screen_share_audio" = "microphone"): void {
      if (volume > 1) throw new RangeError("IndexSizeError: volume must be in [0,1]");
      super.setVolume(volume, source);
    }
  }

  it("a boosted remote's throw at JOIN does not silence the next remote or wedge the mic", async () => {
    const room = new FakeRoom();
    const engine = createVoiceEngine({
      fetchToken: async () => ({ url: "ws://test:7880", token: "jwt" }),
      createRoom: () => room,
      // user-a boosted to 150% (its web setVolume throws); user-b at 50% (applies cleanly).
      initialParticipantVolumes: { "user-a": 1.5, "user-b": 0.5 },
    });
    // Both present at connect; insertion order puts the THROWING remote first.
    room.remoteParticipants.set("user-a", new WebLikeRemote("user-a"));
    room.remoteParticipants.set("user-b", new FakeRemoteParticipant("user-b"));

    await expect(engine.join("channel-1")).resolves.toBeUndefined();

    // The throw on user-a must NOT abort the loop — user-b's mic level still applied.
    expect(room.remoteParticipants.get("user-b")?.volume).toBe(0.5);
    // …and must NOT escape before applyMicPreference: join is connected AND the LOCAL
    // mic actually published, so peers can hear us (the symptom-2 wedge this closes).
    expect(engine.getState().status).toBe("connected");
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
  });

  it("a boosted remote's throw via ParticipantConnected is swallowed (no unhandled throw)", async () => {
    const room = new FakeRoom();
    const engine = createVoiceEngine({
      fetchToken: async () => ({ url: "ws://test:7880", token: "jwt" }),
      createRoom: () => room,
      initialParticipantVolumes: { "user-a": 1.5 },
    });
    await engine.join("channel-1");

    // user-a joins LATE — onParticipantConnected pushes its stored 1.5 → would throw.
    const a = new WebLikeRemote("user-a");
    room.remoteParticipants.set("user-a", a);
    expect(() => room.emit(ROOM_EVENT.ParticipantConnected, a)).not.toThrow();

    // The engine stayed connected and a normal later remote still applies fine.
    const b = room.addRemote("user-b");
    expect(b.volume).toBe(1);
    expect(engine.getState().status).toBe("connected");
  });
});

describe("per-share (screen-share / film) audio volume — separate from voice", () => {
  it("scales ONLY the film-audio track, never the sharer's voice", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    const b = room.addRemote("user-b");
    b.volume = 1;
    b.screenShareVolume = 1;

    engine.setScreenShareVolume("user-b", 0.4);
    expect(b.screenShareVolume).toBe(0.4); // film turned down
    expect(b.volume).toBe(1); // voice untouched
    expect(engine.getScreenShareVolume("user-b")).toBe(0.4);

    // …and the voice slider does not touch the film level.
    engine.setParticipantVolume("user-b", 1.5);
    expect(b.volume).toBe(1.5);
    expect(b.screenShareVolume).toBe(0.4);
  });

  it("clamps to 0..2", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    const b = room.addRemote("user-b");
    engine.setScreenShareVolume("user-b", 9);
    expect(b.screenShareVolume).toBe(2);
    engine.setScreenShareVolume("user-b", -1);
    expect(b.screenShareVolume).toBe(0);
  });

  it("re-applies a stored film level when the sharer joins LATER", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    engine.setScreenShareVolume("user-b", 0.25); // before they exist
    const b = room.addRemote("user-b"); // ParticipantConnected → reapply
    expect(b.screenShareVolume).toBe(0.25);
  });

  it("restores saved film levels from persisted prefs on join (0-trap dropped)", async () => {
    const room = new FakeRoom();
    const engine = createVoiceEngine({
      fetchToken: async () => ({ url: "ws://test:7880", token: "jwt" }),
      createRoom: () => room,
      initialScreenShareVolumes: { "user-b": 0.4, "user-z": 0 },
    });
    room.remoteParticipants.set("user-b", new FakeRemoteParticipant("user-b"));
    await engine.join("channel-1");
    expect(room.remoteParticipants.get("user-b")?.screenShareVolume).toBe(0.4);
    // A persisted 0 is the mute-trap → dropped on load (reads back as default 100%).
    expect(engine.getScreenShareVolume("user-z")).toBe(1);
  });

  it("composes with deafen: film goes to 0 while deafened, restores on undeafen", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    const b = room.addRemote("user-b");
    engine.setScreenShareVolume("user-b", 0.6);
    expect(b.screenShareVolume).toBe(0.6);

    // Deafen must silence the FILM too, not just the voice (the desktop deafen bug).
    await engine.setDeafened(true);
    expect(b.screenShareVolume).toBe(0);
    expect(b.volume).toBe(0);
    // Undeafen restores the personal film level.
    await engine.setDeafened(false);
    expect(b.screenShareVolume).toBe(0.6);
  });

  it("setting the film back to 100% prunes the stored entry", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    room.addRemote("user-b");
    engine.setScreenShareVolume("user-b", 0.5);
    expect(engine.getScreenShareVolume("user-b")).toBe(0.5);
    engine.setScreenShareVolume("user-b", 1);
    expect(engine.getScreenShareVolume("user-b")).toBe(1); // default → pruned
  });

  // The RN native-playout parallel (VoiceRoomAdapter.setRemoteScreenShareVolume): on
  // React Native the per-participant setVolume can miss the film track (a second,
  // flakily-subscribed remote audio pub), so the engine ALSO routes the effective
  // per-share level through the room hook. Web omits the hook (no-op); these prove
  // the engine drives it with the right identity + effective value at every apply site.
  it("routes the film level through the RN room hook on a live drag", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    room.addRemote("user-b");
    room.setRemoteScreenShareVolume.mockClear();

    engine.setScreenShareVolume("user-b", 0.4);
    expect(room.setRemoteScreenShareVolume).toHaveBeenCalledWith("user-b", 0.4);

    // Clamp is reflected in the hook value too (0..2), not just the participant path.
    engine.setScreenShareVolume("user-b", 9);
    expect(room.setRemoteScreenShareVolume).toHaveBeenLastCalledWith("user-b", 2);
  });

  it("drives the RN hook on late-join (ParticipantConnected) with the stored level", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    engine.setScreenShareVolume("user-b", 0.25); // stored before they exist
    room.setRemoteScreenShareVolume.mockClear();

    room.addRemote("user-b"); // ParticipantConnected → engine re-applies via the hook
    expect(room.setRemoteScreenShareVolume).toHaveBeenCalledWith("user-b", 0.25);
  });

  it("drives the RN hook to 0 while deafened and restores the level on undeafen", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    const b = room.addRemote("user-b");
    engine.setScreenShareVolume("user-b", 0.6);
    void b;

    room.setRemoteScreenShareVolume.mockClear();
    await engine.setDeafened(true); // applyRemoteVolumes(true) → effective 0
    expect(room.setRemoteScreenShareVolume).toHaveBeenCalledWith("user-b", 0);

    room.setRemoteScreenShareVolume.mockClear();
    await engine.setDeafened(false); // applyRemoteVolumes(false) → personal 0.6
    expect(room.setRemoteScreenShareVolume).toHaveBeenCalledWith("user-b", 0.6);
  });

  it("does NOT drive the film hook while deafened on a live drag (deafen wins)", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    room.addRemote("user-b");
    await engine.setDeafened(true);
    room.setRemoteScreenShareVolume.mockClear();

    // A drag while deafened only stores the level; nothing is pushed to playout.
    engine.setScreenShareVolume("user-b", 0.3);
    expect(room.setRemoteScreenShareVolume).not.toHaveBeenCalled();
    expect(engine.getScreenShareVolume("user-b")).toBe(0.3); // remembered for undeafen
  });
});

describe("unexpected track loss", () => {
  it("flags track_ended_unexpectedly when the local mic track vanishes", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    room.emit(ROOM_EVENT.LocalTrackUnpublished, { source: TRACK_SOURCE.Microphone });
    expect(engine.getState().micEnabled).toBe(false);
    expect(engine.getState().error).toEqual({
      kind: "track_ended_unexpectedly",
      track: "mic",
    });
    expect(engine.getState().status).toBe("connected"); // stays in the room
  });

  it("ignores intentional mic unpublishes (mic already disabled)", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.setMic(false);
    room.emit(ROOM_EVENT.LocalTrackUnpublished, { source: TRACK_SOURCE.Microphone });
    expect(engine.getState().error).toBeNull();
  });

  it("maps MediaDevicesError to a typed device error", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    const err = new Error("boom");
    err.name = "NotFoundError";
    room.emit(ROOM_EVENT.MediaDevicesError, err);
    expect(engine.getState().error).toEqual({ kind: "device_not_found" });
    expect(engine.getState().micEnabled).toBe(false);
  });
});

describe("dispose", () => {
  it("disconnects, drops listeners, and resets to the initial state", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    const listener = vi.fn();
    engine.subscribe(listener);
    await engine.dispose();
    await flush();
    expect(room.disconnect).toHaveBeenCalled();
    expect(room.listenerCount()).toBe(0);
    expect(engine.getState().status).toBe("idle");
    expect(listener).not.toHaveBeenCalled();
  });
});

// ── connection quality / ping (task #55) ────────────────────────────────────

/** A test-controllable connection-quality probe (stands in for the livekit one). */
class FakeConnectionQualityProbe implements ConnectionQualityProbe {
  levelValue: ConnectionQualityLevel = "unknown";
  rttValue: number | null = null;
  closed = false;
  level(): ConnectionQualityLevel {
    return this.levelValue;
  }
  rttMs(): number | null {
    return this.rttValue;
  }
  close(): void {
    this.closed = true;
  }
}

/**
 * A FakeRoom that ALSO exposes a connection-quality probe — i.e. the web/RN path
 * where the ping indicator has a data source. The plain FakeRoom (no
 * createConnectionQualityProbe) models an adapter that can't sample quality and
 * so leaves it UNKNOWN (graceful degrade).
 */
class ProbedFakeRoom extends FakeRoom {
  readonly probe = new FakeConnectionQualityProbe();
  probeCreated = 0;
  createConnectionQualityProbe(): ConnectionQualityProbe | null {
    this.probeCreated += 1;
    return this.probe;
  }
}

describe("connection quality mapping (task #55)", () => {
  it("collapses livekit quality strings into coarse levels (lost → poor)", () => {
    expect(connectionQualityLevelFromLiveKit("excellent")).toBe("excellent");
    expect(connectionQualityLevelFromLiveKit("good")).toBe("good");
    expect(connectionQualityLevelFromLiveKit("poor")).toBe("poor");
    expect(connectionQualityLevelFromLiveKit("lost")).toBe("poor");
    expect(connectionQualityLevelFromLiveKit("unknown")).toBe("unknown");
    expect(connectionQualityLevelFromLiveKit("bogus")).toBe("unknown");
  });
});

describe("connection quality polling (task #55)", () => {
  // These tests drive the engine's 1s connection-quality poll with a fake clock.
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls the probe on join and mirrors level + rtt into state", async () => {
    vi.useFakeTimers();
    const room = new ProbedFakeRoom();
    const { engine } = setup({ room });
    await engine.join("channel-1");
    expect(room.probeCreated).toBe(1); // opened on join
    // Nothing reported yet → still the shared UNKNOWN summary.
    expect(engine.getState().connectionQuality).toEqual({ level: "unknown", rttMs: null });

    room.probe.levelValue = "excellent";
    room.probe.rttValue = 42;
    vi.advanceTimersByTime(CONNECTION_QUALITY_POLL_MS);
    expect(engine.getState().connectionQuality).toEqual({ level: "excellent", rttMs: 42 });
  });

  it("does not rewrite connectionQuality on unchanged ticks (§27)", async () => {
    vi.useFakeTimers();
    const room = new ProbedFakeRoom();
    const { engine } = setup({ room });
    await engine.join("channel-1");
    room.probe.levelValue = "good";
    room.probe.rttValue = 80;
    vi.advanceTimersByTime(CONNECTION_QUALITY_POLL_MS);
    const snap = engine.getState().connectionQuality;
    vi.advanceTimersByTime(CONNECTION_QUALITY_POLL_MS); // identical reading
    expect(engine.getState().connectionQuality).toBe(snap); // referentially stable
  });

  it("reports unknown quality while reconnecting, regardless of the probe", async () => {
    vi.useFakeTimers();
    const room = new ProbedFakeRoom();
    const { engine } = setup({ room });
    await engine.join("channel-1");
    room.probe.levelValue = "excellent";
    room.probe.rttValue = 30;
    vi.advanceTimersByTime(CONNECTION_QUALITY_POLL_MS);
    expect(engine.getState().connectionQuality.level).toBe("excellent");

    room.emit(ROOM_EVENT.Reconnecting);
    vi.advanceTimersByTime(CONNECTION_QUALITY_POLL_MS); // poll sees status !== connected
    expect(engine.getState().connectionQuality).toEqual({ level: "unknown", rttMs: null });
  });

  it("stops polling, closes the probe, and resets quality on leave", async () => {
    vi.useFakeTimers();
    const room = new ProbedFakeRoom();
    const { engine } = setup({ room });
    await engine.join("channel-1");
    room.probe.levelValue = "poor";
    room.probe.rttValue = 320;
    vi.advanceTimersByTime(CONNECTION_QUALITY_POLL_MS);
    expect(engine.getState().connectionQuality.level).toBe("poor");

    await engine.leave();
    expect(room.probe.closed).toBe(true); // probe released
    expect(vi.getTimerCount()).toBe(0); // poll interval cleared
    expect(engine.getState().connectionQuality).toEqual({ level: "unknown", rttMs: null });
  });

  it("closes the probe and stops polling on an unexpected disconnect", async () => {
    vi.useFakeTimers();
    const room = new ProbedFakeRoom();
    const { engine } = setup({ room });
    await engine.join("channel-1");
    vi.advanceTimersByTime(CONNECTION_QUALITY_POLL_MS);
    room.emit(ROOM_EVENT.Disconnected);
    expect(engine.getState().status).toBe("error");
    expect(room.probe.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(engine.getState().connectionQuality).toEqual({ level: "unknown", rttMs: null });
  });

  it("leaves quality unknown when the adapter has no probe (graceful degrade)", async () => {
    vi.useFakeTimers();
    const { engine } = setup(); // plain FakeRoom — no createConnectionQualityProbe
    await engine.join("channel-1");
    vi.advanceTimersByTime(CONNECTION_QUALITY_POLL_MS * 3);
    expect(engine.getState().connectionQuality).toEqual({ level: "unknown", rttMs: null });
  });
});

describe("publisher-uplink adaptive screen-share tier (#4)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Bitrate of the MOST RECENT screen-share (video) publish. */
  function lastScreenBitrate(room: FakeRoom): number {
    const screens = room.localParticipant.published.filter(
      (o) => o.source === TRACK_SOURCE.ScreenShare,
    );
    return screens[screens.length - 1]?.screenShareEncoding?.maxBitrate ?? 0;
  }

  it("drops the screen-share tier under sustained poor uplink, then restores it when the uplink recovers", async () => {
    vi.useFakeTimers();
    const room = new ProbedFakeRoom();
    const { engine } = setup({ room });
    await engine.join("channel-1");
    await engine.startScreenShare(acquireFixed(makeAssets(false)), { quality: "1440p60" });

    // Starts at the user's SELECTED 2K60 ceiling (VP9-trimmed 7 Mbps).
    expect(lastScreenBitrate(room)).toBe(7_000_000);

    // Sustained poor uplink → after the down-tick window, one downgrade republish.
    room.probe.levelValue = "poor";
    room.probe.rttValue = 400;
    await vi.advanceTimersByTimeAsync(CONNECTION_QUALITY_POLL_MS * 4);
    const dropped = lastScreenBitrate(room);
    expect(dropped).toBeLessThan(7_000_000);

    // Sustained healthy uplink → after the (slower) up-tick window, a restore step up.
    room.probe.levelValue = "excellent";
    room.probe.rttValue = 30;
    await vi.advanceTimersByTimeAsync(CONNECTION_QUALITY_POLL_MS * 10);
    expect(lastScreenBitrate(room)).toBeGreaterThan(dropped);
  });

  it("never auto-adjusts the tier when no screen share is live", async () => {
    vi.useFakeTimers();
    const room = new ProbedFakeRoom();
    const { engine } = setup({ room });
    await engine.join("channel-1");
    const before = room.localParticipant.published.length;

    room.probe.levelValue = "poor";
    room.probe.rttValue = 500;
    await vi.advanceTimersByTimeAsync(CONNECTION_QUALITY_POLL_MS * 8);
    // No share → the controller is inert; nothing is (re)published.
    expect(room.localParticipant.published.length).toBe(before);
  });
});

describe("self-monitoring (Kendini dinle)", () => {
  it("starts the monitor with NO mic/deafen change when there is no voice session", async () => {
    const { monitor, starts } = makeFakeMicMonitor();
    const { engine } = setup({ createMicMonitor: () => monitor });

    await engine.setSelfMonitoring(true);

    expect(engine.getState().selfMonitoring).toBe(true);
    expect(starts.length).toBe(1);
    // Outside a room there is nothing to feed back into, so the anti-feedback
    // policy must NOT fire — muting a user who is not in a call is nonsense.
    expect(engine.getState().micEnabled).toBe(true);
    expect(engine.getState().deafened).toBe(false);
  });

  it("hands the monitor the SAME processed chain the publish uses (filter + capture)", async () => {
    const { monitor, starts } = makeFakeMicMonitor();
    const filter = makeFakeNoiseFilter();
    const { engine } = setup({
      createMicMonitor: () => monitor,
      createNoiseFilter: () => filter,
    });
    engine.configureAudio({ ...DEFAULT_AUDIO_SETTINGS, noiseSuppression: "high" });

    await engine.setSelfMonitoring(true);

    const config = starts.at(-1)!;
    // The worklet factory must reach the monitor — otherwise the user would be
    // auditioning the RAW mic while believing they hear the "Yüksek" tier.
    expect(config.createNoiseFilter).not.toBeNull();
    // And the built-in WebRTC NS must be OFF in the monitor's capture, exactly as
    // it is on the publish, so the two are never processed differently.
    expect(config.capture?.noiseSuppression).toBe(false);
    expect(config.capture?.echoCancellation).toBe(true);
  });

  it("does not hand over a filter for the Standart tier (it is a capture constraint there)", async () => {
    const { monitor, starts } = makeFakeMicMonitor();
    const { engine } = setup({
      createMicMonitor: () => monitor,
      createNoiseFilter: () => makeFakeNoiseFilter(),
    });
    engine.configureAudio({ ...DEFAULT_AUDIO_SETTINGS, noiseSuppression: "standard" });

    await engine.setSelfMonitoring(true);

    const config = starts.at(-1)!;
    expect(config.createNoiseFilter).toBeNull();
    expect(config.capture?.noiseSuppression).toBe(true);
  });

  it("mutes + deafens in a call and restores BOTH when monitoring stops", async () => {
    const { monitor } = makeFakeMicMonitor();
    const { engine } = setup({ createMicMonitor: () => monitor });
    await engine.join("channel-1");
    expect(engine.getState().micEnabled).toBe(true);

    await engine.setSelfMonitoring(true);
    expect(engine.getState().micEnabled).toBe(false);
    expect(engine.getState().deafened).toBe(true);

    await engine.setSelfMonitoring(false);
    expect(engine.getState().selfMonitoring).toBe(false);
    expect(engine.getState().micEnabled).toBe(true);
    expect(engine.getState().deafened).toBe(false);
  });

  it("leaves an ALREADY-MUTED user muted after monitoring stops", async () => {
    const { monitor } = makeFakeMicMonitor();
    const { engine } = setup({ createMicMonitor: () => monitor });
    await engine.join("channel-1");
    await engine.setMic(false);

    await engine.setSelfMonitoring(true);
    await engine.setSelfMonitoring(false);

    // The founder's rule: an already-muted user must not come back unmuted.
    expect(engine.getState().micEnabled).toBe(false);
    expect(engine.getState().deafened).toBe(false);
  });

  it("leaves an ALREADY-DEAFENED user deafened after monitoring stops", async () => {
    const { monitor } = makeFakeMicMonitor();
    const { engine } = setup({ createMicMonitor: () => monitor });
    await engine.join("channel-1");
    await engine.setDeafened(true);

    await engine.setSelfMonitoring(true);
    await engine.setSelfMonitoring(false);

    expect(engine.getState().deafened).toBe(true);
    expect(engine.getState().micEnabled).toBe(false);
  });

  it("a deliberate unmute ends monitoring and WINS over the saved snapshot", async () => {
    const { monitor, stops } = makeFakeMicMonitor();
    const { engine } = setup({ createMicMonitor: () => monitor });
    await engine.join("channel-1");
    await engine.setMic(false); // user was muted before monitoring
    await engine.setSelfMonitoring(true);

    await engine.setMic(true);

    expect(engine.getState().selfMonitoring).toBe(false);
    expect(stops()).toBe(1);
    // The snapshot said "muted"; the explicit unmute must NOT be undone by it.
    expect(engine.getState().micEnabled).toBe(true);
    expect(engine.getState().deafened).toBe(false);
  });

  it("applies the anti-feedback policy when JOINING with monitoring already on", async () => {
    const { monitor } = makeFakeMicMonitor();
    const { engine } = setup({ createMicMonitor: () => monitor });
    await engine.setSelfMonitoring(true);
    expect(engine.getState().micEnabled).toBe(true);

    await engine.join("channel-1");

    expect(engine.getState().micEnabled).toBe(false);
    expect(engine.getState().deafened).toBe(true);
  });

  it("re-arms the monitor when the noise tier changes so the new tier is audible", async () => {
    const { monitor, starts } = makeFakeMicMonitor();
    const { engine } = setup({
      createMicMonitor: () => monitor,
      createNoiseFilter: () => makeFakeNoiseFilter(),
    });
    engine.configureAudio({ ...DEFAULT_AUDIO_SETTINGS, noiseSuppression: "standard" });
    await engine.setSelfMonitoring(true);
    expect(starts.length).toBe(1);

    engine.configureAudio({ ...DEFAULT_AUDIO_SETTINGS, noiseSuppression: "high" });
    await flush();

    expect(starts.length).toBe(2);
    expect(starts.at(-1)!.createNoiseFilter).not.toBeNull();
  });

  it("re-arms the monitor on an input-device change", async () => {
    const { monitor, starts } = makeFakeMicMonitor();
    const { engine } = setup({ createMicMonitor: () => monitor });
    await engine.setSelfMonitoring(true);

    await engine.setInputDevice("mic-2");
    await flush();

    expect(starts.length).toBe(2);
    expect(starts.at(-1)!.inputDeviceId).toBe("mic-2");
  });

  it("stops the monitor on leave — a live capture must never outlive the session", async () => {
    const { monitor, stops, running } = makeFakeMicMonitor();
    const { engine } = setup({ createMicMonitor: () => monitor });
    await engine.join("channel-1");
    await engine.setSelfMonitoring(true);
    expect(running()).toBe(true);

    await engine.leave();

    expect(stops()).toBe(1);
    expect(running()).toBe(false);
    expect(engine.getState().selfMonitoring).toBe(false);
  });

  it("stops the monitor on dispose", async () => {
    const { monitor, stops } = makeFakeMicMonitor();
    const { engine } = setup({ createMicMonitor: () => monitor });
    await engine.setSelfMonitoring(true);

    await engine.dispose();

    expect(stops()).toBe(1);
    expect(engine.getState().selfMonitoring).toBe(false);
  });

  it("stops the monitor on an unexpected disconnect", async () => {
    const { monitor, stops } = makeFakeMicMonitor();
    const { engine, room } = setup({ createMicMonitor: () => monitor });
    await engine.join("channel-1");
    await engine.setSelfMonitoring(true);

    room.emit(ROOM_EVENT.Disconnected);
    await flush();

    expect(stops()).toBe(1);
    expect(engine.getState().selfMonitoring).toBe(false);
  });

  it("rejects with a typed monitor_unavailable when the platform has no monitor", async () => {
    const { engine } = setup();

    await expect(engine.setSelfMonitoring(true)).rejects.toBeInstanceOf(VoiceOperationError);
    expect(engine.getState().selfMonitoring).toBe(false);
    expect(engine.getState().error).toEqual({ kind: "monitor_unavailable" });
  });

  it("restores the audio state when the monitor fails to capture", async () => {
    const failing: MicMonitor = {
      start: async () => {
        throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
      },
      stop: async () => {},
    };
    const { engine } = setup({ createMicMonitor: () => failing });
    await engine.join("channel-1");

    await expect(engine.setSelfMonitoring(true)).rejects.toBeInstanceOf(VoiceOperationError);

    expect(engine.getState().selfMonitoring).toBe(false);
    // A failed monitor must not leave the user silently muted + deafened.
    expect(engine.getState().micEnabled).toBe(true);
    expect(engine.getState().deafened).toBe(false);
    expect(engine.getState().error).toEqual({
      kind: "permission_denied",
      device: "microphone",
    });
  });
});

describe("camera acquisition failures map to the RIGHT device", () => {
  it("maps NotReadableError to device_in_use for the CAMERA, not an audio device", async () => {
    const room = new FakeRoom();
    room.localParticipant.setCameraEnabled = vi.fn(async () => {
      throw Object.assign(new Error("busy"), { name: "NotReadableError" });
    }) as unknown as typeof room.localParticipant.setCameraEnabled;
    const { engine } = setup({ room });
    await engine.join("channel-1");

    await expect(engine.setCamera(true)).rejects.toBeInstanceOf(VoiceOperationError);

    expect(engine.getState().error).toEqual({ kind: "device_in_use", device: "camera" });
    expect(engine.getState().cameraEnabled).toBe(false);
  });

  it("maps AbortError to device_in_use for the camera", async () => {
    const room = new FakeRoom();
    room.localParticipant.setCameraEnabled = vi.fn(async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }) as unknown as typeof room.localParticipant.setCameraEnabled;
    const { engine } = setup({ room });
    await engine.join("channel-1");

    await expect(engine.setCamera(true)).rejects.toBeInstanceOf(VoiceOperationError);
    expect(engine.getState().error).toEqual({ kind: "device_in_use", device: "camera" });
  });

  it("RETRIES unconstrained when the requested camera quality is impossible", async () => {
    const room = new FakeRoom();
    const calls: (VideoCaptureOptionsLike | undefined)[] = [];
    let first = true;
    room.localParticipant.setCameraEnabled = vi.fn(
      async (
        enabled: boolean,
        captureOptions?: VideoCaptureOptionsLike,
      ): Promise<LocalTrackPublicationLike | undefined> => {
        calls.push(captureOptions);
        if (first) {
          first = false;
          throw Object.assign(new Error("no such mode"), { name: "OverconstrainedError" });
        }
        room.localParticipant.isCameraEnabled = enabled;
        return { source: TRACK_SOURCE.Camera };
      },
    ) as unknown as typeof room.localParticipant.setCameraEnabled;

    const { engine } = setup({ room });
    await engine.join("channel-1");
    // A 1080p60 preference — exactly the desktop choice a phone camera cannot meet.
    engine.configureVideo({
      ...DEFAULT_VIDEO_SETTINGS,
      cameraQuality: "fhd",
      cameraFrameRate: 60,
    });

    await engine.setCamera(true);

    // First attempt carried the constraints, the retry dropped them entirely.
    expect(calls.length).toBe(2);
    expect(calls[0]).toBeDefined();
    expect(calls[1]).toBeUndefined();
    // The camera is ON and no error is left behind — a phone must not be told to
    // "pick another audio device" because it cannot do 1080p60.
    expect(engine.getState().cameraEnabled).toBe(true);
    expect(engine.getState().error).toBeNull();
  });

  it("does NOT retry a permission denial (the retry would fail identically)", async () => {
    const room = new FakeRoom();
    const setCamera = vi.fn(async () => {
      throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
    });
    room.localParticipant.setCameraEnabled =
      setCamera as unknown as typeof room.localParticipant.setCameraEnabled;
    const { engine } = setup({ room });
    await engine.join("channel-1");
    engine.configureVideo({ ...DEFAULT_VIDEO_SETTINGS, cameraQuality: "fhd" });

    await expect(engine.setCamera(true)).rejects.toBeInstanceOf(VoiceOperationError);

    expect(setCamera).toHaveBeenCalledTimes(1);
    expect(engine.getState().error).toEqual({
      kind: "permission_denied",
      device: "camera",
    });
  });
});

describe("bandwidth pressure (watch party & friends)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The publish options of the MOST RECENT camera enable. */
  function lastCameraPublish(room: FakeRoom): VideoPublishOptionsLike | undefined {
    const calls = room.localParticipant.setCameraEnabled.mock.calls;
    for (let i = calls.length - 1; i >= 0; i -= 1) {
      if (calls[i]?.[0] === true) return calls[i]?.[2];
    }
    return undefined;
  }

  /** The capture options of the MOST RECENT camera enable. */
  function lastCameraCapture(room: FakeRoom): VideoCaptureOptionsLike | undefined {
    const calls = room.localParticipant.setCameraEnabled.mock.calls;
    for (let i = calls.length - 1; i >= 0; i -= 1) {
      if (calls[i]?.[0] === true) return calls[i]?.[1];
    }
    return undefined;
  }

  it("constrains the camera capture + publish ceiling while pressure is held", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    engine.configureVideo({ ...DEFAULT_VIDEO_SETTINGS, cameraQuality: "fhd" });
    await engine.setCamera(true);
    // Baseline: the user's 1080p tier at its full 5 Mbps ceiling.
    expect(lastCameraPublish(room)?.videoEncoding?.maxBitrate).toBe(5_000_000);

    engine.setBandwidthPressure(BANDWIDTH_SOURCE_WATCH_PARTY, true);
    await flush();

    // Live camera is republished small: 360p capture at the 800 kbps ceiling.
    expect(lastCameraCapture(room)).toEqual({
      resolution: { width: 640, height: 360, frameRate: 30 },
    });
    expect(lastCameraPublish(room)?.videoEncoding?.maxBitrate).toBe(
      PRESSURE_CAMERA_MAX_BITRATE_BPS,
    );
    // The camera must still be ON and un-errored — a republish is not a track-end.
    expect(engine.getState().cameraEnabled).toBe(true);
    expect(engine.getState().error).toBeNull();
  });

  it("restores the user's own camera tier when the pressure is released", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    engine.configureVideo({ ...DEFAULT_VIDEO_SETTINGS, cameraQuality: "fhd" });
    await engine.setCamera(true);
    engine.setBandwidthPressure(BANDWIDTH_SOURCE_WATCH_PARTY, true);
    await flush();
    expect(lastCameraPublish(room)?.videoEncoding?.maxBitrate).toBe(
      PRESSURE_CAMERA_MAX_BITRATE_BPS,
    );

    engine.setBandwidthPressure(BANDWIDTH_SOURCE_WATCH_PARTY, false);
    await flush();

    expect(lastCameraCapture(room)).toEqual({
      resolution: { width: 1920, height: 1080, frameRate: 30 },
    });
    expect(lastCameraPublish(room)?.videoEncoding?.maxBitrate).toBe(5_000_000);
    expect(engine.getState().cameraEnabled).toBe(true);
  });

  it("applies the constrained tier to a camera turned on DURING pressure", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    engine.configureVideo({ ...DEFAULT_VIDEO_SETTINGS, cameraQuality: "fhd" });
    engine.setBandwidthPressure(BANDWIDTH_SOURCE_WATCH_PARTY, true);

    await engine.setCamera(true);

    expect(lastCameraPublish(room)?.videoEncoding?.maxBitrate).toBe(
      PRESSURE_CAMERA_MAX_BITRATE_BPS,
    );
  });

  it("NEVER lowers a selection that is already lighter than the constrained tier", () => {
    // min(selected, pressure) — pressure may only ever lower, never raise.
    const lighter = constrainedCameraPublishOptions({
      videoEncoding: { maxBitrate: 400_000, maxFramerate: 15 },
    });
    expect(lighter.videoEncoding?.maxBitrate).toBe(400_000);
    expect(lighter.videoEncoding?.maxFramerate).toBe(15);
  });

  it("ref-counts sources: releasing one holder does not lift another's pressure", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    engine.configureVideo({ ...DEFAULT_VIDEO_SETTINGS, cameraQuality: "fhd" });
    await engine.setCamera(true);

    engine.setBandwidthPressure(BANDWIDTH_SOURCE_WATCH_PARTY, true);
    engine.setBandwidthPressure("big-upload", true);
    await flush();
    room.localParticipant.setCameraEnabled.mockClear();

    // Releasing ONE source leaves the other holding pressure → no republish at all.
    engine.setBandwidthPressure(BANDWIDTH_SOURCE_WATCH_PARTY, false);
    await flush();
    expect(room.localParticipant.setCameraEnabled).not.toHaveBeenCalled();

    // Releasing the LAST one restores the user's tier.
    engine.setBandwidthPressure("big-upload", false);
    await flush();
    expect(lastCameraPublish(room)?.videoEncoding?.maxBitrate).toBe(5_000_000);
  });

  it("is idempotent per source (a repeated declare does not churn the camera)", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    await engine.setCamera(true);
    engine.setBandwidthPressure(BANDWIDTH_SOURCE_WATCH_PARTY, true);
    await flush();
    room.localParticipant.setCameraEnabled.mockClear();

    engine.setBandwidthPressure(BANDWIDTH_SOURCE_WATCH_PARTY, true);
    engine.setBandwidthPressure(BANDWIDTH_SOURCE_WATCH_PARTY, true);
    await flush();

    expect(room.localParticipant.setCameraEnabled).not.toHaveBeenCalled();
  });

  it("does not touch the camera when it is OFF", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1"); // camera off
    room.localParticipant.setCameraEnabled.mockClear();

    engine.setBandwidthPressure(BANDWIDTH_SOURCE_WATCH_PARTY, true);
    await flush();

    expect(room.localParticipant.setCameraEnabled).not.toHaveBeenCalled();
  });

  // ── the non-negotiable: audio is never the thing we sacrifice (§6) ────────
  it("NEVER throttles audio — mic publish is byte-for-byte identical under pressure", async () => {
    const withPressure = setup();
    await withPressure.engine.join("channel-1");
    withPressure.engine.configureAudio(DEFAULT_AUDIO_SETTINGS);
    withPressure.engine.setBandwidthPressure(BANDWIDTH_SOURCE_WATCH_PARTY, true);
    await withPressure.engine.setMic(false);
    await withPressure.engine.setMic(true);

    const without = setup();
    await without.engine.join("channel-1");
    without.engine.configureAudio(DEFAULT_AUDIO_SETTINGS);
    await without.engine.setMic(false);
    await without.engine.setMic(true);

    const pressuredMic =
      withPressure.room.localParticipant.setMicrophoneEnabled.mock.calls.at(-1);
    const plainMic = without.room.localParticipant.setMicrophoneEnabled.mock.calls.at(-1);
    // Same capture constraints AND the same publish bitrate — pressure is a
    // VIDEO-only lever. If this ever diverges, voice is being sacrificed.
    expect(pressuredMic?.[1]).toEqual(plainMic?.[1]);
    expect(pressuredMic?.[2]).toEqual(plainMic?.[2]);
    expect(withPressure.engine.getState().micEnabled).toBe(true);
  });

  it("does not deafen, mute, or drop any audio subscription under pressure", async () => {
    const { engine } = setup();
    await engine.join("channel-1");
    engine.setBandwidthPressure(BANDWIDTH_SOURCE_WATCH_PARTY, true);
    await flush();

    expect(engine.getState().micEnabled).toBe(true);
    expect(engine.getState().deafened).toBe(false);
    expect(engine.getState().status).toBe("connected");
  });

  // ── behaviour with NO signal must be exactly what shipped before ──────────
  it("changes nothing at all when no source ever declares pressure", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    engine.configureVideo({ ...DEFAULT_VIDEO_SETTINGS, cameraQuality: "fhd" });
    await engine.setCamera(true);

    expect(room.localParticipant.setCameraEnabled).toHaveBeenLastCalledWith(
      true,
      { resolution: { width: 1920, height: 1080, frameRate: 30 } },
      {
        videoEncoding: { maxBitrate: 5_000_000, maxFramerate: 30 },
        simulcast: true,
        videoSimulcastLayers: [CAMERA_LOW_SIMULCAST_LAYER],
        degradationPreference: "balanced",
      },
    );
  });

  it("ignores an empty source key (it could never be released)", async () => {
    const { engine, room } = setup();
    await engine.join("channel-1");
    engine.configureVideo({ ...DEFAULT_VIDEO_SETTINGS, cameraQuality: "fhd" });
    engine.setBandwidthPressure("   ", true);
    await engine.setCamera(true);

    expect(lastCameraPublish(room)?.videoEncoding?.maxBitrate).toBe(5_000_000);
  });

  it("lets the adaptive screen-share controller shed BELOW its normal floor under pressure", async () => {
    vi.useFakeTimers();
    const room = new ProbedFakeRoom();
    const { engine } = setup({ room });
    await engine.join("channel-1");
    await engine.startScreenShare(acquireFixed(makeAssets(false)), { quality: "1440p60" });

    const screenBitrate = (): number => {
      const screens = room.localParticipant.published.filter(
        (o) => o.source === TRACK_SOURCE.ScreenShare,
      );
      return screens[screens.length - 1]?.screenShareEncoding?.maxBitrate ?? 0;
    };

    engine.setBandwidthPressure(BANDWIDTH_SOURCE_WATCH_PARTY, true);
    room.probe.levelValue = "poor";
    room.probe.rttValue = 500;
    // Long sustained congestion: without pressure the controller stops at the
    // 720p30 floor (2.5 Mbps); under pressure it may reach 480p30 (1.2 Mbps).
    await vi.advanceTimersByTimeAsync(CONNECTION_QUALITY_POLL_MS * 40);

    expect(screenBitrate()).toBeLessThan(2_500_000);
  });
});
