/**
 * Android voice foreground service — keeps the phone CAPTURING (mic, and the
 * camera when it is on) after the app leaves the foreground during a voice or
 * DM-call session.
 *
 * WHY THIS EXISTS, AND WHY THE OLD VERSION WAS WRONG.
 * `RECORD_AUDIO` and `CAMERA` are Android "while-in-use" permissions: the OS
 * cuts the capture SOURCE the moment the app stops being visible, unless a
 * foreground service is running whose RUNTIME type covers that specific
 * capability. Service types do NOT cross-grant — `mediaProjection` keeps screen
 * capture alive and nothing else
 * (https://developer.android.com/develop/background-work/services/fgs/service-types).
 *
 * The previous policy stood down whenever `screenShareEnabled` was true, on the
 * premise that "the MediaProjection foreground service already keeps the mic
 * alive". It does not. That premise cost the founder a live call: two people on
 * mobile, cameras on, one screen sharing, app backgrounded into the Android PiP
 * window — everything still worked, because a PiP activity is paused but still
 * VISIBLE, which satisfies while-in-use on its own. The instant she DISMISSED
 * the PiP window the activity stopped being visible, the only running service
 * was `mediaProjection`, and Android cut her mic and camera at the source. Her
 * screen share kept flowing. Note the signature: the tracks stayed published, so
 * the far side got SILENCE and a FROZEN last frame rather than a mute badge and
 * an avatar — a source-level revocation, never a teardown in our code.
 *
 * So the service now runs for the WHOLE session, screen share included, and its
 * type widens to cover the camera while the camera is on.
 *
 * Build safety (why a package, not custom Kotlin): the service comes from
 * `@supersami/rn-foreground-service` — a plain autolinked bridge module (no
 * Kotlin of ours, no codegen), so the native side compiles at EAS as well as
 * locally. Its `<service>` declaration and notification-channel meta-data are
 * injected at prebuild by `plugins/with-foreground-service.js`, which declares
 * the manifest type `microphone|camera`. The library mapped only ONE type name
 * per start() call and silently fell back to `location` for anything it did not
 * recognise, so a combined type is enabled by a pnpm patch (see
 * `patches/@supersami__rn-foreground-service@2.2.5.patch`).
 *
 * The FGS is a side effect of the voice FSM, never a source of truth: an
 * app-level controller (components/voice/ForegroundServiceController) subscribes
 * to the voice store READ-ONLY and calls start/stop here. The engine in
 * `@demli/media` stays the single owner of voice state (CLAUDE.md §11).
 */
import type { VoiceState } from "@demli/media";

type VoiceStatus = VoiceState["status"];

/**
 * The runtime `foregroundServiceType` we ask Android for. Both values are a
 * subset of the `microphone|camera` declared in the manifest, which Android
 * requires. `camera` is only ever requested while the camera is actually
 * publishing: asking for a type whose permission the user has not granted makes
 * `startForeground` throw on Android 14+, which would take the microphone
 * lifeline down with it and leave a voice-only user WORSE off than before.
 */
export type VoiceForegroundServiceType = "microphone" | "microphone|camera";

/**
 * Pure policy: which foreground service type should be running for this voice
 * state, or `null` for "none".
 *
 * On while we hold (or are acquiring) a capture session — `connected`,
 * `joining`, `reconnecting`. Off for `idle`, `leaving` and `error`.
 *
 * DELIBERATELY NOT A PARAMETER: `screenShareEnabled`. Screen sharing is exactly
 * when the background lifeline matters most (that is the founder's repro), and
 * the MediaProjection service does not cover mic or camera. Keeping it out of
 * the signature is the guard — the coupling cannot be reintroduced by flipping a
 * boolean.
 *
 * Dependency-free and exported so it is unit-tested without loading any native
 * module.
 */
export function resolveVoiceForegroundServiceType(input: {
  status: VoiceStatus;
  cameraEnabled: boolean;
}): VoiceForegroundServiceType | null {
  const holdsCapture =
    input.status === "connected" ||
    input.status === "joining" ||
    input.status === "reconnecting";
  if (!holdsCapture) return null;
  return input.cameraEnabled ? "microphone|camera" : "microphone";
}

// --- native wrapper (Android-only, lazily loaded) ---------------------------

export interface ForegroundServiceApi {
  register(opts: {
    config: { alert: boolean; onServiceErrorCallBack: () => void };
  }): void;
  // The shipped types omit `ServiceType` (the Android 14 foregroundServiceType),
  // which the native module DOES read at runtime, so we declare our own surface.
  start(config: {
    id: number;
    title: string;
    message: string;
    ServiceType?: string;
    importance?: string;
    color?: string;
    icon?: string;
    setOnlyAlertOnce?: string;
  }): Promise<void>;
  stopAll(): Promise<unknown>;
}

/** Stable notification id so start/stop always address the same notification. */
const NOTIFICATION_ID = 92140;
/**
 * Brand accent tint for the notification (matches the app's notification icon).
 * Mirrors `colors.accent`; kept as a literal because this module is imported by
 * node-environment unit tests and must not pull in the RN-facing theme.
 */
const NOTIFICATION_COLOR = "#ff8c1a";
/**
 * Small status-bar icon. `notification_icon` is the monochrome drawable Expo's
 * expo-notifications plugin generates from assets/notification-icon.png at
 * prebuild — the same icon the app's push notifications use. A name that does
 * not resolve would post an iconless notification and could fail startForeground.
 */
const SMALL_ICON = "notification_icon";

/**
 * The type currently running, or null when the service is down. Tracked (rather
 * than a plain boolean) so widening `microphone` → `microphone|camera` when the
 * user turns their camera on re-issues start() instead of being swallowed by an
 * idempotence check and leaving the camera unprotected.
 */
let runningType: VoiceForegroundServiceType | null = null;
let pending = false;
let cached: ForegroundServiceApi | null | undefined;

/**
 * Resolve the native FGS module once. Lazy + guarded so this file stays
 * importable under node (unit tests) and never throws in Expo Go or on iOS,
 * where the native module is absent. iOS keeps audio alive via the
 * UIBackgroundModes audio/voip declared in app.json — no foreground service
 * is needed there.
 */
function loadForegroundService(): ForegroundServiceApi | null {
  if (cached !== undefined) return cached;
  cached = null;
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { Platform } = require("react-native") as {
      Platform: { OS: string };
    };
    if (Platform.OS !== "android") return cached;
    const mod = require("@supersami/rn-foreground-service") as {
      default?: ForegroundServiceApi;
    } & ForegroundServiceApi;
    /* eslint-enable @typescript-eslint/no-require-imports */
    const api = (mod.default ?? mod) as ForegroundServiceApi;
    // register() must run once before start(): it wires the headless task the
    // service loops on and the native error listener. A failure here just leaves
    // the service unavailable rather than tearing down voice.
    api.register({
      config: {
        alert: false,
        onServiceErrorCallBack: () => {
          // The native side reports a failed startForeground through this event,
          // NOT through the start() promise (which resolves as soon as the
          // Intent is accepted). Clearing the cached type lets the controller
          // retry on the next foreground instead of believing a dead service.
          runningType = null;
        },
      },
    });
    cached = api;
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * Drive the native service towards `desired`, given what is `current`ly
 * running. Returns the new current type.
 *
 * WHY A TYPE CHANGE MUST STOP FIRST — the trap this function exists to avoid.
 * `@supersami/rn-foreground-service`'s JS `start()` opens with
 * `if (!serviceRunning)` and otherwise returns SILENTLY. So calling start()
 * again to widen `microphone` → `microphone|camera` never reaches
 * `startForeground` at all: our bookkeeping would say the camera was covered
 * while the native service stayed microphone-only, and the camera would still
 * freeze on the founder's exact repro. A widen therefore does stop → start.
 *
 * The gap between the two is harmless BECAUSE the caller only ever changes type
 * while the app is in the foreground (Android refuses a background start of a
 * while-in-use service anyway) — nothing is being kept alive across the gap.
 *
 * Injectable `api` so the sequencing above is unit-tested; the native module is
 * never loaded in tests.
 */
export async function applyForegroundServicePlan(
  api: ForegroundServiceApi,
  desired: VoiceForegroundServiceType | null,
  current: VoiceForegroundServiceType | null,
  notification: { title: string; message: string },
): Promise<VoiceForegroundServiceType | null> {
  if (desired === current) return current;
  if (desired === null) {
    await api.stopAll();
    return null;
  }
  // Changing type: tear the old service down first, or the library swallows it.
  if (current !== null) await api.stopAll();
  await api.start({
    id: NOTIFICATION_ID,
    title: notification.title,
    message: notification.message,
    ServiceType: desired,
    importance: "low", // quiet, ongoing status — no sound / heads-up
    color: NOTIFICATION_COLOR,
    icon: SMALL_ICON,
    setOnlyAlertOnce: "true",
  });
  return desired;
}

/**
 * Start (or widen) the voice foreground service.
 *
 * Idempotent for an unchanged type; a no-op when the native module is
 * unavailable (Expo Go / iOS / tests).
 *
 * MUST be called while the app is in the foreground: Android forbids starting —
 * or widening — a while-in-use foreground service from the background, so the
 * caller gates on AppState.
 */
export async function startVoiceForegroundService(
  type: VoiceForegroundServiceType,
  title: string,
  message: string,
): Promise<void> {
  const api = loadForegroundService();
  if (!api || pending || runningType === type) return;
  pending = true;
  try {
    runningType = await applyForegroundServicePlan(api, type, runningType, {
      title,
      message,
    });
  } catch (err) {
    runningType = null;
    console.warn("[voice] foreground service failed to start", type, err);
  } finally {
    pending = false;
  }
}

/** Stop the voice foreground service. Idempotent; safe when unavailable. */
export async function stopVoiceForegroundService(): Promise<void> {
  const api = loadForegroundService();
  runningType = null;
  if (!api) return;
  try {
    await api.stopAll();
  } catch (err) {
    console.warn("[voice] foreground service failed to stop", err);
  }
}
