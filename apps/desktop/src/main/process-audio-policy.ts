import { z } from "zod";
import {
  PROCESS_LOOPBACK_MIN_WINDOWS_BUILD,
  type ProcessAudioMode,
  type ProcessAudioStartRequest,
  type ProcessAudioSupport,
} from "./process-audio-types";

/**
 * Pure decisions behind the process-audio IPC (no electron, no node:child_process),
 * kept apart from `process-audio.ts` so they run in plain-Node unit tests.
 */

/** Windows build number from `os.release()` ("10.0.22631" → 22631). */
export function windowsBuildFromRelease(release: string): number | null {
  const match = /^\d+\.\d+\.(\d+)/.exec(release.trim());
  if (!match?.[1]) return null;
  const build = Number.parseInt(match[1], 10);
  return Number.isInteger(build) ? build : null;
}

/** Whether this OS can capture by process at all (binaries checked separately). */
export function platformSupport(platform: string, release: string): ProcessAudioSupport {
  if (platform !== "win32") return { supported: false, reason: "unsupported_platform" };
  const build = windowsBuildFromRelease(release);
  if (build === null || build < PROCESS_LOOPBACK_MIN_WINDOWS_BUILD) {
    return { supported: false, reason: "unsupported_os" };
  }
  return { supported: true };
}

/**
 * True when including `targetPid`'s process tree would also include Demli:
 * the target IS Demli's main process, or is one of its ancestors (Explorer
 * launches Demli from the Start menu, so sharing an Explorer window in "app"
 * mode would capture the call).
 */
export function appTargetIncludesDemli(
  targetPid: number,
  ownPid: number,
  ownAncestors: readonly number[],
): boolean {
  return targetPid === ownPid || ownAncestors.includes(targetPid);
}

/** Helper arguments for a capture. "system" always targets Demli's own tree. */
export function helperCaptureArgs(
  mode: ProcessAudioMode,
  targetPid: number,
): [string, "include" | "exclude"] {
  return [String(targetPid), mode === "app" ? "include" : "exclude"];
}

/** Parse the helper's one-PID-per-line output, dropping anything malformed. */
export function parsePidLines(stdout: string): number[] {
  const pids: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!/^\d+$/.test(trimmed)) continue;
    const pid = Number.parseInt(trimmed, 10);
    if (Number.isSafeInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

/** The decimal HWND inside an Electron window source id (`window:<HWND>:<n>`). */
export function hwndOfWindowSource(sourceId: string): string | null {
  const match = /^window:(\d+):\d+$/.exec(sourceId);
  return match?.[1] ?? null;
}

/**
 * How long after picking a source in the share picker a capture may start. The
 * renderer starts the sound IN PARALLEL with getDisplayMedia (so the video may
 * not be served yet), and "app" sound needs a PID lookup first — seconds, not
 * minutes.
 */
export const SHARE_GRANT_WINDOW_MS = 15_000;

/**
 * What a webContents is entitled to, from the capture module's view: the source
 * it last armed in the share picker, when, and whether main then served that
 * source to a getDisplayMedia (i.e. a share is live).
 */
export interface ShareGrant {
  sourceId: string;
  armedAt: number;
  served: boolean;
}

/**
 * May this start request capture sound? Only for a share the user started in
 * the SAME webContents: a source armed through the picker moments ago, or a share
 * main served and that has not been released since. "app" must target the very
 * window being shared. Without this, any renderer code could call
 * `processAudio.start({ mode: "system" })` and silently record the PC.
 */
export function processAudioStartAllowed(
  request: ProcessAudioStartRequest,
  grant: ShareGrant | null,
  now: number,
): boolean {
  if (!grant) return false;
  if (request.mode === "app" && request.sourceId !== grant.sourceId) return false;
  if (grant.served) return true;
  const age = now - grant.armedAt;
  return age >= 0 && age <= SHARE_GRANT_WINDOW_MS;
}

/** IPC payload schema for a start request — the only shape main accepts. */
export const processAudioStartSchema: z.ZodType<ProcessAudioStartRequest> = z.discriminatedUnion(
  "mode",
  [
    z.object({ mode: z.literal("app"), sourceId: z.string().min(1).max(256) }).strict(),
    z.object({ mode: z.literal("system") }).strict(),
  ],
);

export const processAudioStopSchema = z.number().int().nonnegative();
