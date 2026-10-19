/**
 * Voice store — REAL LiveKit engine (Milestone 3 / Phase A3).
 *
 * The FSM and all media lifecycle live in `@demli/media`
 * (`createVoiceEngine`). This store is a thin zustand mirror of the engine's
 * `VoiceState` plus the command methods the UI already calls. It owns no voice
 * logic of its own — no timers, no simulated participants, no ad-hoc booleans
 * (CLAUDE.md §11). Media frames flow over WebRTC/LiveKit only; the token is the
 * one HTTP round-trip (POST /media/token), never a WebSocket frame (§35).
 *
 * State shape is `VoiceState` from @demli/media (imported, never
 * re-declared), extended with a derived user-facing `errorMessage` (§26) and
 * the command methods. UI components only read this store, so they keep working.
 */

import { useSyncExternalStore } from "react";
import { create } from "zustand";
import {
  BANDWIDTH_SOURCE_WATCH_PARTY,
  createVoiceEngine,
  ELEMENT_PLAYBACK_MAX_VOLUME,
  initialVoiceState,
  InvalidVoiceCommandError,
  voiceEndedReasonFromEvent,
  voiceErrorMessage,
  VoiceOperationError,
  type RemoteCamera,
  type RemoteScreenShare,
  type VoiceState,
  type VoiceTokenGrant,
} from "@demli/media";
// livekit-client is reachable only via the /web entry — the @demli/media
// root stays RN-safe (ADR 0002). Desktop injects this as the engine's createRoom.
import { createLiveKitRoom, createWebMicMonitor } from "@demli/media/web";
// The desktop RNNoise worklet factory for the "Yüksek" NS tier (bundles the worklet
// + WASM). Injected as the engine's createNoiseFilter — mobile omits it.
import { createRnnoiseFilter } from "../lib/noise-filter";
import { resolveVoiceSurfaceKind } from "../lib/voice-surface";
import type { CallVoiceEngine } from "@demli/client-core";
import type { ChannelId } from "@demli/types";
import { api } from "../lib/api-client";
import {
  loadScreenSharePrefs,
  makeScreenShareAcquire,
  superviseFilmAudio,
  type FilmAudioStatus,
  type ScreenShareStartOptions,
} from "../lib/screen-share";
import { useMediaSettings } from "./media-settings";
import {
  loadPersistedParticipantVolumes,
  useParticipantVolumes,
} from "./participant-volume-store";
import {
  loadPersistedScreenShareVolumes,
  useScreenShareVolumes,
} from "./screen-share-volume-store";
import { setLocalScreenPreviewTrack } from "./local-screen-preview-store";
// Read-only: the watch-party projection is one of the two inputs to the engine's
// bandwidth-pressure signal (see syncBandwidthPressure below). watch-party-store
// imports nothing from here, so this direction stays acyclic.
import { useWatchPartyStore } from "./watch-party-store";

/** Which ladder tier produced the film audio (mirrors AcquiredScreenShare). */
type AcquiredFilmSource = "process" | "loopback" | `mixinput:${string}` | null;

/**
 * Teardown handle for the live film-audio supervisor. Module-level (not store
 * state) because it owns an AudioContext + timers — imperative resources that
 * are not React state (§27). Exactly one share can be live at a time, so one
 * handle suffices; it MUST be stopped on every teardown path or the watcher's
 * AudioContext leaks past the share.
 */
let filmAudioSupervisorStop: (() => void) | null = null;

function stopFilmAudioSupervisor(): void {
  filmAudioSupervisorStop?.();
  filmAudioSupervisorStop = null;
}

/**
 * UI-side label for the room we are connected to, captured at JOIN time so the
 * voice panel names the room correctly even while the user is looking at a
 * DIFFERENT group (where a channel-list lookup would miss it, task #2). Not
 * engine state — purely a display aid mirrored in this store.
 */
export interface VoiceRoomLabel {
  channelName: string;
  groupName: string | null;
}

interface VoiceStore extends VoiceState {
  /** Derived from `error` via voiceErrorMessage — safe to render directly (§26). */
  errorMessage: string | null;
  /**
   * The connected room's display label, set at join and cleared when idle. Lets
   * the voice panel show the right channel name from any surface (task #2).
   */
  roomLabel: VoiceRoomLabel | null;
  /**
   * True when the user ASKED to share system/film audio but the loopback capture
   * produced no usable track, so the share went out video-only — the founder's
   * "viewers hear nothing" case. Surfaced as a PROMINENT, actionable warning (§26/§35
   * — no silent dead-behavior) instead of the old console-only note. Set by the
   * acquire callback, cleared on the next share / when the share ends. Distinct from
   * `screenShareHasAudio` (which is also false when the user deliberately shared with
   * audio OFF — that is NOT a failure and must not warn).
   */
  screenShareSystemAudioFailed: boolean;
  /** Aktif film-sesi kaynağı etiketi (teşhis; VoicePanel gösterir). */
  screenShareAudioSource: string | null;
  /**
   * Film sesinin GERÇEKTEN duyulup duyulmadığı (supervisor doğrular):
   *  - "unavailable": hiç film-sesi track'i yok → izleyiciler kesin duymuyor.
   *  - "searching": track yayında ama henüz ses taşımadı. Paylaşımın hemen
   *    ardından NORMAL durum — kullanıcı henüz oynat'a basmadı. Hata değil.
   *  - "live": gerçek sinyal ölçüldü → film izleyicilere gidiyor.
   * `screenShareHasAudio` yalnız "track var" der; panel bu alanı kullanmalı ki
   * duyulmayan bir yayın "sesli paylaşıyorsun" diye yalan söylemesin (§35).
   */
  screenShareAudioStatus: FilmAudioStatus;
  /**
   * Join a voice channel (fetches a token, connects the engine). Fire-and-forget.
   * `options.audioBitrateKbps` (the channel's configured mic bitrate, M7c) is
   * applied to this join's mic publish; null/omitted uses the media default.
   * `options.label` is the channel/group name captured for the voice panel so it
   * reads correctly from any surface (task #2).
   */
  join: (
    channelId: ChannelId,
    options?: { audioBitrateKbps?: number | null; label?: VoiceRoomLabel | null },
  ) => void;
  /** Leave the current room and return to idle. */
  leave: () => void;
  /**
   * Single-active-session eviction from the realtime gateway
   * (`voice.session_replaced`): the user joined voice on another device, so leave
   * `roomId`. Engine-guarded — a no-op unless we are actually in that room (the
   * device that just joined ignores it). Fire-and-forget.
   */
  sessionReplaced: (roomId: string) => void;
  /**
   * A server-authored voice disconnect (`voice.disconnected`) naming its reason —
   * today `alone`, the last person left in a DM call / group-DM voice channel for
   * the idle window. Engine-guarded (a signal for a room we are not in is
   * ignored) and race-tolerant: when the SFU force-remove already ended the
   * session, this only corrects the wording of the pending notice.
   *
   * Both ids are passed because they are two names for the SAME session and the
   * engine's `roomId` is whichever one the join used — a voice channel that
   * resolves to a call room is joined by channel id while the server reports the
   * SFU room (ADR 0012 §6). Fire-and-forget.
   */
  voiceDisconnected: (payload: { roomId: string; channelId: string; reason: string }) => void;
  /** Clear the eviction notice after the UI has surfaced it (ack). */
  acknowledgeSessionReplaced: () => void;
  /** Toggle mic (unmuting while deafened undeafens; engine-owned). */
  toggleMic: () => void;
  /**
   * Set the mic on/off directly (not a toggle). Drives push-to-talk: hold →
   * setMicActive(true), release → setMicActive(false). Also used to mute/unmute
   * when the input mode changes. Engine-owned; fire-and-forget.
   */
  setMicActive: (enabled: boolean) => void;
  /** Toggle deafen (deafening also mutes the mic; engine-owned). */
  toggleDeafen: () => void;
  setInputDevice: (deviceId: string) => void;
  setOutputDevice: (deviceId: string) => void;
  /**
   * Set the LISTENER's personal playback volume for one REMOTE participant, 0..2
   * (kişi-başı ses seviyesi). Engine-owned + written through to the
   * persist store so the level survives a relaunch. Client-side only — nothing
   * crosses the SFU/WebSocket (§10/§35). No-op on the local user (guarded by the UI).
   */
  setParticipantVolume: (userId: string, volume: number) => void;
  /**
   * Set the LISTENER's personal volume for a remote's SCREEN-SHARE (film) audio,
   * 0..2 — SEPARATE from that person's voice (task #82, the share volume).
   * Engine-owned + written through to its own persist store; client-side only.
   * No-op on the local user (guarded by the UI).
   */
  setScreenShareVolume: (userId: string, volume: number) => void;
  /**
   * Start sharing the given desktop source (screen/window id from the picker)
   * with the user's share options (quality preset + system-audio toggle, M8).
   * Acquisition (Electron capture bridge + getDisplayMedia + loopback fallback)
   * happens in `lib/screen-share`; the engine publishes the tracks with the
   * preset's encoder ceiling. Omitted options fall back to the persisted
   * preferences. Fire-and-forget.
   */
  startScreenShare: (sourceId: string, options?: ScreenShareStartOptions) => void;
  /** Stop the local screen share. */
  stopScreenShare: () => void;
  /**
   * Toggle the local camera (task #18). Independent of mic and screen share —
   * all three can be on at once. Connected-only; the engine surfaces permission
   * / device errors through `error` (§26) like every other media command.
   */
  toggleCamera: () => void;
  /**
   * Pick the camera device. Applied live when the camera is on, stored as the
   * `selectedVideoDeviceId` preference otherwise — engine-owned, mirrors the
   * mic/output device commands.
   */
  setVideoDevice: (deviceId: string) => void;
  /**
   * Toggle "Kendini dinle" (self-monitoring). Engine-owned: inside a call it
   * mutes + deafens first (anti-feedback) and restores the previous state on the
   * way out; outside a call it is a plain preview. Fire-and-forget — failures
   * land in `error` / `errorMessage` like every other media command (§26).
   */
  toggleSelfMonitoring: () => void;
}

/**
 * The single voice engine for the app lifetime. `fetchToken` is the only
 * HTTP hop — it maps POST /media/token to the { url, token } grant the engine
 * needs; identity/room are derived server-side from the session + channel.
 */
async function fetchToken(channelId: string): Promise<VoiceTokenGrant> {
  const grant = await api.getMediaToken(channelId);
  return { url: grant.url, token: grant.token };
}

const engine = createVoiceEngine({
  fetchToken,
  createRoom: createLiveKitRoom,
  // Desktop "Yüksek (Krisp benzeri)" noise suppression — the engine attaches this
  // RNNoise worklet to the live mic only while the effective NS tier is `high`.
  createNoiseFilter: createRnnoiseFilter,
  // "Kendini dinle" (Ayarlar → Mikrofon): plays the local mic back through the
  // SAME capture constraints + RNNoise worklet the publish uses, so the user can
  // hear what the Gürültü Engelleme tier actually sends. Web/Electron only.
  createMicMonitor: createWebMicMonitor,
  // Remote audio plays through <audio> elements here, which cannot go above 100%;
  // the engine clamps every level to that so the slider never shows a boost that
  // is not playing.
  maxParticipantVolume: ELEMENT_PLAYBACK_MAX_VOLUME,
  // Restore the per-user volumes (userId → 0..1) so a saved level
  // re-applies the instant that user is next in voice. Read synchronously from
  // the persist store (localStorage rehydrates sync), so the engine has them
  // before the first join. The engine remains the runtime source of truth (§11).
  initialParticipantVolumes: loadPersistedParticipantVolumes(),
  // Separate per-share (film) audio levels — the share volume (task #82).
  initialScreenShareVolumes: loadPersistedScreenShareVolumes(),
});

/**
 * Push the persisted USER media settings (Ayarlar → Mikrofon / görüntü) into the
 * engine (the single source of truth for capture constraints). Runs once at load
 * and again whenever the settings change; `configureAudio` re-applies to a live
 * mic track when connected, so a Müzik Modu toggle takes effect mid-call.
 */
function applyMediaSettings(): void {
  const { audio, video } = useMediaSettings.getState();
  engine.configureAudio(audio);
  engine.configureVideo(video);
}
applyMediaSettings();
useMediaSettings.subscribe(applyMediaSettings);

/**
 * DM-call engine adapter (ADR 0012 Wave 6). The call controller
 * (`lib/call-controller`) drives the SAME LiveKit engine this store mirrors, but
 * with a PRE-MINTED credential (join-with-token, ADR 0012 §2) and the join
 * promise surfaced so the controller can withdraw a call whose media never came
 * up. It applies the same pre-join setup as the store's own `join` — reset the
 * per-channel bitrate to the media default and, under push-to-talk, join muted —
 * so a call obeys the user's input-mode preference. Everything else
 * (mute/deafen/camera/screen/reconnect) flows through this store unchanged,
 * because the engine's state is mirrored below regardless of who called join.
 */
/**
 * Wait until the engine leaves a TRANSIENT status, so the next command is legal.
 * Resolves immediately when the predicate already holds; gives up after
 * `timeoutMs` so a wedged engine can never hang a call action forever (the join
 * that follows will then fail loudly instead of silently never happening).
 */
function waitForVoiceStatus(
  accept: (status: VoiceState["status"]) => boolean,
  timeoutMs = 4_000,
): Promise<void> {
  if (accept(engine.getState().status)) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearTimeout(timer);
      resolve();
    };
    const unsubscribe = engine.subscribe((s) => {
      if (accept(s.status)) finish();
    });
    const timer = setTimeout(finish, timeoutMs);
  });
}

export const callEngine: CallVoiceEngine = {
  async join(roomName, credential) {
    // A DM-call join (start / accept / accept-and-switch) can fire while the user
    // is ALREADY in a voice session — most often a server voice room (the founder's
    // constant state). JOIN is illegal from a live status (§11 FSM: JOIN ∈
    // {idle, error}); calling engine.join straight through then throws
    // InvalidVoiceCommandError, which broke EVERY call for a user already in voice
    // (founder P0, 0.0.34 — outgoing AND accept crash/freeze). Mirror the store's
    // own channel `join`: leave the current room first so the engine is idle before
    // we join the call room. Usually a no-op — the shared accept() already leaves
    // ahead of minting — but it also covers the caller (startCall) path, which
    // hands its join straight to this adapter without a controller-side leave.
    const { status } = engine.getState();
    if (status === "connected" || status === "joining" || status === "reconnecting") {
      await engine.leave();
    } else if (status === "leaving") {
      // A leave already in flight (the user hit Leave, or a previous call action
      // started one) — LEAVE is illegal from "leaving" and so is JOIN, so calling
      // either right now throws InvalidVoiceCommandError and the accept/start dies
      // silently mid-way: the row is live server-side, this device has no media
      // (call-UX plan K2.8, the founder's "kabul etti ama bağlanmadı"). Wait the
      // teardown out instead; `leave()` always reaches idle.
      await waitForVoiceStatus((s) => s !== "leaving");
    }
    engine.setAudioBitrateKbps(null);
    if (useMediaSettings.getState().audio.inputMode === "push_to_talk") {
      await engine.setMic(false);
    }
    await engine.join(roomName, credential);
  },
  leave() {
    return engine.leave();
  },
  /**
   * The platform's honest answer to "is media up on this room?" (K2.3). Read from
   * the voice FSM, not from a controller-side assumption, so an eviction or a dead
   * transport is visible: a call FSM that says `active` over an engine that is
   * `idle`/`error` is the state the resync path must repair.
   */
  isConnectedTo(roomName) {
    const { status, roomId } = engine.getState();
    if (roomId !== roomName) return false;
    return status === "connected" || status === "joining" || status === "reconnecting";
  },
};

/**
 * Await a full voice teardown for an account switch (ADR 0013 step 2,
 * `voiceLeaveDispose`). Calls `engine.leave()` — which ALWAYS reaches idle,
 * releasing the LiveKit room, mic, screen tracks and noise worklets — and awaits
 * it so teardown completes before the switch tears the WebSocket down (the old
 * token must still be valid while the gateway releases the SFU participant).
 *
 * Deliberately does NOT call `engine.dispose()`: this engine is an app-lifetime
 * singleton and `dispose()` clears its listener set, which would permanently sever
 * this store's live subscription and break voice for the NEXT account. `leave()`
 * releases every media resource without killing the singleton — exactly what a
 * mid-session switch needs (dispose is for renderer unmount only).
 */
export async function leaveVoiceForReset(): Promise<void> {
  const { status } = engine.getState();
  if (status === "idle" || status === "leaving") return;
  await engine.leave();
}

/** Statuses in which we are actively in (or moving into) a room. */
function isActive(status: VoiceState["status"]): boolean {
  return status === "connected" || status === "joining" || status === "reconnecting";
}

/**
 * Media-layer failures already land in `engine.getState().error` (mirrored
 * below), so a thrown `VoiceOperationError` is a duplicate — swallow it to
 * avoid an unhandled rejection. An `InvalidVoiceCommandError` is a timing race
 * (e.g. a click during a transition) — harmless, just log. Anything else is
 * unexpected and worth surfacing to the console.
 */
function reportVoiceError(err: unknown): void {
  if (err instanceof VoiceOperationError) return;
  if (err instanceof InvalidVoiceCommandError) {
    console.warn(`[voice] ${err.message}`);
    return;
  }
  console.error("[voice] unexpected error", err);
}

export const useVoiceStore = create<VoiceStore>()(() => ({
  ...initialVoiceState,
  errorMessage: null,
  roomLabel: null,
  screenShareSystemAudioFailed: false,
  screenShareAudioSource: null,
  screenShareAudioStatus: "unavailable",

  join: (channelId, options) => {
    const { roomId, status } = engine.getState();
    // Already in (or joining/reconnecting to) this exact room — no-op.
    if (roomId === channelId && isActive(status)) return;
    // Capture the display label synchronously so the panel names the room
    // immediately, independent of which group the user is viewing (task #2).
    useVoiceStore.setState({ roomLabel: options?.label ?? null });
    void (async () => {
      try {
        // Switching rooms while active: leave the old one first (JOIN is only
        // legal from idle/error). From idle/error we join straight through
        // (engine allows JOIN as a retry from error).
        if (isActive(status)) await engine.leave();
        // Apply the channel's configured mic bitrate before the join publishes
        // the mic track (null = media default). Engine-owned; we only call it.
        // The engine takes the HIGHER of this and the user's audio-quality tier.
        engine.setAudioBitrateKbps(options?.audioBitrateKbps ?? null);
        // Push-to-talk (Bas-Konuş): join muted so nothing transmits until the
        // user holds the PTT key (open-mic / voice-activity join per preference).
        if (useMediaSettings.getState().audio.inputMode === "push_to_talk") {
          await engine.setMic(false);
        }
        await engine.join(channelId);
      } catch (err) {
        reportVoiceError(err);
      }
    })();
  },

  leave: () => {
    const { status } = engine.getState();
    if (status === "idle" || status === "leaving") return;
    void engine.leave().catch(reportVoiceError);
  },

  sessionReplaced: (roomId) => {
    void engine.handleSessionReplaced(roomId).catch(reportVoiceError);
  },

  voiceDisconnected: ({ roomId, channelId, reason }) => {
    const ended = voiceEndedReasonFromEvent(reason);
    // An unmapped reason (a future enum value, or `moderator` — whose notice is
    // the moderation wave's to own) is left to the existing paths rather than
    // guessed at. Doing nothing keeps today's behavior; inventing copy would not.
    if (!ended) return;
    void engine.handleForcedDisconnect([roomId, channelId], ended).catch(reportVoiceError);
  },

  acknowledgeSessionReplaced: () => {
    engine.clearEndedReason();
  },

  toggleMic: () => {
    const { micEnabled } = engine.getState();
    void engine.setMic(!micEnabled).catch(reportVoiceError);
  },

  setMicActive: (enabled) => {
    void engine.setMic(enabled).catch(reportVoiceError);
  },

  toggleDeafen: () => {
    const { deafened } = engine.getState();
    void engine.setDeafened(!deafened).catch(reportVoiceError);
  },

  toggleSelfMonitoring: () => {
    const { selfMonitoring } = engine.getState();
    void engine.setSelfMonitoring(!selfMonitoring).catch(reportVoiceError);
  },

  setInputDevice: (deviceId) => {
    void engine.setInputDevice(deviceId).catch(reportVoiceError);
  },

  setOutputDevice: (deviceId) => {
    void engine.setOutputDevice(deviceId).catch(reportVoiceError);
  },

  setParticipantVolume: (userId, volume) => {
    // Engine applies live (clamped) and stays the source of truth (§11); the
    // persist store write-through keeps the level across relaunches.
    engine.setParticipantVolume(userId, volume);
    useParticipantVolumes.getState().setVolume(userId, volume);
  },

  setScreenShareVolume: (userId, volume) => {
    // Same pattern as voice volume but the SEPARATE film-audio track + its own
    // persist store (task #82). Engine is the source of truth; write-through keeps
    // the film level across relaunches (a persisted 0 is dropped on reload).
    engine.setScreenShareVolume(userId, volume);
    useScreenShareVolumes.getState().setVolume(userId, volume);
  },

  startScreenShare: (sourceId, options) => {
    const shareOptions = options ?? loadScreenSharePrefs();
    // Clear any warning from a previous share before this one arms its capture.
    stopFilmAudioSupervisor();
    useVoiceStore.setState({
      screenShareSystemAudioFailed: false,
      screenShareAudioSource: null,
      screenShareAudioStatus: "unavailable",
    });
    let acquiredSource: AcquiredFilmSource = null;
    const baseAcquire = makeScreenShareAcquire(
      sourceId,
      shareOptions,
      ({ systemAudioUnavailable, filmAudioSource }) => {
        // The user asked for film sound but NO track could be captured at all, so
        // the share goes out video-only and viewers definitely hear nothing (§35).
        // Note this is NOT the "published but silent" case — that is the
        // supervisor's job, because at this moment the user has not pressed play
        // and no source could possibly be judged audible yet.
        acquiredSource = filmAudioSource;
        useVoiceStore.setState({
          screenShareSystemAudioFailed: systemAudioUnavailable,
          screenShareAudioSource: filmAudioSource,
        });
        if (systemAudioUnavailable) {
          console.warn("[voice] screen share: system audio unavailable, sharing video-only");
        }
      },
    );
    // Tee the acquired video track for the optional self-preview (task #72). The
    // engine still owns the track (publish + stop); we only hold a reference so the
    // sharer can watch their OWN broadcast on the stage. The state mirror below
    // clears it on every teardown path (screenShareEnabled → false), so a stopped
    // track never lingers.
    const acquire: typeof baseAcquire = async () => {
      const assets = await baseAcquire();
      setLocalScreenPreviewTrack(assets.video);
      return assets;
    };
    void engine
      .startScreenShare(acquire, { quality: shareOptions.quality })
      .then(() => {
        // Supervise the film audio for as long as the share lives: confirm it is
        // actually audible, and hot-swap to a source that IS audible if the
        // published one stays silent. This is what makes "start share, THEN press
        // play" work — the flow that made film sound fail three releases running.
        const published = engine.getState();
        if (!published.screenShareEnabled) return;
        filmAudioSupervisorStop = superviseFilmAudio({
          initialTrack: engine.getLocalScreenShareAudioTrack(),
          initialSource: acquiredSource,
          replaceAudio: (track) => engine.replaceScreenShareAudio(track),
          onUpdate: ({ status, filmAudioSource }) => {
            engine.setScreenShareAudioLive(status === "live");
            useVoiceStore.setState({
              screenShareAudioStatus: status,
              screenShareAudioSource: filmAudioSource,
            });
          },
        });
      })
      .catch(reportVoiceError);
  },

  stopScreenShare: () => {
    void engine.stopScreenShare().catch(reportVoiceError);
  },

  toggleCamera: () => {
    const { cameraEnabled } = engine.getState();
    void engine.setCamera(!cameraEnabled).catch(reportVoiceError);
  },

  setVideoDevice: (deviceId) => {
    void engine.setVideoDevice(deviceId).catch(reportVoiceError);
  },
}));

/**
 * Live REMOTE screen shares (the video tracks to render in the focus view).
 * These are intentionally NOT in the reactive voice store — a MediaStreamTrack
 * is not React state (CLAUDE.md §27). The engine keeps the snapshot ref stable
 * when unchanged, so this hook only re-renders when a share actually appears or
 * disappears. Attach `share.track` to a <video> via `track.attach(el)`.
 */
export function useRemoteScreenShares(): RemoteScreenShare[] {
  return useSyncExternalStore(
    engine.subscribeScreenShares,
    engine.getScreenShares,
    engine.getScreenShares,
  );
}

/**
 * Live REMOTE camera tracks (task #18). Same rationale as remote screen shares:
 * a MediaStreamTrack is not React state (CLAUDE.md §27), so cameras live in the
 * engine's imperative snapshot, not the reactive store. The snapshot ref stays
 * stable while unchanged, so this only re-renders when a camera appears or
 * disappears. Attach `camera.track` to a <video> via `track.attach(el)`.
 * A remote can be in this list AND in useRemoteScreenShares() at once — camera
 * and screen share are separate tracks.
 */
export function useRemoteCameras(): RemoteCamera[] {
  return useSyncExternalStore(engine.subscribeCameras, engine.getCameras, engine.getCameras);
}

/**
 * Pin (`"high"`) or release (`"auto"`) the preferred simulcast layer for a focused
 * remote camera. Imperative (not reactive store state, §27): the video stage calls
 * "high" when a camera is promoted to the large stage/fullscreen so the SFU sends
 * the sharp top layer, and "auto" when it returns to a small tile. Engine-owned.
 */
export function setRemoteCameraQuality(identity: string, quality: "high" | "auto"): void {
  engine.setRemoteCameraQuality(identity, quality);
}

/**
 * Keep the engine's BANDWIDTH PRESSURE signal in step with "is a watch party
 * running in the voice room I am actually in".
 *
 * During a watch party nobody screen-shares: every viewer plays the film in their
 * OWN `youtube-nocookie` iframe, so each client independently pulls a multi-megabit
 * video stream alongside the voice room. The media engine has no way to observe
 * that, which is why it has to be told (see bandwidth.ts for why the signal names
 * the CONDITION rather than the feature).
 *
 * A RECONCILER rather than a hook on the `watch.started`/`watch.stopped` frames,
 * because the signal has two independent inputs: the party can start/stop while we
 * sit in the room, and we can join/leave a room that already has a party running.
 * Reading both stores on either change is the only version that cannot drift.
 * Mirrors the `syncVoiceAnnouncement` pattern in realtime/connection.ts.
 *
 * Imperative and outside the reactive store (§27): this must not cost a render.
 * `setBandwidthPressure` is idempotent and only acts on the empty↔non-empty edge,
 * so the extra calls this makes on unrelated voice-state writes are free.
 *
 * NOTE the room-id equivalence: for a server voice channel the voice `roomId` IS
 * the channel id (the key watch sessions are stored under). A DM call's room id is
 * `dmcall:<id>`, which can never collide with a channel key, so it simply never
 * matches — correct, since a DM call has no watch party.
 */
function syncBandwidthPressure(): void {
  const { roomId } = useVoiceStore.getState();
  const active =
    roomId !== null && useWatchPartyStore.getState().sessions[roomId] !== undefined;
  engine.setBandwidthPressure(BANDWIDTH_SOURCE_WATCH_PARTY, active);
}

useVoiceStore.subscribe(syncBandwidthPressure);
useWatchPartyStore.subscribe(syncBandwidthPressure);

/**
 * Mirror engine state into the store. The engine batches notifications (≤ once
 * per microtask) and keeps the `participants` array + rows referentially stable
 * across no-op speaking ticks, so selectors reading unchanged slices skip
 * rerendering (CLAUDE.md §27). We only add the derived `errorMessage`.
 */
/**
 * The room whose surface kind we last resolved, so the (comparatively expensive)
 * cache lookup runs once per room change instead of on every engine snapshot.
 */
let resolvedSurfaceRoomId: string | null | undefined;

engine.subscribe((s) => {
  // Tell the engine WHAT KIND of room this is the moment it changes, so it knows
  // whether the server's alone-idle sweep applies (a server voice channel is
  // never swept — see @demli/media/alone-watch). The engine cannot answer this
  // itself: it holds a room string, the answer lives in the group's `kind`.
  if (s.roomId !== resolvedSurfaceRoomId) {
    resolvedSurfaceRoomId = s.roomId;
    engine.setSurfaceKind(resolveVoiceSurfaceKind(s.roomId));
  }

  // Drop the self-preview reference the moment the engine reports no active share
  // (Stop, OS-initiated stop, leave, publish failure, dispose all flip this false).
  // The engine owns stopping the underlying track; we only forget the ref so a
  // dead track can never render on the stage (task #72).
  if (!s.screenShareEnabled) {
    setLocalScreenPreviewTrack(null);
    // The supervisor owns an AudioContext + timers; every teardown path (Stop,
    // OS-initiated stop, leave, publish failure, dispose) flips this false, so
    // this is the single place that guarantees it never outlives the share.
    stopFilmAudioSupervisor();
  }
  useVoiceStore.setState({
    roomId: s.roomId,
    // The system-audio-failed warning belongs to a LIVE share; once the share ends
    // (any teardown path flips screenShareEnabled false) it must not linger.
    ...(s.screenShareEnabled
      ? {}
      : {
          screenShareSystemAudioFailed: false,
          screenShareAudioStatus: "unavailable" as FilmAudioStatus,
          screenShareAudioSource: null,
        }),
    status: s.status,
    micEnabled: s.micEnabled,
    deafened: s.deafened,
    screenShareEnabled: s.screenShareEnabled,
    screenShareHasAudio: s.screenShareHasAudio,
    cameraEnabled: s.cameraEnabled,
    selectedInputDeviceId: s.selectedInputDeviceId,
    selectedOutputDeviceId: s.selectedOutputDeviceId,
    selectedVideoDeviceId: s.selectedVideoDeviceId,
    participants: s.participants,
    selfMonitoring: s.selfMonitoring,
    connectionQuality: s.connectionQuality,
    error: s.error,
    errorMessage: s.error ? voiceErrorMessage(s.error) : null,
    endedReason: s.endedReason,
    // A stable timestamp, not a ticking counter — the notice component ticks
    // locally against it, so being alone costs one store write, not 180 (§27).
    aloneDeadlineAt: s.aloneDeadlineAt,
    // Forget the display label once we are fully idle (left / evicted / failed)
    // so a stale room name can never linger on a re-open (task #2).
    ...(s.status === "idle" ? { roomLabel: null } : {}),
  });
});
