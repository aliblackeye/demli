// Numeric proof for the process-audio helper (Windows only, plays short tones).
//
//   node apps/desktop/scripts/verify-process-audio.mjs            # helper modes
//   node apps/desktop/scripts/verify-process-audio.mjs --electron # + Demli-style exclusion
//
// Part 1 (always): two child processes play different tones at the same time —
// A = 440 Hz, B = 1000 Hz. The helper captures include(A) and exclude(A) in
// parallel and each capture is measured with the Goertzel algorithm.
//   include(A) must carry A and not B; exclude(A) must carry B and not A.
//
// Part 2 (--electron): a real Electron app plays 1000 Hz through an <audio>
// element (the way LiveKit plays remote voices) while a separate process plays
// 440 Hz. exclude(<electron main PID>) — exactly what Demli's "system sound"
// mode does with process.pid — must carry 440 and not 1000, and
// include(<electron main PID>) must carry 1000, which proves Electron's audio
// output (rendered by its audio-service child process) belongs to the main
// process tree.
//
// Thresholds: a tone counts as PRESENT at >= -40 dBFS and ABSENT at <= -60 dBFS
// (test tones are generated at -12 dBFS). Exit code 0 only when every check passes.
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
const TONE_AMPLITUDE = 0.25; // -12 dBFS
const PRESENT_DB = -40;
const ABSENT_DB = -60;
const CAPTURE_MS = 3000;
const ANALYSIS_SKIP_S = 0.5;

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

/** Run the helper for `ms`, then close its stdin (the stop signal). */
function capture(pid, mode, ms) {
  return new Promise((resolve, reject) => {
    const child = spawn(helper, [String(pid), mode], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const chunks = [];
    let stderr = "";
    child.stdout.on("data", (c) => chunks.push(c));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`helper ${mode} ${pid} exited ${code}: ${stderr.trim()}`));
      else resolve({ pcm: Buffer.concat(chunks), stderr: stderr.trim() });
    });
    setTimeout(() => child.stdin.end(), ms);
  });
}

/** Goertzel amplitude (dBFS) of `frequency` over the mono mix of s16le stereo PCM. */
function toneDb(pcm, frequency) {
  const frames = Math.floor(pcm.length / 4);
  const skip = Math.min(frames, Math.round(SAMPLE_RATE * ANALYSIS_SKIP_S));
  // Whole-second blocks put every test tone exactly on a bin centre (no leakage).
  const block = SAMPLE_RATE;
  const blocks = Math.floor((frames - skip) / block);
  if (blocks < 1) return { db: -Infinity, seconds: (frames - skip) / SAMPLE_RATE };
  const coeff = 2 * Math.cos((2 * Math.PI * frequency) / SAMPLE_RATE);
  let sumAmplitude = 0;
  for (let b = 0; b < blocks; b++) {
    let s1 = 0;
    let s2 = 0;
    const start = skip + b * block;
    for (let i = 0; i < block; i++) {
      const o = (start + i) * 4;
      const x = (pcm.readInt16LE(o) + pcm.readInt16LE(o + 2)) / 2 / 32768;
      const s0 = x + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
    sumAmplitude += (2 * Math.sqrt(Math.max(0, power))) / block;
  }
  const amplitude = sumAmplitude / blocks;
  return { db: amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity, seconds: blocks };
}

function fmt(db) {
  return Number.isFinite(db) ? `${db.toFixed(1)} dBFS` : "-inf dBFS";
}

const results = [];
function expectTone(label, pcm, frequency, present) {
  const { db, seconds } = toneDb(pcm, frequency);
  const pass = present ? db >= PRESENT_DB : db <= ABSENT_DB;
  results.push({ label, frequency, expected: present ? "present" : "absent", db, seconds, pass });
  console.log(
    `  ${pass ? "PASS" : "FAIL"}  ${label}: ${frequency} Hz ${present ? "present" : "absent "} ` +
      `→ ${fmt(db)} (need ${present ? `>= ${PRESENT_DB}` : `<= ${ABSENT_DB}`}, ${seconds}s analysed)`,
  );
}

const work = mkdtempSync(join(tmpdir(), "demli-verify-audio-"));
const children = [];
try {
  const wavA = join(work, "tone-440.wav");
  const wavB = join(work, "tone-1000.wav");
  writeFileSync(wavA, sineWav(440, 7));
  writeFileSync(wavB, sineWav(1000, 7));

  console.log("Part 1 — helper include/exclude (A = 440 Hz process, B = 1000 Hz process)");
  const a = playInPowerShell(wavA);
  const b = playInPowerShell(wavB);
  children.push(a.child, b.child);
  await Promise.all([a.started, b.started]);
  await sleep(300);
  console.log(`  tone A pid=${a.child.pid}, tone B pid=${b.child.pid}`);
  const [inc, exc] = await Promise.all([
    capture(a.child.pid, "include", CAPTURE_MS),
    capture(a.child.pid, "exclude", CAPTURE_MS),
  ]);
  console.log(`  include(A): ${inc.pcm.length} bytes · ${inc.stderr}`);
  console.log(`  exclude(A): ${exc.pcm.length} bytes · ${exc.stderr}`);
  expectTone("include(A)", inc.pcm, 440, true);
  expectTone("include(A)", inc.pcm, 1000, false);
  expectTone("exclude(A)", exc.pcm, 1000, true);
  expectTone("exclude(A)", exc.pcm, 440, false);
  for (const c of [a.child, b.child]) c.kill();
  await sleep(500);

  if (process.argv.includes("--electron")) {
    console.log("Part 2 — Electron <audio> playback vs exclude(process.pid)");
    const require = createRequire(join(desktopDir, "package.json"));
    const electronBin = require("electron");
    const electron = spawn(electronBin, [join(here, "verify-process-audio-electron.cjs"), wavB], {
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
    console.log(
      `  electron main pid=${report.mainPid} (spawned pid ${electron.pid}); audio-service pids=${JSON.stringify(report.audioServicePids)}`,
    );
    const other = playInPowerShell(wavA);
    children.push(other.child);
    await other.started;
    await sleep(300);
    const [exE, inE] = await Promise.all([
      capture(report.mainPid, "exclude", CAPTURE_MS),
      capture(report.mainPid, "include", CAPTURE_MS),
    ]);
    console.log(`  exclude(electron): ${exE.pcm.length} bytes · ${exE.stderr}`);
    console.log(`  include(electron): ${inE.pcm.length} bytes · ${inE.stderr}`);
    expectTone("exclude(electron)", exE.pcm, 1000, false);
    expectTone("exclude(electron)", exE.pcm, 440, true);
    expectTone("include(electron)", inE.pcm, 1000, true);
    expectTone("include(electron)", inE.pcm, 440, false);
  }
} finally {
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
