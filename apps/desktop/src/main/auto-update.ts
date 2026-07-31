import { app, BrowserWindow, ipcMain } from "electron";
import { autoUpdater, type ProgressInfo, type UpdateInfo } from "electron-updater";
import { z } from "zod";
import { UPDATE_CHANNELS, type UpdateStatus } from "./auto-update-types";
import {
  clearPendingUpdate,
  decidePendingApply,
  isVersionOlder,
  readPendingUpdate,
  writePendingUpdate,
} from "./pending-update";

/**
 * Auto-update (main process) — electron-updater.
 *
 * Milestone 6: the app updates itself so nobody re-downloads installers by hand.
 * Releases are plain files served over HTTPS (electron-builder's *generic*
 * provider): the feed hosts `latest.yml` + the installer, and — for mandatory
 * releases — a side-car `critical.json`. See docs/architecture/desktop-packaging.md.
 *
 * Two update classes:
 *   - NON-CRITICAL (default): on launch we check and NOTIFY the renderer. The
 *     download is then started by one of exactly two things, never by the
 *     updater itself (`autoDownload = false`):
 *       1. the renderer's COLD-START flow, while the boot splash is up — the
 *          founder's "açılışta yeni sürüm varsa indirsin" (see the renderer's
 *          lib/boot-update.ts; it drives this over the same `downloadAndInstall`
 *          IPC the badge uses, and gives up on its own deadlines so a slow feed
 *          can never stop the app from opening);
 *       2. the user pressing the top-right update badge ("indir" ->
 *          "Yeniden başlat") at any time afterwards.
 *     Nothing downloads silently while the user is working in the app.
 *   - CRITICAL (forced): if the side-car marks the available version mandatory,
 *     we auto-download it and, once ready, `quitAndInstall()` WITHOUT letting the
 *     user skip. The renderer shows a blocking "Zorunlu güncelleme" overlay while
 *     this happens; the real enforcement is here in main (auto-download + quit),
 *     not the UI.
 *
 * "Downloaded but never restarted" (founder requirement)
 * -----------------------------------------------------
 * A user who downloads an update and then just closes the app must NOT be asked
 * again on the next launch. Two mechanisms cover that, and between them there is
 * no exit path that loses the update:
 *   1. `autoInstallOnAppQuit = true` — the normal exit. electron-updater runs the
 *      silent installer on the `quit` event, so the next launch is already the new
 *      build. Note this only fires on a REAL quit: with close-to-tray on, the
 *      window's X hides the app (no quit, nothing installed) and the update keeps
 *      waiting — which is correct, the app never actually exited.
 *   2. The `pending-update.json` marker (see ./pending-update.ts) — the crash /
 *      force-kill / power-cut exit, where `quit` never fires and (1) cannot run.
 *      The next launch finds the marker, silently re-requests the download (the
 *      package is already in electron-updater's cache, so it resolves near
 *      instantly) and installs + relaunches. Bounded by an attempt counter, so an
 *      installer that cannot run degrades back to the manual flow instead of
 *      looping.
 *
 * Security posture (CLAUDE.md §9, §28):
 *   - HTTPS ONLY. The feed override and the side-car fetch both reject any
 *     non-`https:` URL — an update is never pulled over plaintext.
 *   - Guarded off unless `app.isPackaged` (never runs under `electron-vite dev`).
 *   - The renderer -> main IPC calls are ALL argument-free (check / getStatus /
 *     downloadAndInstall); there is no inbound payload to validate or spoof. The
 *     only bytes that cross are the outbound status the main process authors.
 *   - `downloadAndInstall` is state-guarded, so a compromised renderer cannot
 *     force an unexpected install/quit — it only acts from `available`/`ready`.
 *   - The untrusted network document (`critical.json`) IS zod-validated + bounded
 *     before it can influence behaviour, and a missing/broken one fails safe to
 *     NON-critical (never bricks users into a forced-update loop).
 */

// ---------------------------------------------------------------------------
// Feed configuration
// ---------------------------------------------------------------------------

/**
 * Default HTTPS feed baked into `electron-builder.yml` (`publish.url`). Keep this
 * in sync with that file — it is the base the side-car `critical.json` is fetched
 * from when no env override is present.
 */
const DEFAULT_FEED = "https://api.getdemli.com/dl/desktop/";

/**
 * electron-updater channel — MUST equal `publish.channel` in
 * electron-builder.yml (asserted by auto-update-channel.test.ts).
 *
 * It decides which manifest this build reads out of the shared feed directory:
 * `demli` → `demli.yml`. Losing this value does not fail — it silently falls
 * back to `latest`, i.e. the build starts polling a manifest nobody publishes
 * and never updates again — which is exactly why it is a named constant with a
 * test on it rather than a default.
 */
export const UPDATE_CHANNEL: string = "demli";

/**
 * The forced-update side-car, named after the channel: `demli-critical.json`.
 *
 * Channel-scoped for the same reason the manifest is: a build must never obey a
 * forced-update floor that was aimed at a different version line.
 */
function criticalFileName(): string {
  return UPDATE_CHANNEL === "latest" ? "critical.json" : `${UPDATE_CHANNEL}-critical.json`;
}

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

function withTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/**
 * An optional runtime feed override, from env, for self-hosting / QA:
 *   - `DEMLI_UPDATE_URL` — explicit feed base (must be https).
 *   - else `DEMLI_DOMAIN` — derives `https://api.<domain>/dl/desktop/`,
 *     mirroring how the renderer's API/WS URLs are derived at package time.
 *     (The feed rides the api subdomain so no separate `dl` DNS record is
 *     needed; a `dl.<domain>` vhost serves the same files once its record
 *     exists.)
 * Returns null to fall back to the baked `app-update.yml` (default feed).
 */
function overrideFeedUrl(): string | null {
  const explicit = process.env["DEMLI_UPDATE_URL"]?.trim();
  if (explicit) {
    if (!isHttps(explicit)) {
      console.warn(
        "[auto-update] ignoring non-https DEMLI_UPDATE_URL (updates are https-only).",
      );
      return null;
    }
    return withTrailingSlash(explicit);
  }
  const domain = process.env["DEMLI_DOMAIN"]?.trim();
  if (domain) {
    return `https://api.${domain}/dl/desktop/`;
  }
  return null;
}

/** The feed base used for the side-car fetch (override, else baked default). */
function feedBase(): string {
  return overrideFeedUrl() ?? DEFAULT_FEED;
}

// ---------------------------------------------------------------------------
// Critical-update side-car (`critical.json`)
// ---------------------------------------------------------------------------

/** `^major.minor.patch`, optionally with a `-pre`/`+build` suffix. */
const VERSION_RE = /^\d+\.\d+\.\d+([-+].*)?$/;

/**
 * Shape of the feed's `critical.json`. Non-strict on purpose: unknown keys are
 * ignored so a newer document never breaks an older client.
 *   - `minVersion` — force-update any install OLDER than this version.
 *   - `critical`   — force-update the currently-available release unconditionally.
 */
const criticalSchema = z.object({
  minVersion: z.string().regex(VERSION_RE).max(64).optional(),
  critical: z.boolean().optional(),
});

/**
 * Decide whether the currently-installed app must force-update, by consulting
 * the feed's `critical.json`. Semantics: `critical: true` forces unconditionally;
 * `minVersion` forces any install OLDER than it (i.e. bump `minVersion` to a
 * release to make everyone below it update). FAILS SAFE: any error, non-https
 * URL, missing file, or invalid document => NON-critical (the user can still
 * update, we just don't force it — never brick users into a forced-update loop).
 */
async function resolveCritical(): Promise<boolean> {
  const url = `${feedBase()}${criticalFileName()}`;
  if (!isHttps(url)) {
    return false;
  }
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      return false;
    }
    const parsed = criticalSchema.safeParse(await res.json());
    if (!parsed.success) {
      return false;
    }
    if (parsed.data.critical === true) {
      return true;
    }
    if (parsed.data.minVersion) {
      return isVersionOlder(app.getVersion(), parsed.data.minVersion);
    }
    return false;
  } catch {
    // Network / parse failure — never force on uncertainty.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let ipcRegistered = false;
/** True only in a packaged build; false disables all update activity. */
let enabled = false;
/** Latest status — pushed to renderers and returned by getStatus(). */
let lastStatus: UpdateStatus = { kind: "disabled" };
/** Version of the update currently being handled (for progress/ready status). */
let pendingVersion = "";
/** Whether the pending update is mandatory (drives the blocking overlay + auto-quit). */
let currentCritical = false;
/**
 * Version a PREVIOUS run downloaded but never installed (crash / force-kill path
 * — see the header note). Non-null means this launch should silently finish that
 * update as soon as the feed confirms it: download from cache, then quit+install.
 */
let autoApplyVersion: string | null = null;
/**
 * How many launches have already tried to auto-apply the pending update. Written
 * into the marker so the retry budget survives a crash; a fresh, user-initiated
 * download starts from 0.
 */
let pendingAttempts = 0;
/**
 * A `downloadUpdate()` is running. There are now three callers (critical
 * auto-download, crash-recovery resume, and the `downloadAndInstall` IPC that
 * both the boot flow and the badge use), so re-entry is guarded here rather than
 * relying on each of them to check the status first — two concurrent downloads
 * of the same package would fight over the cache file.
 */
let downloadInFlight = false;
/** The launch re-checks (see {@link armLaunchRechecks}) are scheduled. */
let launchRechecksArmed = false;

/**
 * Delays for the post-launch re-checks. A machine that just booted routinely has
 * no working DNS for the first few seconds, and the launch check is precisely
 * when auto-start apps run — so a single attempt would leave those users on an
 * old build all session. These only RE-CHECK; they never start a download.
 */
const LAUNCH_RECHECK_DELAYS_MS = [10_000, 45_000] as const;

/**
 * How often a RUNNING app looks for a new version.
 *
 * Without this the app checked exactly once, at launch. Demli is left open all
 * day, so a release published an hour after someone started the app was
 * invisible to them until they restarted it or opened Settings and pressed the
 * button — which is the founder's report: "yeni sürüm geldiğini ancak ayarlara
 * gidip güncellemeyi kontrol et'e basınca oluyor". The badge worked; nothing
 * ever told it to look.
 *
 * 30 minutes is a `latest.yml` fetch — a few hundred bytes against our own
 * server. The cost of checking too often is nothing; the cost of checking too
 * rarely is a user sitting on a version with a bug we already fixed.
 */
const PERIODIC_CHECK_MS = 30 * 60 * 1000;

/**
 * Floor between focus-triggered checks. Focus fires constantly (alt-tab, click
 * back from a browser), and without a floor a busy user would hammer the feed
 * for no benefit — the periodic timer already covers them.
 */
const FOCUS_CHECK_FLOOR_MS = 10 * 60 * 1000;

/** When the last check STARTED, for the focus floor. 0 = never checked. */
let lastCheckStartedAt = 0;

// ---------------------------------------------------------------------------
// Status broadcast
// ---------------------------------------------------------------------------

function broadcast(status: UpdateStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(UPDATE_CHANNELS.status, status);
    }
  }
}

function setStatus(status: UpdateStatus): void {
  lastStatus = status;
  broadcast(status);
}

// ---------------------------------------------------------------------------
// electron-updater wiring
// ---------------------------------------------------------------------------

function configureFeed(): void {
  const url = overrideFeedUrl();
  if (!url) {
    return; // use the baked app-update.yml (generic provider from publish config)
  }
  try {
    // `channel` is NOT optional here. Omitted, electron-updater's generic
    // provider defaults to `latest` — so an env-overridden feed would send this
    // build to the FROZEN old-identity manifest and it would never see another
    // release. The baked app-update.yml carries the channel already; this path
    // has to carry it too.
    autoUpdater.setFeedURL({ provider: "generic", url, channel: UPDATE_CHANNEL });
  } catch (err) {
    console.warn("[auto-update] failed to apply feed URL override:", err);
  }
}

/**
 * True when this available version is the one a previous run already downloaded
 * and never installed, so this launch should finish the job without asking. The
 * comparison is `>=` (not `===`) on purpose: if an even newer release landed in
 * the meantime, resuming into THAT one is still the right outcome — the user
 * already consented to updating, and the pending package is obsolete anyway.
 */
function shouldAutoApply(version: string): boolean {
  if (autoApplyVersion === null) {
    return false;
  }
  return version === autoApplyVersion || !isVersionOlder(version, autoApplyVersion);
}

/**
 * Start the package download, at most once at a time. Reports failure as the
 * `download` error status (the renderer localizes it) and never throws.
 */
async function beginDownload(context: string): Promise<void> {
  if (downloadInFlight) {
    return;
  }
  downloadInFlight = true;
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    console.error(`[auto-update] ${context} download failed:`, err);
    setStatus({ kind: "error", scope: "download" });
  } finally {
    downloadInFlight = false;
  }
}

async function handleUpdateAvailable(info: UpdateInfo): Promise<void> {
  pendingVersion = info.version;
  currentCritical = await resolveCritical();
  setStatus({ kind: "available", version: info.version, critical: currentCritical });

  // Auto-download when the update is MANDATORY, or when it is the resume of an
  // update a previous run already downloaded (see the header note). Both paths
  // need no user action; only the critical one blocks the UI. The ORDINARY
  // launch case is not here: it is the renderer's boot flow that asks, so the
  // splash can narrate it and abandon it on its own deadline.
  const resume = !currentCritical && shouldAutoApply(info.version);
  if (currentCritical || resume) {
    setStatus({
      kind: "downloading",
      version: info.version,
      percent: 0,
      critical: currentCritical,
    });
    await beginDownload(currentCritical ? "critical" : "resume");
  }
}

function wireEvents(): void {
  autoUpdater.on("checking-for-update", () => {
    setStatus({ kind: "checking" });
  });

  autoUpdater.on("update-available", (info: UpdateInfo) => {
    void handleUpdateAvailable(info);
  });

  autoUpdater.on("update-not-available", (info: UpdateInfo) => {
    setStatus({ kind: "up-to-date", version: info.version });
  });

  autoUpdater.on("download-progress", (progress: ProgressInfo) => {
    setStatus({
      kind: "downloading",
      version: pendingVersion,
      percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
      critical: currentCritical,
    });
  });

  autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
    setStatus({
      kind: "ready",
      version: info.version,
      critical: currentCritical,
    });
    // Record "downloaded, not yet installed" BEFORE any quit, so a crash between
    // now and the install is recoverable on the next launch. Cleared there once
    // the running version has caught up.
    void writePendingUpdate(app.getPath("userData"), {
      version: info.version,
      attempts: pendingAttempts,
    });
    if (currentCritical) {
      // Forced: install now, no skip. A short delay lets the renderer paint the
      // blocking overlay first. quitAndInstall() -> app quit; the system module's
      // `before-quit` guard lets the window close past close-to-tray.
      // (isSilent=true, isForceRunAfter=true): install silently (no NSIS wizard,
      // requires nsis.oneClick in electron-builder.yml) and relaunch the app.
      setTimeout(() => autoUpdater.quitAndInstall(true, true), 1200);
      return;
    }
    if (shouldAutoApply(info.version)) {
      // Resuming a download the previous run never installed: apply it silently
      // and relaunch. No overlay, no prompt — the user already agreed to this
      // update; from their side the app just starts (fast, because the package
      // came from the cache) on the new version.
      setTimeout(() => autoUpdater.quitAndInstall(true, true), 300);
    }
  });

  autoUpdater.on("error", (err: Error) => {
    console.error("[auto-update] error:", err);
    setStatus({ kind: "error", scope: "check" });
  });
}

// ---------------------------------------------------------------------------
// Commands (driven by IPC)
// ---------------------------------------------------------------------------

async function runCheck(): Promise<UpdateStatus> {
  if (!enabled) {
    return lastStatus;
  }
  lastCheckStartedAt = Date.now();
  setStatus({ kind: "checking" });
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    console.error("[auto-update] check failed:", err);
    setStatus({ kind: "error", scope: "check" });
  }
  return lastStatus;
}

async function applyUpdate(): Promise<void> {
  if (!enabled) {
    return;
  }
  if (lastStatus.kind === "ready") {
    // Silent install + relaunch, no Setup wizard (see the critical path above).
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 100);
    return;
  }
  if (lastStatus.kind === "available") {
    setStatus({
      kind: "downloading",
      version: lastStatus.version,
      percent: 0,
      critical: lastStatus.critical,
    });
    await beginDownload("requested");
    return;
  }
  // Any other state (checking / downloading / up-to-date / error / disabled): no-op.
}

/**
 * Re-run the launch check a couple of times if — and only if — it FAILED. The
 * cold-boot case this exists for: the app auto-starts with Windows, the network
 * stack is not up yet, the first check errors, and without this the user stays
 * on an old build until they restart the app.
 *
 * Deliberately narrow: it stops the moment any check succeeds (`error` is the
 * only status it will act on), it never downloads anything, and it is bounded to
 * {@link LAUNCH_RECHECK_DELAYS_MS}.length attempts. The timers are unref'd so
 * they can never hold the process open at quit.
 */
function armLaunchRechecks(): void {
  if (launchRechecksArmed) {
    return;
  }
  launchRechecksArmed = true;
  for (const delay of LAUNCH_RECHECK_DELAYS_MS) {
    setTimeout(() => {
      if (!enabled || lastStatus.kind !== "error") {
        return;
      }
      console.info(`[auto-update] retrying the launch check after ${delay}ms.`);
      void runCheck();
    }, delay).unref();
  }
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

function registerIpc(): void {
  if (ipcRegistered) {
    return;
  }
  ipcRegistered = true;

  // All three are argument-free: no untrusted payload crosses the boundary, so
  // there is nothing to zod-validate here (unlike the capture/token handlers).
  ipcMain.handle(UPDATE_CHANNELS.check, async () => runCheck());
  ipcMain.handle(UPDATE_CHANNELS.getStatus, async () => lastStatus);
  ipcMain.handle(UPDATE_CHANNELS.downloadAndInstall, async () => {
    await applyUpdate();
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Read the crash-recovery marker and arm the silent resume when a previous run
 * downloaded an update that never got installed. Also does the housekeeping:
 * a marker whose version we are already running (the normal quit-time install
 * worked) or whose retry budget is spent is deleted.
 */
function armPendingResume(): void {
  const userDataDir = app.getPath("userData");
  const decision = decidePendingApply(readPendingUpdate(userDataDir), app.getVersion());
  switch (decision.action) {
    case "none":
      return;
    case "clear":
      console.info(`[auto-update] clearing pending marker (${decision.reason}).`);
      void clearPendingUpdate(userDataDir);
      return;
    case "apply":
      autoApplyVersion = decision.version;
      pendingAttempts = decision.attempts;
      // Persist the incremented attempt BEFORE trying, so a launch that dies
      // mid-install still burns the budget and cannot loop forever.
      void writePendingUpdate(userDataDir, {
        version: decision.version,
        attempts: decision.attempts,
      });
      console.info(
        `[auto-update] resuming un-installed update ${decision.version} ` +
          `(attempt ${decision.attempts}).`,
      );
      return;
  }
}

/**
 * Wire up auto-update. Call once, after `app.whenReady()` and after the main
 * window exists, from the main process.
 *
 * The IPC handlers register in every build so the renderer's settings UI works
 * in dev too (it just reports `disabled`). The actual update check only runs in a
 * packaged build (`app.isPackaged`) — never under `electron-vite dev`.
 */
export function registerAutoUpdater(): void {
  registerIpc();

  if (!app.isPackaged) {
    lastStatus = { kind: "disabled" };
    console.info("[auto-update] not packaged — skipping update check in dev.");
    return;
  }

  enabled = true;
  // We control the download lifecycle explicitly (see the critical vs optional
  // split above), so disable electron-updater's own auto-download.
  autoUpdater.autoDownload = false;
  // A downloaded update installs itself on a real quit, so a user who never
  // presses "Yeniden başlat" still comes back to the new version next time.
  autoUpdater.autoInstallOnAppQuit = true;
  configureFeed();
  wireEvents();
  // Must run before the check: it decides whether the incoming `update-available`
  // is a silent resume or an ordinary notification.
  armPendingResume();

  // Initial check on launch: notifies (non-critical, which the renderer's boot
  // flow then acts on while the splash is up), force-updates (critical), or
  // silently finishes an un-installed download (resume).
  void runCheck();
  armLaunchRechecks();
  armPeriodicChecks();
}

/**
 * Keep looking while the app runs — see {@link PERIODIC_CHECK_MS}.
 *
 * Two triggers, because they cover different users. The interval catches the app
 * left open in the background; focus catches the person who comes back to it
 * after hours asleep, where a timer may have been throttled or the machine
 * suspended outright.
 *
 * Never checks over an in-flight one: `checking` means a request is already out,
 * and `downloading` means we are past checking and mid-transfer — restarting
 * that would abandon a partial download for no reason. The timer is unref'd so
 * it can never hold the process open at quit.
 */
function armPeriodicChecks(): void {
  const shouldCheck = (): boolean =>
    enabled && lastStatus.kind !== "checking" && lastStatus.kind !== "downloading";

  setInterval(() => {
    if (shouldCheck()) void runCheck();
  }, PERIODIC_CHECK_MS).unref();

  app.on("browser-window-focus", () => {
    if (!shouldCheck()) return;
    if (Date.now() - lastCheckStartedAt < FOCUS_CHECK_FLOOR_MS) return;
    void runCheck();
  });
}
