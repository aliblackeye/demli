// Electron side of verify-process-audio.mjs --electron. Plays a WAV through an
// <audio> element in a renderer (how LiveKit plays remote voices), then reports
// its main PID and the audio-service PIDs on stdout as one "DEMLI_VERIFY {json}"
// line. Quits on its own after 15 s; the runner kills it sooner.
/* global process, setTimeout */
import { app, BrowserWindow } from "electron";
import { readFileSync } from "node:fs";

const wavPath = process.argv[process.argv.length - 1];

function report(payload) {
  process.stdout.write(`DEMLI_VERIFY ${JSON.stringify(payload)}\n`);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      autoplayPolicy: "no-user-gesture-required",
      backgroundThrottling: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  const wavBase64 = readFileSync(wavPath).toString("base64");
  await win.loadURL("data:text/html,<!doctype html><title>verify</title><body></body>");
  try {
    const playing = await win.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const el = document.createElement("audio");
        el.src = "data:audio/wav;base64,${wavBase64}";
        el.loop = true;
        document.body.appendChild(el);
        el.addEventListener("playing", () => resolve(true), { once: true });
        el.play().catch((e) => resolve(String(e)));
      })
    `);
    // Give the audio service a moment to open its output stream, and prove the
    // element is really advancing (a "playing" event alone is not sound).
    await new Promise((resolve) => setTimeout(resolve, 800));
    const playedSeconds = await win.webContents.executeJavaScript(
      "document.querySelector('audio')?.currentTime ?? 0",
    );
    const audioServicePids = app
      .getAppMetrics()
      .filter((m) => m.type === "Utility" && /audio/i.test(`${m.serviceName ?? ""} ${m.name ?? ""}`))
      .map((m) => m.pid);
    report({
      playing: playing === true,
      error: playing === true ? undefined : playing,
      mainPid: process.pid,
      audioServicePids,
      playedSeconds,
    });
  } catch (err) {
    report({
      playing: false,
      error: String(err),
      mainPid: process.pid,
      audioServicePids: [],
      playedSeconds: 0,
    });
  }
  setTimeout(() => app.quit(), 15000);
});
