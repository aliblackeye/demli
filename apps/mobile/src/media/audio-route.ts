/**
 * Live audio OUTPUT route + echo-canceller choice, read from the patched
 * `@livekit/react-native` native module (patches/@livekit__react-native@2.11.1.patch).
 *
 * Upstream only offers `getAudioOutputs()` / `selectAudioOutput()`: JS could pick
 * a route but never learn which one audioswitch is actually playing on (it starts
 * on the loudspeaker whenever no headset is connected) and never hear about a
 * headset or Bluetooth device appearing mid-call. The patch adds:
 *   - `getSelectedAudioOutput()` — the active route, read on the main looper
 *     after any queued select, so a read right after a pick sees the pick;
 *   - the `LK_AUDIO_OUTPUT_CHANGED` event — audioswitch's own change callback;
 *   - `getAudioProcessingInfo()` / `setHardwareAudioProcessingPreferred()` — the
 *     hardware vs WebRTC software echo canceller choice the ADM is built with.
 *
 * Android-only surface; every call degrades to "unknown" when a method is missing
 * (an older binary), so nothing here can throw into the UI.
 */
import { NativeEventEmitter, NativeModules, Platform } from "react-native";

export const AUDIO_ROUTES = ["speaker", "earpiece", "headset", "bluetooth"] as const;
export type AudioRoute = (typeof AUDIO_ROUTES)[number];

export type AudioRouteSnapshot = {
  /** The route audio is playing on now; null when unknown or no session. */
  selected: AudioRoute | null;
  /** Routes the OS offers right now, in a stable display order. */
  available: readonly AudioRoute[];
};

export type AudioProcessingInfo = {
  /** The platform echo canceller actually runs in the live ADM. */
  hardwareActive: boolean;
  /** The platform noise suppressor actually runs in the live ADM. */
  hardwareNsActive?: boolean;
  /** The persisted choice the NEXT app start builds the ADM with. */
  hardwarePreferred: boolean;
  /** Android 10+ — the only versions LiveKit enables hardware processing on. */
  hardwareSupported: boolean;
  /** libwebrtc accepts the device's platform echo canceller (the AOSP one it refuses). */
  aecAvailable: boolean;
  nsAvailable: boolean;
};

type OutputChangedEvent = { selected?: string | null; available?: unknown };

type PatchedLiveKitModule = {
  getAudioOutputs?: () => Promise<string[]>;
  getSelectedAudioOutput?: () => Promise<string | null>;
  getAudioProcessingInfo?: () => Promise<AudioProcessingInfo>;
  setHardwareAudioProcessingPreferred?: (preferred: boolean) => Promise<void>;
};

const OUTPUT_CHANGED_EVENT = "LK_AUDIO_OUTPUT_CHANGED";

function nativeModule(): PatchedLiveKitModule | null {
  if (Platform.OS !== "android") return null;
  return (NativeModules.LivekitReactNativeModule as PatchedLiveKitModule | undefined) ?? null;
}

/** Narrow an untrusted native id to a known route. */
export function toAudioRoute(value: unknown): AudioRoute | null {
  return AUDIO_ROUTES.includes(value as AudioRoute) ? (value as AudioRoute) : null;
}

/** Known routes only, de-duplicated, in {@link AUDIO_ROUTES} order. */
export function normalizeRoutes(values: unknown): AudioRoute[] {
  if (!Array.isArray(values)) return [];
  const present = new Set(values.map(toAudioRoute).filter((r): r is AudioRoute => r !== null));
  return AUDIO_ROUTES.filter((r) => present.has(r));
}

const EMPTY: AudioRouteSnapshot = { selected: null, available: [] };

let snapshot: AudioRouteSnapshot = EMPTY;
const listeners = new Set<() => void>();
let nativeSubscribed = false;
/** A route the user picked in the output sheet during the current session. */
let userPick: AudioRoute | null = null;

function publish(next: AudioRouteSnapshot): void {
  if (
    next.selected === snapshot.selected &&
    next.available.length === snapshot.available.length &&
    next.available.every((r, i) => r === snapshot.available[i])
  ) {
    return;
  }
  snapshot = next;
  for (const listener of listeners) listener();
}

function ensureNativeSubscription(): void {
  if (nativeSubscribed) return;
  const mod = nativeModule();
  if (!mod || typeof mod.getSelectedAudioOutput !== "function") return;
  nativeSubscribed = true;
  const emitter = new NativeEventEmitter(NativeModules.LivekitReactNativeModule);
  emitter.addListener(OUTPUT_CHANGED_EVENT, (event: OutputChangedEvent) => {
    publish({ selected: toAudioRoute(event?.selected), available: normalizeRoutes(event?.available) });
  });
}

/** `useSyncExternalStore` snapshot (stable reference until something changes). */
export function getAudioRouteSnapshot(): AudioRouteSnapshot {
  return snapshot;
}

export function subscribeAudioRoute(listener: () => void): () => void {
  ensureNativeSubscription();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Re-read routes + the active route from native. Never throws. */
export async function refreshAudioRoute(): Promise<AudioRouteSnapshot> {
  const mod = nativeModule();
  if (!mod) return snapshot;
  ensureNativeSubscription();
  try {
    const [available, selected] = await Promise.all([
      mod.getAudioOutputs?.() ?? Promise.resolve([]),
      mod.getSelectedAudioOutput?.() ?? Promise.resolve(null),
    ]);
    publish({ selected: toAudioRoute(selected), available: normalizeRoutes(available) });
  } catch {
    // keep the last known snapshot
  }
  return snapshot;
}

/** Forget the route (and the user's pick) when the call audio session stops. */
export function clearAudioRoute(): void {
  userPick = null;
  publish(EMPTY);
}

/** Record a route the user picked by hand in this session. */
export function noteUserAudioRoutePick(route: string): void {
  userPick = toAudioRoute(route);
}

/** The route the user picked by hand in this session, if any. */
export function getUserAudioRoutePick(): AudioRoute | null {
  return userPick;
}

/**
 * Resolve once every audioswitch task queued before this call has run.
 *
 * `startAudioSession` / `stopAudioSession` are void bridge methods: audioswitch
 * only POSTS the work to the main looper, and `start()` does nothing while the
 * previous session object still exists. `getSelectedAudioOutput` is posted to
 * the same looper, behind that work, so awaiting it is the barrier that keeps a
 * stop from landing after the next start.
 */
export async function settleAudioSwitch(): Promise<void> {
  const mod = nativeModule();
  if (!mod || typeof mod.getSelectedAudioOutput !== "function") return;
  try {
    await mod.getSelectedAudioOutput();
  } catch {
    // the barrier only orders work; a failed read has nothing to report
  }
}

/** Echo-canceller state, or null where it does not apply (iOS / older binary). */
export async function getAudioProcessingInfo(): Promise<AudioProcessingInfo | null> {
  const mod = nativeModule();
  if (!mod || typeof mod.getAudioProcessingInfo !== "function") return null;
  try {
    return await mod.getAudioProcessingInfo();
  } catch {
    return null;
  }
}

/** Persist the echo-canceller choice; the ADM is rebuilt with it on the next app start. */
export async function setHardwareAudioProcessingPreferred(preferred: boolean): Promise<boolean> {
  const mod = nativeModule();
  if (!mod || typeof mod.setHardwareAudioProcessingPreferred !== "function") return false;
  try {
    await mod.setHardwareAudioProcessingPreferred(preferred);
    return true;
  } catch {
    return false;
  }
}
