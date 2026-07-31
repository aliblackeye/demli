/**
 * LOCAL screen-share self-preview track (desktop, renderer-only, task #72).
 *
 * The founder wants the option to watch their OWN broadcast on the video stage
 * ("kendi açtığım yayını da görebilmeliyim istersem"). Remote viewers already see
 * it via `useRemoteScreenShares`, but the media engine (`@demli/media`) never
 * feeds a participant their own share back, so the sharer had nothing to render.
 *
 * We solve this WITHOUT touching the engine: the renderer already holds the raw
 * screen-capture `MediaStreamTrack` at acquisition time (`makeScreenShareAcquire`
 * in lib/screen-share). The voice-store tees that same track in here when a share
 * starts and clears it when the engine reports the share ended. A MediaStreamTrack
 * can feed multiple sinks, so LiveKit publishing it and a local `<video>` reading
 * it for preview coexist (the standard local self-view pattern).
 *
 * This is an IMPERATIVE external store — NOT reactive Zustand state — for the same
 * reason as the engine's remote-share/camera snapshots: a MediaStreamTrack is not
 * React state (CLAUDE.md §27). Consumers subscribe via `useLocalScreenPreviewTrack`
 * (useSyncExternalStore); the ref only changes when a share starts or stops, so a
 * subscriber re-renders exactly then, never on a speaking tick.
 *
 * Lifecycle is OWNED by the engine: this module never stops the track (the engine
 * does, on unpublish/leave). We only mirror the reference. Because the engine flips
 * `screenShareEnabled` false on every teardown path (Stop, OS-initiated stop, leave,
 * publish failure, dispose), the voice-store's state mirror clears us there — a
 * dead/stopped track can never linger on the stage.
 */

import { useSyncExternalStore } from "react";

let currentTrack: MediaStreamTrack | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * Publish the local screen-share video track for self-preview (or `null` to
 * clear). Idempotent on an unchanged reference so a duplicate set never spuriously
 * re-renders the stage. The engine owns stopping the track; we only hold the ref.
 */
export function setLocalScreenPreviewTrack(track: MediaStreamTrack | null): void {
  if (currentTrack === track) return;
  currentTrack = track;
  emit();
}

/** Current self-preview track, or null when not sharing. Stable while unchanged. */
export function getLocalScreenPreviewTrack(): MediaStreamTrack | null {
  return currentTrack;
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/**
 * React binding for the local self-preview track. Re-renders only when the share
 * appears or disappears (the ref is stable otherwise). Attach the returned track
 * to a `<video>` via `srcObject` — it is a raw MediaStreamTrack, not a LiveKit
 * track, so it has no `.attach()` (see LocalScreenShareTile).
 */
export function useLocalScreenPreviewTrack(): MediaStreamTrack | null {
  return useSyncExternalStore(subscribe, getLocalScreenPreviewTrack, getLocalScreenPreviewTrack);
}
