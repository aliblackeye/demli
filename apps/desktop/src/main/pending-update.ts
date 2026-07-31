import { promises as fs } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * "An update was downloaded but never installed" marker (main process).
 *
 * WHY THIS EXISTS
 * ---------------
 * `autoUpdater.autoInstallOnAppQuit = true` covers the NORMAL exit: the user
 * downloads an update, keeps working, then quits — electron-updater runs the
 * silent installer on the `quit` event, so the next launch is already the new
 * version. Nothing else is needed for that path.
 *
 * It does NOT cover an exit that never reaches `quit`: a crash, a `taskkill`, a
 * power cut, or a Windows sign-out that force-closes the process. In those cases
 * the downloaded package just sits in electron-updater's cache and the user is
 * asked to update again on the next launch — the founder's explicit complaint
 * ("indirip yeniden başlatma yapmadıysa bir sonraki açılışta otomatik
 * güncellesin").
 *
 * So on every `update-downloaded` we write this tiny marker; on the next launch
 * {@link decidePendingApply} reads it and answers one question: should this
 * launch silently finish the update the previous run started?
 *
 * FAIL-SAFE, NEVER A LOOP
 * -----------------------
 *   - The marker is cleared as soon as the running version has caught up with
 *     it, which is the normal case (the quit-time install worked).
 *   - Every auto-apply attempt increments `attempts`. After
 *     {@link MAX_AUTO_APPLY_ATTEMPTS} failures the marker is dropped and the app
 *     falls back to the ordinary "an update is available" flow. An installer that
 *     cannot run (blocked by policy, corrupt package, no write permission) can
 *     therefore never trap the user in a relaunch loop.
 *   - Any I/O or parse failure degrades to "no pending update" — the marker is an
 *     optimization, never a dependency.
 *
 * The file holds a version string and a small integer. No secrets, so plain JSON
 * (same posture as `desktop-settings.json`).
 */

/** File name under the app's userData directory. */
export const PENDING_UPDATE_FILE = "pending-update.json";

/**
 * How many launches may try to auto-apply the same downloaded update before we
 * give up and hand the user back the manual flow.
 */
export const MAX_AUTO_APPLY_ATTEMPTS = 2;

/** `^major.minor.patch`, optionally with a `-pre`/`+build` suffix. */
const VERSION_RE = /^\d+\.\d+\.\d+([-+].*)?$/;

/**
 * On-disk shape. Strict about the version (it decides whether we quit + install)
 * and bounded on `attempts` so a hand-edited file cannot request infinite retries.
 */
const pendingUpdateSchema = z.object({
  version: z.string().regex(VERSION_RE).max(64),
  attempts: z.number().int().min(0).max(100),
});

/** A downloaded-but-not-installed update recorded by a previous run. */
export type PendingUpdateMarker = z.infer<typeof pendingUpdateSchema>;

/** What this launch should do about the marker it found. */
export type PendingUpdateDecision =
  /** No marker, or nothing to do. */
  | { action: "none" }
  /** Marker is stale/exhausted — delete it and behave normally. */
  | { action: "clear"; reason: "installed" | "exhausted" }
  /**
   * Silently finish the update: download (the package is already in
   * electron-updater's cache, so this resolves near-instantly) then
   * quitAndInstall. `attempts` is the value to persist BEFORE trying.
   */
  | { action: "apply"; version: string; attempts: number };

/** Numeric major.minor.patch compare (prerelease/build suffixes ignored). */
export function isVersionOlder(current: string, other: string): boolean {
  const parse = (v: string): number[] =>
    v
      .split("+")[0]!
      .split("-")[0]!
      .split(".")
      .map((p) => Number.parseInt(p, 10) || 0);
  const [a = 0, b = 0, c = 0] = parse(current);
  const [x = 0, y = 0, z = 0] = parse(other);
  if (a !== x) return a < x;
  if (b !== y) return b < y;
  return c < z;
}

/**
 * Decide what to do with a marker found at launch. Pure — the caller does the
 * I/O and owns the updater, so this is directly unit-testable.
 *
 * @param marker - the parsed marker, or null when there is none / it was invalid.
 * @param currentVersion - `app.getVersion()` for THIS running build.
 */
export function decidePendingApply(
  marker: PendingUpdateMarker | null,
  currentVersion: string,
): PendingUpdateDecision {
  if (!marker) {
    return { action: "none" };
  }
  // The running build already is (or is newer than) the pending version: the
  // quit-time install did its job. Nothing pending any more.
  if (!isVersionOlder(currentVersion, marker.version)) {
    return { action: "clear", reason: "installed" };
  }
  if (marker.attempts >= MAX_AUTO_APPLY_ATTEMPTS) {
    return { action: "clear", reason: "exhausted" };
  }
  return { action: "apply", version: marker.version, attempts: marker.attempts + 1 };
}

// ---------------------------------------------------------------------------
// Persistence (best effort — every failure degrades to "no pending update")
// ---------------------------------------------------------------------------

function markerPath(userDataDir: string): string {
  return join(userDataDir, PENDING_UPDATE_FILE);
}

/** Read + validate the marker synchronously at startup. Null when absent/corrupt. */
export function readPendingUpdate(userDataDir: string): PendingUpdateMarker | null {
  try {
    const parsed = pendingUpdateSchema.safeParse(
      JSON.parse(readFileSync(markerPath(userDataDir), "utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Write the marker (atomic rename, like the desktop settings file). */
export async function writePendingUpdate(
  userDataDir: string,
  marker: PendingUpdateMarker,
): Promise<void> {
  const path = markerPath(userDataDir);
  const tmp = `${path}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(marker), "utf8");
    await fs.rename(tmp, path);
  } catch {
    // Disk full / permissions — we simply lose the crash-recovery hint.
  }
}

/** Delete the marker. Missing file is success. */
export async function clearPendingUpdate(userDataDir: string): Promise<void> {
  try {
    await fs.rm(markerPath(userDataDir), { force: true });
  } catch {
    // ignore
  }
}
