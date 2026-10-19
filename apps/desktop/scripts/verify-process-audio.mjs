// Numeric proof for the process-audio helper (Windows only, plays short tones).
//
//   node apps/desktop/scripts/verify-process-audio.mjs             # helper modes
//   node apps/desktop/scripts/verify-process-audio.mjs --electron  # + Demli-style exclusion
//   node apps/desktop/scripts/verify-process-audio.mjs --packaged  # + packaged (UWP) window
//
// Part 1 (always): two child processes play different tones at the same time —
// A = 613 Hz, B = 1471 Hz. The helper captures include(A) and exclude(A) in
// parallel and each capture is measured with the Goertzel algorithm.
//   include(A) must carry A and not B; exclude(A) must carry B and not A.
//
// Part 2 (--electron): a real Electron app plays B through an <audio> element
// (the way LiveKit plays remote voices) while a separate process plays A.
// exclude(<electron main PID>) — exactly what Demli's "system sound" mode does
// with process.pid — must carry A and not B, and include(<electron main PID>)
// must carry B, which proves Electron's audio output (rendered by its
// audio-service child process) belongs to the main process tree.
//
// Part 3 (--packaged): Filmler ve TV (Microsoft.ZuneVideo, a packaged app whose
// top-level window belongs to ApplicationFrameHost.exe) plays C = 887 Hz.
// `--window-pid <frame hwnd>` must resolve to the app process, not the frame
// host; include(resolved) must carry C, and include(frame host) — what an
// unresolved "only this app" would capture — must not.
//
// Measurement: the level at the tone frequency over whole-second blocks.
//   PRESENT: level >= -40 dBFS and >= 15 dB above the local floor (mean of the
//            bins 4–12 Hz either side), i.e. a sharp spike.
//   ABSENT:  at least 40 dB below the same tone's level in the capture that
//            must carry it (the reference). No spike over the floor is not
//            enough: background audio raises the floor and could hide a leak
//            under it, so a check that cannot show 40 dB fails as INCONCLUSIVE
//            and asks for a quieter re-run.
// Tones are generated at -30 dBFS (quiet on purpose; capture is digital, so the
// 10 dB margin over PRESENT holds). Exit code 0 only when every check passes.
// Process loopback captures AFTER the per-app volume in the Windows mixer, so a
// muted electron.exe makes Part 2 fail (include finds no tone) rather than pass.
/* global console, process, Buffer, setTimeout */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(here, "..");
const helper = join(desktopDir, "resources", "process-audio", "win32-x64", "demli-audio-capture.exe");

const SAMPLE_RATE = 48000;
const TONE_AMPLITUDE = 0.0316; // -30 dBFS
const FREQ_A = 613;
const FREQ_B = 1471;
const PRESENT_DB = -40;
const PRESENT_PROMINENCE_DB = 15;
const REJECTION_DB = 40;
const FREQ_C = 887;
const PACKAGED_APP = "Microsoft.ZuneVideo_8wekyb3d8bbwe!Microsoft.ZuneVideo";
const CAPTURE_MS = 4500;
const ANALYSIS_SKIP_S = 1;
const MIN_ANALYSED_S = 2;
const TONE_SECONDS = 14;
/** Settle time after a player reports it started, before captures begin. */
const PLAYBACK_SETTLE_MS = 1000;

if (process.platform !== "win32") {
  console.error("verify-process-audio: Windows only.");
  process.exit(1);
}
if (!existsSync(helper)) {
  console.error(`helper missing: ${helper} — run build-process-audio.mjs first`);
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 16-bit stereo PCM WAV of a pure sine with 20 ms fades (no clicks). */
function sineWav(frequency, seconds) {
  const frames = Math.round(SAMPLE_RATE * seconds);
  const data = Buffer.alloc(frames * 4);
  const fade = Math.round(SAMPLE_RATE * 0.02);
  for (let i = 0; i < frames; i++) {
    const envelope = Math.min(1, i / fade, (frames - 1 - i) / fade);
    const v = Math.round(
      Math.sin((2 * Math.PI * frequency * i) / SAMPLE_RATE) * TONE_AMPLITUDE * envelope * 32767,
    );
    data.writeInt16LE(v, i * 4);
    data.writeInt16LE(v, i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Start a PowerShell process that plays `wavPath`; resolves once playback began. */
function playInPowerShell(wavPath) {
  const script =
    `$p = New-Object System.Media.SoundPlayer '${wavPath.replace(/'/g, "''")}'; ` +
    "$p.Load(); [Console]::Out.WriteLine('playing'); [Console]::Out.Flush(); $p.PlaySync()";
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const started = new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (b) => {
      out += b.toString();
      if (out.includes("playing")) resolve();
    });
    child.on("exit", (code) => reject(new Error(`tone player exited early (code ${code})`)));
    child.on("error", reject);
  });
  return { child, started };
}

/** Capture for `ms` after the helper reports `ready`, then close its stdin (the stop signal). */
function capture(pid, mode, ms) {
  return new Promise((resolve, reject) => {
    const child = spawn(helper, [String(pid), mode], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const chunks = [];
    let stderr = "";
    let timerStarted = false;
    child.stdout.on("data", (c) => chunks.push(c));
    child.stderr.on("data", (c) => {
      stderr += c.toString();
      if (!timerStarted && /^ready /m.test(stderr)) {
        timerStarted = true;
        setTimeout(() => child.stdin.end(), ms);
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`helper ${mode} ${pid} exited ${code}: ${stderr.trim()}`));
      else resolve({ pcm: Buffer.concat(chunks), stderr: stderr.trim() });
    });
    // Never hang on a helper that never becomes ready.
    setTimeout(() => {
      if (!timerStarted) child.stdin.end();
    }, ms + 10000);
  });
}

function goertzelAmplitude(pcm, startFrame, frames, frequency) {
  const coeff = 2 * Math.cos((2 * Math.PI * frequency) / SAMPLE_RATE);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < frames; i++) {
    const o = (startFrame + i) * 4;
    const x = (pcm.readInt16LE(o) + pcm.readInt16LE(o + 2)) / 2 / 32768;
    const s0 = x + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return (2 * Math.sqrt(Math.max(0, power))) / frames;
}

const toDb = (amplitude) => (amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity);

/**
 * Level of `frequency` and of its local floor over the mono mix of s16le
 * stereo PCM, in whole-second blocks (every test tone sits exactly on a bin
 * centre, so a pure tone does not leak into its neighbours).
 */
function toneLevels(pcm, frequency) {
  const frames = Math.floor(pcm.length / 4);
  const skip = Math.min(frames, Math.round(SAMPLE_RATE * ANALYSIS_SKIP_S));
  const block = SAMPLE_RATE;
  const blocks = Math.floor((frames - skip) / block);
  if (blocks < 1) return { db: -Infinity, floorDb: -Infinity, prominence: 0, seconds: 0 };
  const neighbours = [];
  for (let d = 4; d <= 12; d += 2) neighbours.push(frequency - d, frequency + d);
  let tone = 0;
  let floor = 0;
  for (let b = 0; b < blocks; b++) {
    const start = skip + b * block;
    tone += goertzelAmplitude(pcm, start, block, frequency);
    let sum = 0;
    for (const f of neighbours) sum += goertzelAmplitude(pcm, start, block, f);
    floor += sum / neighbours.length;
  }
  const db = toDb(tone / blocks);
  const floorDb = toDb(floor / blocks);
  const prominence = Number.isFinite(db) && Number.isFinite(floorDb) ? db - floorDb : 0;
  return { db, floorDb, prominence, seconds: blocks };
}

function fmt(db) {
  return Number.isFinite(db) ? `${db.toFixed(1)} dBFS` : "-inf dBFS";
}

const results = [];

function record(entry, note) {
  results.push(entry);
  console.log(
    `  ${entry.pass ? "PASS" : "FAIL"}  ${entry.label}: ${entry.frequency} Hz ` +
      `${entry.expected === "present" ? "present" : "absent "} → ${fmt(entry.db)}, ` +
      `${entry.prominence.toFixed(1)} dB over floor ${fmt(entry.floorDb)} (${entry.seconds}s analysed)` +
      (note ? ` — ${note}` : ""),
  );
}

/** A tone the capture must carry. Returns its level, the reference for absence checks. */
function expectPresent(label, pcm, frequency) {
  const { db, floorDb, prominence, seconds } = toneLevels(pcm, frequency);
  const enough = seconds >= MIN_ANALYSED_S;
  const pass = enough && db >= PRESENT_DB && prominence >= PRESENT_PROMINENCE_DB;
  record(
    { label, frequency, expected: "present", db, floorDb, prominence, seconds, pass },
    enough ? "" : `need ${MIN_ANALYSED_S}s`,
  );
  return pass ? db : null;
}

/**
 * A tone the capture must NOT carry, judged against `referenceDb` — the same
 * tone's level in the capture that does carry it (null when that check failed,
 * and then nothing can be proven).
 */
function expectAbsent(label, pcm, frequency, referenceDb) {
  const { db, floorDb, prominence, seconds } = toneLevels(pcm, frequency);
  const enough = seconds >= MIN_ANALYSED_S;
  const rejection = referenceDb === null ? null : referenceDb - db;
  const pass = enough && rejection !== null && rejection >= REJECTION_DB;
  let note;
  if (!enough) note = `need ${MIN_ANALYSED_S}s`;
  else if (rejection !== null) note = `${rejection.toFixed(1)} dB below the reference ${fmt(referenceDb)}`;
  else note = "no reference level";
  if (enough && !pass && prominence < PRESENT_PROMINENCE_DB) {
    note +=
      ` — INCONCLUSIVE: other audio on this PC holds the floor at ${fmt(floorDb)}, too loud to ` +
      `prove a ${REJECTION_DB} dB rejection; stop other playback and re-run`;
  }
  record({ label, frequency, expected: "absent", db, floorDb, prominence, seconds, pass }, note);
}

/** Open `file` in a packaged app; resolves with the app PID and its frame window. */
function openInPackagedApp(scriptPath, aumid, file) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, aumid, file],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => (out += b.toString()));
    child.stderr.on("data", (b) => (err += b.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      const match = /^DEMLI_PACKAGED app=(\d+) frame=(\d+) host=(\d+)/m.exec(out);
      if (code !== 0 || !match) {
        reject(new Error(`could not open ${aumid}: ${(err || out).trim().slice(0, 400)}`));
        return;
      }
      resolve({ appPid: Number(match[1]), frameHwnd: match[2], hostPid: Number(match[3]) });
    });
  });
}

/** The helper's `--window-pid` answer. */
function windowPid(hwnd) {
  return new Promise((resolve, reject) => {
    const child = spawn(helper, ["--window-pid", hwnd], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => (out += b.toString()));
    child.stderr.on("data", (b) => (err += b.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, pid: Number.parseInt(out.trim(), 10), stderr: err.trim() }));
  });
}

// Activates a packaged app for a file (IApplicationActivationManager), then
// waits for its ApplicationFrameWindow whose CoreWindow child the app owns.
const PACKAGED_OPEN_PS1 = String.raw`param([string]$Aumid, [string]$File)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IApplicationActivationManager {
  int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string id, [MarshalAs(UnmanagedType.LPWStr)] string args, int options, out uint pid);
  int ActivateForFile([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr items, [MarshalAs(UnmanagedType.LPWStr)] string verb, out uint pid);
  int ActivateForProtocol([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr items, out uint pid);
}
[ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")] class ApplicationActivationManager {}
public static class DemliPackaged {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr bc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IntPtr item);
  [DllImport("shell32.dll", PreserveSig = false)]
  static extern void SHCreateShellItemArrayFromShellItem(IntPtr item, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IntPtr items);
  static string ClassOf(IntPtr h) { var s = new StringBuilder(64); GetClassName(h, s, 64); return s.ToString(); }
  public static uint Open(string id, string path) {
    IntPtr item, items;
    SHCreateItemFromParsingName(path, IntPtr.Zero, new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), out item);
    SHCreateShellItemArrayFromShellItem(item, new Guid("b63ea76d-1f85-456f-a19c-48159efa858b"), out items);
    uint pid;
    int hr = ((IApplicationActivationManager)new ApplicationActivationManager()).ActivateForFile(id, items, "open", out pid);
    if (hr != 0) throw new Exception("ActivateForFile hr=0x" + hr.ToString("X8"));
    return pid;
  }
  public static string Frame(uint appPid) {
    string found = null;
    EnumWindows((h, l) => {
      if (ClassOf(h) != "ApplicationFrameWindow") return true;
      uint host; GetWindowThreadProcessId(h, out host);
      EnumChildWindows(h, (c, l2) => {
        uint owner;
        if (ClassOf(c) == "Windows.UI.Core.CoreWindow" && GetWindowThreadProcessId(c, out owner) != 0 && owner == appPid) {
          found = h.ToInt64() + " host=" + host; return false;
        }
        return true;
      }, IntPtr.Zero);
      return found == null;
    }, IntPtr.Zero);
    return found;
  }
}
"@
$appPid = [DemliPackaged]::Open($Aumid, $File)
for ($i = 0; $i -lt 50; $i++) {
  $frame = [DemliPackaged]::Frame($appPid)
  if ($frame) { [Console]::Out.WriteLine("DEMLI_PACKAGED app=$appPid frame=$frame"); exit 0 }
  Start-Sleep -Milliseconds 200
}
throw "no frame window for pid $appPid"
`;

const work = mkdtempSync(join(tmpdir(), "demli-verify-audio-"));
const children = [];
let packagedPid = null;
try {
  const wavA = join(work, `tone-${FREQ_A}.wav`);
  const wavB = join(work, `tone-${FREQ_B}.wav`);
  writeFileSync(wavA, sineWav(FREQ_A, TONE_SECONDS));
  writeFileSync(wavB, sineWav(FREQ_B, TONE_SECONDS));
  // The Electron page loops a short clip: it is inlined as a data: URL.
  const wavBLoop = join(work, `tone-${FREQ_B}-loop.wav`);
  writeFileSync(wavBLoop, sineWav(FREQ_B, 4));

  console.log(`Part 1 — helper include/exclude (A = ${FREQ_A} Hz process, B = ${FREQ_B} Hz process)`);
  const a = playInPowerShell(wavA);
  const b = playInPowerShell(wavB);
  children.push(a.child, b.child);
  await Promise.all([a.started, b.started]);
  await sleep(PLAYBACK_SETTLE_MS);
  console.log(`  tone A pid=${a.child.pid}, tone B pid=${b.child.pid}`);
  const [inc, exc] = await Promise.all([
    capture(a.child.pid, "include", CAPTURE_MS),
    capture(a.child.pid, "exclude", CAPTURE_MS),
  ]);
  console.log(`  include(A): ${inc.pcm.length} bytes · ${inc.stderr}`);
  console.log(`  exclude(A): ${exc.pcm.length} bytes · ${exc.stderr}`);
  const refA = expectPresent("include(A)", inc.pcm, FREQ_A);
  const refB = expectPresent("exclude(A)", exc.pcm, FREQ_B);
  expectAbsent("include(A)", inc.pcm, FREQ_B, refB);
  expectAbsent("exclude(A)", exc.pcm, FREQ_A, refA);
  for (const c of [a.child, b.child]) c.kill();
  await sleep(500);

  if (process.argv.includes("--electron")) {
    console.log("Part 2 — Electron <audio> playback vs exclude(process.pid)");
    const require = createRequire(join(desktopDir, "package.json"));
    const electronBin = require("electron");
    const electron = spawn(electronBin, [join(here, "verify-process-audio-electron.mjs"), wavBLoop], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    children.push(electron);
    const report = await new Promise((resolve, reject) => {
      let out = "";
      electron.stdout.on("data", (chunk) => {
        out += chunk.toString();
        const line = out.split("\n").find((l) => l.startsWith("DEMLI_VERIFY "));
        if (line) resolve(JSON.parse(line.slice("DEMLI_VERIFY ".length)));
      });
      electron.stderr.on("data", () => undefined);
      electron.on("exit", (code) => reject(new Error(`electron exited early (code ${code})`)));
      setTimeout(() => reject(new Error("electron did not report playback within 20s")), 20000);
    });
    if (!report.playing) throw new Error(`electron could not play: ${report.error ?? "unknown"}`);
    if (!(report.playedSeconds > 0.3)) {
      throw new Error(`electron <audio> is not advancing (currentTime ${report.playedSeconds})`);
    }
    console.log(
      `  electron main pid=${report.mainPid} (spawned pid ${electron.pid}); audio-service pids=${JSON.stringify(report.audioServicePids)}; <audio> played ${report.playedSeconds.toFixed(2)}s`,
    );
    const other = playInPowerShell(wavA);
    children.push(other.child);
    await other.started;
    await sleep(PLAYBACK_SETTLE_MS);
    const [exE, inE] = await Promise.all([
      capture(report.mainPid, "exclude", CAPTURE_MS),
      capture(report.mainPid, "include", CAPTURE_MS),
    ]);
    console.log(`  exclude(electron): ${exE.pcm.length} bytes · ${exE.stderr}`);
    console.log(`  include(electron): ${inE.pcm.length} bytes · ${inE.stderr}`);
    const refElectron = expectPresent("include(electron)", inE.pcm, FREQ_B);
    const refOther = expectPresent("exclude(electron)", exE.pcm, FREQ_A);
    expectAbsent("exclude(electron)", exE.pcm, FREQ_B, refElectron);
    expectAbsent("include(electron)", inE.pcm, FREQ_A, refOther);
    if (refElectron === null) {
      // Process loopback captures AFTER the per-app volume, so an Electron
      // muted in the Windows volume mixer renders silence and exclude(electron)
      // would pass for the wrong reason.
      console.log(
        "  NOTE  Electron's own output was not captured — is electron.exe muted or at 0 in the " +
          "Windows volume mixer? Until include(electron) carries the tone, the exclude result " +
          "proves nothing.",
      );
    }
    electron.kill();
    await sleep(500);
  }

  if (process.argv.includes("--packaged")) {
    console.log(`Part 3 — packaged (UWP) window: frame host vs the app behind it (C = ${FREQ_C} Hz)`);
    const wavC = join(work, `tone-${FREQ_C}.wav`);
    writeFileSync(wavC, sineWav(FREQ_C, TONE_SECONDS));
    const ps1 = join(work, "open-packaged.ps1");
    writeFileSync(ps1, PACKAGED_OPEN_PS1);
    const opened = await openInPackagedApp(ps1, PACKAGED_APP, wavC);
    packagedPid = opened.appPid;
    console.log(`  app pid=${opened.appPid}, frame hwnd=${opened.frameHwnd} owned by pid ${opened.hostPid}`);
    const resolved = await windowPid(opened.frameHwnd);
    const resolvesToApp = resolved.code === 0 && resolved.pid === opened.appPid;
    results.push({ label: "--window-pid", pass: resolvesToApp });
    console.log(
      `  ${resolvesToApp ? "PASS" : "FAIL"}  --window-pid ${opened.frameHwnd} → ` +
        `${resolved.code === 0 ? resolved.pid : `exit ${resolved.code} ${resolved.stderr}`} ` +
        `(app ${opened.appPid}, frame host ${opened.hostPid})`,
    );
    await sleep(PLAYBACK_SETTLE_MS);
    const [inApp, inHost] = await Promise.all([
      capture(opened.appPid, "include", CAPTURE_MS),
      capture(opened.hostPid, "include", CAPTURE_MS),
    ]);
    console.log(`  include(app): ${inApp.pcm.length} bytes · ${inApp.stderr}`);
    console.log(`  include(frame host): ${inHost.pcm.length} bytes · ${inHost.stderr}`);
    const refC = expectPresent("include(app)", inApp.pcm, FREQ_C);
    expectAbsent("include(frame host)", inHost.pcm, FREQ_C, refC);
  }
} finally {
  if (packagedPid !== null) {
    try {
      process.kill(packagedPid);
    } catch {
      // already gone
    }
  }
  for (const c of children) {
    try {
      c.kill();
    } catch {
      // already gone
    }
  }
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(failed.length === 0 ? `ALL ${results.length} CHECKS PASSED` : `${failed.length} of ${results.length} CHECKS FAILED`);
process.exit(failed.length === 0 ? 0 : 1);
