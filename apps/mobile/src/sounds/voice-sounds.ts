/**
 * Voice lifecycle → sound cues, wired purely through the voice store's and the
 * engine's subscriptions. Mobile mirror of the desktop renderer's
 * sounds/voice-sounds.ts.
 *
 * This module OBSERVES; it never mutates voice state, and the store/engine know
 * nothing about sounds (the media lifecycle stays sound-free — CLAUDE.md §23).
 * Imported once for its side effect from app/_layout.tsx.
 *
 * Cues (same event → cue mapping as desktop):
 * - joining → connected               : voice-join (self joined)
 * - session → leaving/idle            : voice-leave (self left) — where a
 *   "session" is connected/reconnecting/joining/error (any state with a room),
 *   so a deliberate leave, a room switch, a cancelled join, and dismissing a
 *   dropped/errored session all cue exactly once (desktop fix 5f19ed7).
 * - remote participant appears/disappears while connected : peer-join/-leave
 * - micEnabled flips while connected  : mute / unmute (LOCAL only — never sent
 *   across the wire; the flip is already a local action)
 * - a remote screen share we are WATCHING starts/stops : screen-start/-stop
 *
 * - deafened flips while connected  : deafen / undeafen (the mic cue of that same
 *   update is skipped — deafening mutes the mic in the same breath)
 * - a NEW voice error surfaces, in any state : error
 *
 * DM-call rooms (`dmcall:<id>`, `isCallRoomId`) — same rule as desktop: the call
 * FSM owns call-connected / call-ended (call-ringtone.ts, `callTransitionCue`),
 * because the caller sits in the room while it still rings. Inside a call room:
 * self join/leave stay silent, the first remote arriving is silent (the call
 * connecting), a later arrival is peer-join, any remote leaving is peer-left-call.
 *
 * Screen-share difference from desktop: desktop cues on the LOCAL user's own
 * screenShareEnabled flip. Mobile cannot publish a screen (E2 — the host shares
 * from desktop; the phone only watches), so `screenShareEnabled` is always
 * false here. To give the watcher the SAME audible feedback, we instead cue on
 * the remote screen-share snapshot: a cue when the host starts sharing and when
 * they stop. This directly serves the founder's "no differences" bar.
 *
 * Grace-window rule (shared with the roster): the engine flips status to
 * "connected" BEFORE it syncs participants and existing shares, so a short grace
 * window after connecting treats additions as the initial snapshot — people (and
 * a share) already present when you join must not trigger a cue.
 *
 * Join-cue timing (the "join sound comes out broken" fix): the join cue is NOT
 * played the instant we reach "connected" — that lands inside LiveKit's connect +
 * mic-acquire storm (Android's audio session is switching to the VoIP profile),
 * which crackled/cut the beep. It is deferred a short settle window via
 * {@link createJoinCueScheduler}, and cancelled if we leave before it fires. See
 * join-cue-timing.ts for the full root-cause note. Desktop keeps its immediate
 * cue (no audio-mode switch there).
 */
import { isCallRoomId } from "@demli/client-core";
import type { RemoteScreenShare } from "@demli/media";
import {
  getRemoteScreenShares,
  subscribeRemoteScreenShares,
  useVoiceStore,
} from "../stores/voice-store";
import type { UiSound } from "./sound-manager";
import { playSound, primeSounds, setSoundsSuppressed } from "./sound-manager";
import { createJoinCueScheduler } from "./join-cue-timing";
import { isVoiceSessionStatus, setVoiceSessionProbe } from "./audio-mode-guard";

/** Roster/share changes within this window after connecting are the initial snapshot. */
const ROSTER_GRACE_MS = 2_000;

/**
 * How long after reaching "connected" the join cue waits so it plays into a
 * SETTLED audio session (past the mic-publish + audio-mode switch) instead of on
 * top of it. Barely perceptible as latency, but the difference between a clean
 * beep and a broken one on Android.
 */
const JOIN_CUE_SETTLE_MS = 350;

// expo-audio's setAudioModeAsync must never run while a room is joining or live
// (it would rewrite the call's audio mode); the guard reads the status from here.
setVoiceSessionProbe(() => isVoiceSessionStatus(useVoiceStore.getState().status));

// Warm up the sound subsystem at app entry (audio-mode config + player decode)
// before the first join, so nothing reconfigures audio mid-connect. Runs once —
// this module is imported once for its side effects from app/_layout.tsx.
primeSounds();

/** Plays the join cue a settle window after connecting; cancelled on early leave. */
const joinCue = createJoinCueScheduler(() => playSound("voice-join"), JOIN_CUE_SETTLE_MS);

type VoiceSnapshot = ReturnType<typeof useVoiceStore.getState>;

/** Identities of everyone in the room except ourselves. */
function remoteIdentities(state: VoiceSnapshot): Set<string> {
  const ids = new Set<string>();
  for (const p of state.participants) {
    if (!p.isLocal) ids.add(p.identity);
  }
  return ids;
}

/** Identities of the remote participants currently sharing a screen. */
function shareIdentities(shares: RemoteScreenShare[]): Set<string> {
  return new Set(shares.map((s) => s.identity));
}

let knownRemote = new Set<string>();
let knownShares = new Set<string>();
let connectedAt = 0;

/**
 * True while we hold, are establishing, are recovering, or are erroring on a
 * voice session — i.e. a room is associated with us. `error` MUST be included: a
 * dropped/failed session the user then dismisses (error → idle) is still leaving
 * the room, and previously played no cue (desktop fix 5f19ed7).
 */
function inSession(status: VoiceSnapshot["status"]): boolean {
  return (
    status === "connected" ||
    status === "reconnecting" ||
    status === "joining" ||
    status === "error"
  );
}

function handleStatusChange(state: VoiceSnapshot, prev: VoiceSnapshot): void {
  const { status } = state;
  if (status === "connected") {
    // Fresh join (not a reconnect recovery) arms the join cue on a short settle
    // delay (see JOIN_CUE_SETTLE_MS); either way the roster + share baselines
    // reset silently and the grace window re-arms.
    if (prev.status === "joining" && !isCallRoomId(state.roomId)) joinCue.arm();
    connectedAt = Date.now();
    knownRemote = remoteIdentities(state);
    knownShares = shareIdentities(getRemoteScreenShares());
    return;
  }
  // Any non-connected status means we are not (or no longer) in a settled room:
  // drop a pending join cue so a fast join → leave never beeps after we have
  // already left, and so a reconnect blip mid-settle stays quiet.
  joinCue.cancel();
  // Leave cue on every user departure, fired once at the FIRST exit transition.
  // Playing it here — at the "leaving" transition, BEFORE the engine tears the
  // audio session down — keeps it in the clean window, before the mode reverts.
  // Requiring `inSession(prev)` — which excludes leaving/idle — means the
  // trailing leaving → idle step never double-plays. (CLAUDE.md §11)
  if ((status === "leaving" || status === "idle") && inSession(prev.status)) {
    // roomId is already null once idle — the room we left is the previous one.
    if (!isCallRoomId(prev.roomId ?? state.roomId)) playSound("voice-leave");
  }
  knownRemote = remoteIdentities(state);
}

function handleRosterChange(state: VoiceSnapshot): void {
  const current = remoteIdentities(state);
  const silent = Date.now() - connectedAt < ROSTER_GRACE_MS;
  const callRoom = isCallRoomId(state.roomId);
  if (!silent) {
    // At most one cue per direction per update, even if several people came or
    // went in the same batch — no machine-gun bursts.
    for (const id of current) {
      if (!knownRemote.has(id)) {
        // In a call room the first remote arriving IS the call connecting —
        // call-ringtone.ts plays call-connected for that.
        if (!callRoom || knownRemote.size > 0) playSound("peer-join");
        break;
      }
    }
    for (const id of knownRemote) {
      if (!current.has(id)) {
        playSound(callRoom ? "peer-left-call" : "peer-leave");
        break;
      }
    }
  }
  knownRemote = current;
}

/** A cue name — extracted for readability of the subscriber below. */
function toggleCue(next: boolean, on: UiSound, off: UiSound): UiSound {
  return next ? on : off;
}

useVoiceStore.subscribe((state, prev) => {
  // Mirrored first, every tick (inert on mobile — the phone never shares system
  // audio — but kept faithful to desktop and future-proof for mobile-as-host).
  setSoundsSuppressed(state.screenShareEnabled && state.screenShareHasAudio);

  // A NEW error is a failure the user should hear, whatever the status did.
  const newError = state.error !== null && state.error !== prev.error;
  if (newError) playSound("error");

  if (state.status !== prev.status) {
    handleStatusChange(state, prev);
    return;
  }
  if (state.status !== "connected") return;

  // Both snapshots are "connected" from here on.
  if (state.participants !== prev.participants) handleRosterChange(state);

  // Mic cue only for a real flip while in the room. Skip when the same update
  // surfaced a new error (e.g. mic acquisition failed and the engine forced
  // micEnabled off) — that is a failure, not a user action.
  if (!newError) {
    const deafenFlipped = state.deafened !== prev.deafened;
    if (deafenFlipped) playSound(toggleCue(state.deafened, "deafen", "undeafen"));
    // Deafen sets micEnabled in the same update; one gesture, one cue.
    if (!deafenFlipped && state.micEnabled !== prev.micEnabled) {
      playSound(toggleCue(state.micEnabled, "unmute", "mute"));
    }
  }
});

// Remote screen shares live outside the reactive store (a track is not React
// state — CLAUDE.md §27), so their start/stop cues ride a separate engine
// subscription. Only cue while connected: on leave the engine clears the
// snapshot, and that emptying must NOT play screen-stop (voice-leave already
// covers the departure).
subscribeRemoteScreenShares((shares) => {
  const current = shareIdentities(shares);
  if (useVoiceStore.getState().status !== "connected") {
    knownShares = current; // typically empty; stay silent outside the room
    return;
  }
  const silent = Date.now() - connectedAt < ROSTER_GRACE_MS;
  if (!silent) {
    for (const id of current) {
      if (!knownShares.has(id)) {
        playSound("screen-start");
        break;
      }
    }
    for (const id of knownShares) {
      if (!current.has(id)) {
        playSound("screen-stop");
        break;
      }
    }
  }
  knownShares = current;
});
