/**
 * Voice lifecycle → sound cues, wired purely through `useVoiceStore.subscribe`.
 *
 * This module OBSERVES the voice store; it never modifies it and the store
 * knows nothing about sounds (the media lifecycle stays sound-free —
 * CLAUDE.md §23). Imported once for its side effect from `App.tsx`.
 *
 * Cues:
 * - joining   → connected            : voice-join (self joined)
 * - session → leaving/idle           : voice-leave (self left) — where a
 *   "session" is connected/reconnecting/joining/error (any state with a room),
 *   so a deliberate leave, a room switch, a cancelled join, and dismissing a
 *   dropped/errored session all cue exactly once
 * - remote participant appears/disappears while connected : peer-join/-leave
 * - micEnabled flips while connected : mute / unmute
 * - screenShareEnabled flips while connected : screen-start / screen-stop (OUR share)
 * - a REMOTE participant starts/stops sharing while connected : screen-start /
 *   screen-stop (a PEER's share, so everyone in the room — not just the sharer —
 *   hears the same start/stop cue; mirrors the mobile watcher, which has only this
 *   path since a phone never shares itself)
 *
 * Roster snapshot rule: the engine flips status to "connected" BEFORE it
 * first syncs participants (device restore happens in between), so the
 * existing room roster lands via later updates. A short grace window after
 * entering "connected" treats roster additions as the initial snapshot —
 * people already in the room must not trigger peer-join.
 */

import { useVoiceStore } from "../stores/voice-store";
import type { UiSound } from "./sound-manager";
import { playSound, setSoundsSuppressed } from "./sound-manager";

/** Roster changes within this window after connecting are the initial snapshot. */
const ROSTER_GRACE_MS = 2_000;

type VoiceSnapshot = ReturnType<typeof useVoiceStore.getState>;

/** Identities of everyone in the room except ourselves. */
function remoteIdentities(state: VoiceSnapshot): Set<string> {
  const ids = new Set<string>();
  for (const p of state.participants) {
    if (!p.isLocal) ids.add(p.identity);
  }
  return ids;
}

let knownRemote: Set<string> = new Set();
/** Identities of the REMOTE participants we currently see screen-sharing. */
let knownRemoteShares: Set<string> = new Set();
let connectedAt = 0;

/** Remote identities whose screen share we currently render (drives the peer cue). */
function remoteShareIdentities(state: VoiceSnapshot): Set<string> {
  const ids = new Set<string>();
  for (const p of state.participants) {
    if (!p.isLocal && p.screenSharing) ids.add(p.identity);
  }
  return ids;
}

/**
 * True while we hold, are establishing, are recovering, or are erroring on a
 * voice session — i.e. a room is associated with us. Everything here has a
 * non-null `roomId` (set on JOIN, cleared only when we reach idle), so a
 * transition from one of these into leaving/idle is a real user departure.
 * `error` MUST be included: a dropped/failed session the user then dismisses
 * (error → idle) is still leaving the room, and previously played no cue.
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
    // Fresh join (not a reconnect recovery) gets the join cue; either way the
    // roster resets silently and the snapshot grace window re-arms.
    if (prev.status === "joining") playSound("voice-join");
    connectedAt = Date.now();
    knownRemote = remoteIdentities(state);
    // Baseline peer shares too, so a share already in progress when we join
    // (seeded on connect) does NOT retro-fire a screen-start cue.
    knownRemoteShares = remoteShareIdentities(state);
    return;
  }
  // Leave cue on every user departure, fired once at the FIRST exit transition.
  // A deliberate leave enters "leaving" first (connected/reconnecting →
  // leaving → idle); a room switch, a cancelled join, and dismissing an errored
  // session (error → idle, possibly coalesced straight through) all pass here
  // too. Requiring `inSession(prev)` — which excludes leaving/idle — means the
  // trailing leaving → idle step never double-plays. (CLAUDE.md §11)
  if ((status === "leaving" || status === "idle") && inSession(prev.status)) {
    playSound("voice-leave");
  }
  knownRemote = remoteIdentities(state);
  knownRemoteShares = remoteShareIdentities(state);
}

function handleRosterChange(state: VoiceSnapshot): void {
  const current = remoteIdentities(state);
  const silent = Date.now() - connectedAt < ROSTER_GRACE_MS;
  if (!silent) {
    // Play at most one cue per direction per update, even if several people
    // came or went in the same batch — no machine-gun bursts.
    for (const id of current) {
      if (!knownRemote.has(id)) {
        playSound("peer-join");
        break;
      }
    }
    for (const id of knownRemote) {
      if (!current.has(id)) {
        playSound("peer-leave");
        break;
      }
    }
  }
  knownRemote = current;
}

/**
 * Peer screen-share cue: a REMOTE participant started or stopped sharing (their
 * `screenSharing` flag flips when we subscribe/drop their screen-share track). One
 * cue per direction per update; silent during the initial-snapshot grace window so
 * an already-running share we just joined never retro-beeps. OUR OWN share is cued
 * separately off `screenShareEnabled` (see the subscriber below).
 */
function handleRemoteShareChange(state: VoiceSnapshot): void {
  const current = remoteShareIdentities(state);
  const silent = Date.now() - connectedAt < ROSTER_GRACE_MS;
  if (!silent) {
    for (const id of current) {
      if (!knownRemoteShares.has(id)) {
        playSound("screen-start");
        break;
      }
    }
    for (const id of knownRemoteShares) {
      if (!current.has(id)) {
        playSound("screen-stop");
        break;
      }
    }
  }
  knownRemoteShares = current;
}

/** A cue name or null — extracted for readability of the subscriber below. */
function toggleCue(next: boolean, on: UiSound, off: UiSound): UiSound {
  return next ? on : off;
}

useVoiceStore.subscribe((state, prev) => {
  // Updated FIRST, every tick, so it also gates the cues fired below in this
  // same update: while we locally share system audio the loopback would rebroadcast
  // our UI beeps, so mute them all until the share (or its audio) ends. Clearing
  // on stop happens here too, so the screen-stop cue itself is audible again.
  setSoundsSuppressed(state.screenShareEnabled && state.screenShareHasAudio);

  if (state.status !== prev.status) {
    handleStatusChange(state, prev);
    return;
  }
  if (state.status !== "connected") return;

  // Both snapshots are "connected" from here on.
  if (state.participants !== prev.participants) {
    handleRosterChange(state);
    // A peer's screenSharing flag rides the same participants array, so a start/
    // stop by any remote is picked up here — everyone in the room hears the cue.
    handleRemoteShareChange(state);
  }

  // Mic/screen cues only for real flips while in the room. Skip when the same
  // update surfaced a new error (e.g. mic acquisition failed and the engine
  // forced micEnabled off) — that is a failure, not a user action.
  const newError = state.error !== null && state.error !== prev.error;
  if (!newError) {
    if (state.micEnabled !== prev.micEnabled) {
      playSound(toggleCue(state.micEnabled, "unmute", "mute"));
    }
    if (state.screenShareEnabled !== prev.screenShareEnabled) {
      playSound(toggleCue(state.screenShareEnabled, "screen-start", "screen-stop"));
    }
  }
});
