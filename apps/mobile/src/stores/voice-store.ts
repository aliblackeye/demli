/**
 * Voice store — the mobile mirror of the desktop renderer's
 * stores/voice-store.ts. The FSM and ALL media lifecycle live in
 * `@demli/media` (`createVoiceEngine`); this store is a thin zustand mirror
 * of the engine's `VoiceState` plus the command methods the UI calls. It owns no
 * voice logic — no timers, no simulated participants, no ad-hoc booleans
 * (CLAUDE.md §11).
 *
 * Reuse boundary: the ENTIRE engine (states, transitions, participants,
 * speaking, deafen, reconnect, remote screen-share tracking) is shared, unchanged
 * code. Mobile supplies only three injected seams — `fetchToken` (client-core's
 * `getMediaToken`, the single HTTP hop; §35 keeps media off the WebSocket),
 * `createRoom` (the `@livekit/react-native` adapter), and `acquireScreenShare`
 * (the RN MediaProjection/getDisplayMedia capture, task #45). We import
 * `@demli/media` from its ROOT only — never `@demli/media/web` — so
 * livekit's browser room factory never reaches the phone.
 *
 * Screen share (task #45): the phone can now PUBLISH its screen. `toggleScreenShare`
 * drives the SAME engine command the desktop uses (`startScreenShare(acquire)` /
 * `stopScreenShare()`); the FSM owns the `screenShareEnabled` flag and OS-initiated
 * track-end, and viewers still WATCH remote shares via `useRemoteScreenShares()`.
 */
import { useSyncExternalStore } from "react";
import { create } from "zustand";
import {
  BANDWIDTH_SOURCE_WATCH_PARTY,
  createVoiceEngine,
  initialVoiceState,
  InvalidVoiceCommandError,
  voiceEndedReasonFromEvent,
  VoiceOperationError,
  type RemoteCamera,
  type RemoteScreenShare,
  type VoiceState,
  type VoiceTokenGrant,
} from "@demli/media";
import type { ChannelId } from "@demli/types";
import {
  createMobileVoiceRoom,
  getLocalCameraTrack,
  subscribeLocalCamera,
  type LocalCameraTrack,
} from "../media/livekit-room";
import { acquireScreenShare } from "../media/screen-capture";
import { getApi } from "../lib/clients";
import { resolveVoiceSurfaceKind } from "../lib/voice-surface";
import { useMediaSettings } from "./media-settings";
import {
  loadPersistedParticipantVolumes,
  useParticipantVolumes,
} from "./participant-volume-store";
import {
  loadPersistedScreenShareVolumes,
  useScreenShareVolumes,
} from "./screen-share-volume-store";
// Read-only: the watch-party projection is one of the two inputs to the engine's
// bandwidth-pressure signal (see syncBandwidthPressure at the end of this file).
// watch-party-store imports nothing from here, so this direction stays acyclic.
import { useWatchPartyStore } from "./watch-party-store";

/**
 * UI-only display metadata for the active room. NOT engine state — the engine
 * only knows the opaque `roomId`. The global voice bar (`VoiceMiniBar`) reads
 * this to label the session and to navigate back to the voice screen with the
 * same route params the user originally opened it with.
 */
export interface VoiceChannelMeta {
  groupId?: string;
  name?: string;
}

interface VoiceStore extends VoiceState {
  /** Display metadata for the active room (null when idle). UI-only, see above. */
  channelMeta: VoiceChannelMeta | null;
  /** Join a voice channel (fetch a token, connect the engine). Fire-and-forget. */
  join: (channelId: ChannelId, meta?: VoiceChannelMeta) => void;
  /** Leave the current room and return to idle. */
  leave: () => void;
  /**
   * Single-active-session eviction from the realtime gateway
   * (`voice.session_replaced`): the user joined voice on another device, so leave
   * `roomId`. Engine-guarded — a no-op unless we are actually in that room (the
   * device that just joined ignores it). Fire-and-forget.
   */
  sessionReplaced: (roomId: ChannelId) => void;
  /**
   * A server-authored voice disconnect (`voice.disconnected`) naming its reason —
   * today `alone`, the last person left in a DM call / group-DM voice channel for
   * the idle window. Engine-guarded, and race-tolerant: when the SFU force-remove
   * already ended the session this only corrects the wording of the notice.
   *
   * Both ids are passed because they name the SAME session and the engine's
   * `roomId` is whichever one the join used (a voice channel that resolves to a
   * call room is joined by channel id — ADR 0012 §6). Fire-and-forget.
   */
  voiceDisconnected: (payload: { roomId: string; channelId: string; reason: string }) => void;
  /** Clear the eviction notice after the UI has surfaced it (ack). */
  acknowledgeSessionReplaced: () => void;
  /** Toggle mic (unmuting while deafened undeafens; engine-owned). */
  toggleMic: () => void;
  /**
   * Set the mic on/off directly (not a toggle). Drives push-to-talk hold-to-talk:
   * press → setMicActive(true), release → setMicActive(false). Engine-owned.
   */
  setMicActive: (enabled: boolean) => void;
  /** Toggle deafen (deafening also mutes the mic; engine-owned). */
  toggleDeafen: () => void;
  /** Toggle the local camera on/off (task #18). Independent of mic + screen share. */
  toggleCamera: () => void;
  /**
   * Toggle publishing the phone's SCREEN (task #45). On → acquire via
   * MediaProjection/getDisplayMedia and let the engine publish it at the user's
   * screen-share quality tier; off → engine.stopScreenShare(). Engine-owned FSM
   * flag (`screenShareEnabled`); independent of mic + camera. Connected-only in
   * practice — the UI only surfaces the button while connected, and the engine
   * guards START_SCREEN_SHARE to `connected`.
   */
  toggleScreenShare: () => void;
  /** Preferred audio input; live-switches when connected (engine-owned). */
  setInputDevice: (deviceId: string) => void;
  /** Preferred audio output (RN: speaker/earpiece/bluetooth route). */
  setOutputDevice: (deviceId: string) => void;
  /**
   * Pick the camera (videoinput) device — front/back on mobile (#101). Engine-owned,
   * mirrors desktop: applied live via `switchActiveDevice("videoinput", …)` when the
   * camera is on, stored as the `selectedVideoDeviceId` preference otherwise so the
   * next `setCamera(true)` publishes the chosen camera. The camera-preview sheet
   * calls this on confirm so what was previewed is what goes live.
   */
  setVideoDevice: (deviceId: string) => void;
  /**
   * Set the LISTENER's personal playback volume (0..2) for one REMOTE participant
   * — the per-user level (kişi-başı ses seviyesi). Write-through: applies live
   * via the engine
   * (the source of truth; scales that remote's own native playout when connected +
   * not deafened, §10/§35) AND persists so the level survives leave/rejoin/relaunch.
   * A no-op on the local user (you cannot attenuate yourself). Engine-owned.
   */
  setParticipantVolume: (userId: string, volume: number) => void;
  /**
   * Set the LISTENER's personal volume (0..2) for a remote's SCREEN-SHARE (film)
   * audio — SEPARATE from that person's voice (task #82, the share volume).
   * Write-through: applies live via the engine (scales ONLY their screen_share_audio
   * track when connected + not deafened) AND persists (0 dropped on reload).
   */
  setScreenShareVolume: (userId: string, volume: number) => void;
}

/**
 * The single voice engine for the app lifetime. `fetchToken` is the only HTTP
 * hop — it maps client-core's `getMediaToken` to the `{ url, token }` grant the
 * engine needs; identity/room are derived server-side from the session + channel.
 * `getApi()` returns the runtime-reconfigurable client (mobile server URL).
 */
async function fetchToken(channelId: string): Promise<VoiceTokenGrant> {
  const grant = await getApi().getMediaToken(channelId);
  return { url: grant.url, token: grant.token };
}

/**
 * The single app-lifetime voice engine. Exported as {@link voiceEngine} so the
 * DM-call controller (stores/call-store) can drive the SAME engine (ADR 0012 §2:
 * "a call room is a voice room") — this is what lets single-session eviction key
 * on one shared room registry and lets the in-call surface reuse this store's
 * mirrored media state (participants, mic, camera, screen shares).
 */
const engine = createVoiceEngine({
  fetchToken,
  createRoom: createMobileVoiceRoom,
  // Seed persisted per-user volumes. On RN the persist
  // store rehydrates ASYNC, so this is usually empty on a cold start — the real
  // seed happens on `onFinishHydration` below. Passed anyway for contract parity.
  initialParticipantVolumes: loadPersistedParticipantVolumes(),
  // Separate per-share (film) audio levels — the share volume (task #82).
  // Same async-rehydration caveat; the real seed is on onFinishHydration below.
  initialScreenShareVolumes: loadPersistedScreenShareVolumes(),
});

/**
 * The shared voice engine instance — the DM-call controller (call-store) joins
 * pre-minted call rooms on this SAME engine so single-session, reconnect, and the
 * media mirror below all work for a call exactly as they do for a voice channel.
 */
export const voiceEngine = engine;

/**
 * Re-seed the engine's runtime per-user volume map from the persisted store. The
 * engine is the source of truth (§11); `setParticipantVolume` is legal at idle and
 * only stores the level, which re-applies to the remote when the user next joins.
 * Runs once after the (async) SecureStore rehydration completes — the mobile
 * counterpart of desktop's synchronous `initialParticipantVolumes` seed.
 */
function seedParticipantVolumesFromStore(): void {
  const { volumes } = useParticipantVolumes.getState();
  for (const [userId, volume] of Object.entries(volumes)) {
    engine.setParticipantVolume(userId, volume);
  }
}
if (useParticipantVolumes.persist.hasHydrated()) {
  seedParticipantVolumesFromStore();
} else {
  const unsubHydration = useParticipantVolumes.persist.onFinishHydration(() => {
    unsubHydration();
    seedParticipantVolumesFromStore();
  });
}

/** Re-seed the engine's per-SHARE (film) volume map after async rehydration (task #82). */
function seedScreenShareVolumesFromStore(): void {
  const { volumes } = useScreenShareVolumes.getState();
  for (const [userId, volume] of Object.entries(volumes)) {
    engine.setScreenShareVolume(userId, volume);
  }
}
if (useScreenShareVolumes.persist.hasHydrated()) {
  seedScreenShareVolumesFromStore();
} else {
  const unsubShareHydration = useScreenShareVolumes.persist.onFinishHydration(() => {
    unsubShareHydration();
    seedScreenShareVolumesFromStore();
  });
}

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
 * Await a full voice teardown for an account switch (ADR 0013 step 2,
 * `voiceLeaveDispose`). Calls `engine.leave()` — which ALWAYS reaches idle,
 * releasing the LiveKit room, mic and screen — and awaits it so teardown
 * completes before the switch tears the WebSocket down (the old token must stay
 * valid while the gateway releases the SFU participant).
 *
 * Deliberately does NOT call `engine.dispose()`: the engine is an app-lifetime
 * singleton and `dispose()` clears its listener set, which would permanently
 * sever this store's live subscription and break voice for the NEXT account.
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
 * below), so a thrown `VoiceOperationError` is a duplicate — swallow it to avoid
 * an unhandled rejection. `InvalidVoiceCommandError` is a timing race (a tap
 * during a transition) — harmless, just log. Anything else is unexpected.
 */
function reportVoiceError(err: unknown): void {
  if (err instanceof VoiceOperationError) return;
  if (err instanceof InvalidVoiceCommandError) {
    console.warn(`[voice] ${err.message}`);
    return;
  }
  console.error("[voice] unexpected error", err);
}

export const useVoiceStore = create<VoiceStore>()((set) => ({
  ...initialVoiceState,
  channelMeta: null,

  join: (channelId, meta) => {
    // Display metadata is UI-only; set it synchronously so the global voice bar
    // can label + route the session the instant we begin joining.
    set({ channelMeta: meta ?? null });
    void (async () => {
      const { roomId, status } = engine.getState();
      // Already in (or joining/reconnecting to) this exact room — no-op.
      if (roomId === channelId && isActive(status)) return;
      try {
        // Switching rooms while active: leave the old one first (JOIN is only
        // legal from idle/error). From idle/error we join straight through.
        if (isActive(status)) await engine.leave();
        // Push-to-talk (Bas-Konuş): join muted so nothing transmits until the
        // user holds the Talk button (open-mic / voice-activity join per pref).
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
    set({ channelMeta: null });
    const { status } = engine.getState();
    if (status === "idle" || status === "leaving") return;
    void engine.leave().catch(reportVoiceError);
  },

  sessionReplaced: (roomId) => {
    // Engine-guarded: no-op unless we are in `roomId`. The channelMeta is UI-only
    // and cleared when the engine transition mirrors back to idle below, so no
    // need to touch it here.
    void engine.handleSessionReplaced(roomId).catch(reportVoiceError);
  },

  voiceDisconnected: ({ roomId, channelId, reason }) => {
    const ended = voiceEndedReasonFromEvent(reason);
    // An unmapped reason (a future enum value, or `moderator` — whose notice the
    // moderation wave owns) is left to the existing paths rather than guessed at.
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

  toggleCamera: () => {
    const { cameraEnabled } = engine.getState();
    void engine.setCamera(!cameraEnabled).catch(reportVoiceError);
  },

  toggleScreenShare: () => {
    const { screenShareEnabled } = engine.getState();
    if (screenShareEnabled) {
      void engine.stopScreenShare().catch(reportVoiceError);
      return;
    }
    // Publish at the user's persisted screen-share tier (Ayarlar → görüntü). The
    // engine acquires via the injected callback so its permission-denied /
    // source-closed failures map to the same typed §26 errors as every other
    // media command; the getDisplayMedia consent dialog opens inside acquire().
    const quality = useMediaSettings.getState().video.screenShareQuality;
    void engine.startScreenShare(acquireScreenShare, { quality }).catch(reportVoiceError);
  },

  setInputDevice: (deviceId) => {
    void engine.setInputDevice(deviceId).catch(reportVoiceError);
  },

  setOutputDevice: (deviceId) => {
    void engine.setOutputDevice(deviceId).catch(reportVoiceError);
  },

  setVideoDevice: (deviceId) => {
    void engine.setVideoDevice(deviceId).catch(reportVoiceError);
  },

  setParticipantVolume: (userId, volume) => {
    // Write-through, exactly like desktop's voice-store: the engine applies the
    // level LIVE (source of truth, §11) and the persist store keeps it across
    // relaunch. Order is irrelevant — both are synchronous and idempotent.
    engine.setParticipantVolume(userId, volume);
    useParticipantVolumes.getState().setVolume(userId, volume);
  },

  setScreenShareVolume: (userId, volume) => {
    // Same write-through, but the SEPARATE film-audio track + its own persist store
    // (task #82): the engine scales only their screen_share_audio; a persisted 0 is
    // dropped on the next reload so a muted film never silently survives a restart.
    engine.setScreenShareVolume(userId, volume);
    useScreenShareVolumes.getState().setVolume(userId, volume);
  },
}));

/**
 * Live REMOTE screen shares (the video tracks to render in the focus view).
 * Intentionally NOT in the reactive voice store — a media track is not React
 * state (CLAUDE.md §27). The engine keeps the snapshot ref stable when unchanged,
 * so this hook only re-renders when a share appears or disappears. On mobile the
 * `share.track` is rendered with `@livekit/react-native`'s `<VideoTrack>`.
 */
export function useRemoteScreenShares(): RemoteScreenShare[] {
  return useSyncExternalStore(
    engine.subscribeScreenShares,
    engine.getScreenShares,
    engine.getScreenShares,
  );
}

/**
 * Live REMOTE camera videos (task #18) — the exact camera counterpart of
 * {@link useRemoteScreenShares}. A media track is not React state (§27), so the
 * engine surfaces cameras imperatively and keeps the snapshot ref stable, so
 * this hook only re-renders when a remote camera appears or disappears. Each
 * `camera.track` is rendered with `@livekit/react-native`'s `<VideoTrack>`.
 */
export function useRemoteCameras(): RemoteCamera[] {
  return useSyncExternalStore(
    engine.subscribeCameras,
    engine.getCameras,
    engine.getCameras,
  );
}

/**
 * The LOCAL camera track for the self-preview tile (task #18), or null when the
 * camera is off. The engine never exposes local tracks as React state (§27), so
 * the mobile adapter surfaces it; the ref is stable while published, so this
 * hook only re-renders when the local camera turns on or off.
 */
export function useLocalCameraTrack(): LocalCameraTrack | null {
  return useSyncExternalStore(
    subscribeLocalCamera,
    getLocalCameraTrack,
    getLocalCameraTrack,
  );
}

/**
 * Non-React access to the same remote screen-share snapshot the hook reads —
 * used by the sound layer (`sounds/voice-sounds.ts`) to cue screen-start /
 * screen-stop when the host we are WATCHING begins or ends a share. A screen
 * track is not React state (CLAUDE.md §27), so this stays out of the reactive
 * store; the sound subscriber only diffs the sharer identities, never the track.
 */
export function subscribeRemoteScreenShares(
  listener: (shares: RemoteScreenShare[]) => void,
): () => void {
  return engine.subscribeScreenShares(listener);
}

export function getRemoteScreenShares(): RemoteScreenShare[] {
  return engine.getScreenShares();
}

/**
 * Pin (`"high"`) or release (`"auto"`) the preferred simulcast layer for a focused
 * remote camera. Imperative (not reactive store state, §27): the focus view calls
 * "high" when a camera is enlarged/fullscreened so the SFU sends the sharp top
 * layer, and "auto" when it returns to a small tile. Engine-owned; best-effort.
 */
export function setRemoteCameraQuality(identity: string, quality: "high" | "auto"): void {
  engine.setRemoteCameraQuality(identity, quality);
}

/**
 * Mirror engine state into the store. The engine batches notifications (≤ once
 * per microtask) and keeps the `participants` array + rows referentially stable
 * across no-op speaking ticks, so selectors reading unchanged slices skip
 * rerendering (CLAUDE.md §27). We mirror the raw typed `error`; the UI localizes
 * it at render via `localizeVoiceError` (the store can't call the i18n hook).
 */
/**
 * The room whose surface kind we last resolved, so the lookup runs once per room
 * change rather than on every engine snapshot.
 */
let resolvedSurfaceRoomId: string | null | undefined;

engine.subscribe((s) => {
  // Tell the engine WHAT KIND of room this is the moment it changes, so it knows
  // whether the server's alone-idle sweep applies (a server voice channel is never
  // swept — see @demli/media/alone-watch). The engine holds only a room string;
  // the answer lives in the owning group's `kind`, which `channelMeta` carries.
  if (s.roomId !== resolvedSurfaceRoomId) {
    resolvedSurfaceRoomId = s.roomId;
    const groupId = useVoiceStore.getState().channelMeta?.groupId ?? null;
    engine.setSurfaceKind(resolveVoiceSurfaceKind(s.roomId, groupId));
  }

  useVoiceStore.setState({
    roomId: s.roomId,
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
    connectionQuality: s.connectionQuality,
    error: s.error,
    endedReason: s.endedReason,
    // A stable timestamp, not a ticking counter — the notice component ticks
    // locally against it, so being alone costs one store write, not 180 (§27).
    aloneDeadlineAt: s.aloneDeadlineAt,
  });
});

/**
 * Keep the engine's BANDWIDTH PRESSURE signal in step with "is a watch party
 * running in the voice room I am actually in".
 *
 * The mobile half of the seam the desktop wave left open for this one (see
 * `packages/media/src/bandwidth.ts` and the desktop `voice-store.ts` twin). During
 * a watch party nobody screen-shares: every viewer plays the film in their OWN
 * embed, so each client independently pulls a multi-megabit video stream alongside
 * the voice room. The media engine cannot observe that, so it has to be told — and
 * under pressure it caps the local CAMERA capture and lowers the screen-share
 * floor, freeing uplink. Never audio (§6).
 *
 * It matters MORE here than on desktop. A phone is usually the worst link in the
 * room — mobile data or a distant access point, and an uplink that is a fraction
 * of the downlink — so the client most likely to spike everyone's ping during a
 * film night is exactly this one.
 *
 * A RECONCILER rather than a hook on the `watch.started` / `watch.stopped` frames,
 * because the signal has two independent inputs: the party can start or stop while
 * we sit in the room, and we can join or leave a room that already has one
 * running. Reading both stores on either change is the only version that cannot
 * drift. Mirrors the `syncVoiceAnnouncement` pattern in realtime/connection.ts.
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
