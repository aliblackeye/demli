/**
 * SUBSCRIPTION PROBE — dev-only, never part of a build.
 *
 * Answers one question with numbers instead of confidence: when the K3 filmstrip
 * rule UNMOUNTS a quiet participant's tile, does the SFU actually stop sending
 * that video?
 *
 * The claim under test (call-ux-plan K3, "abonelik politikası") is that we do not
 * need an explicit `setSubscribed(false)`, because the room runs with
 * `adaptiveStream` — livekit watches the attached element and pauses a stream
 * whose element is gone. That is a property of the SFU + client pair, so no unit
 * test can establish it; this drives a REAL `livekit-server` (docker compose up
 * livekit) with a real publisher and a real subscriber in one page, and reads
 * `bytesReceived` off the subscriber's own RTP stats.
 *
 * Run:
 *   docker compose up -d livekit
 *   pnpm --filter @demli/web dev
 *   open http://localhost:5199/livekit-probe.html   (results also on window.__probe)
 *
 * It talks to the LOCAL dev SFU with the compose file's dev keys only.
 */

import { LocalVideoTrack, RemoteVideoTrack, Room, RoomEvent, Track } from "livekit-client";

const LIVEKIT_URL = "ws://localhost:7880";
const DEV_KEY = "devkey";
const DEV_SECRET = "devsecret";
const ROOM = `probe-${Math.floor(Math.random() * 1e6)}`;

const b64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
};
const b64urlJson = (value: unknown): string =>
  b64url(new TextEncoder().encode(JSON.stringify(value)));

/** Mint a dev LiveKit access token in the page (HS256, WebCrypto). */
async function mintToken(identity: string, canPublish: boolean): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const head = b64urlJson({ alg: "HS256", typ: "JWT" });
  const body = b64urlJson({
    exp: now + 3600,
    iss: DEV_KEY,
    nbf: now - 10,
    sub: identity,
    name: identity,
    video: { room: ROOM, roomJoin: true, canPublish, canSubscribe: true },
  });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(DEV_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

/** A moving canvas so the encoder always has something to send. */
function canvasTrack(): MediaStreamTrack {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext("2d");
  let frame = 0;
  const paint = (): void => {
    frame += 1;
    if (ctx) {
      ctx.fillStyle = `hsl(${(frame * 3) % 360}, 60%, 45%)`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#fff";
      ctx.font = "700 48px sans-serif";
      ctx.fillText(String(frame), 40 + ((frame * 7) % 400), 200);
    }
    requestAnimationFrame(paint);
  };
  paint();
  return (canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream })
    .captureStream(30)
    .getVideoTracks()[0]!;
}

async function bytesReceived(track: RemoteVideoTrack): Promise<number> {
  const report = await track.getRTCStatsReport();
  let total = 0;
  report?.forEach((stat) => {
    const s = stat as RTCStats & { type: string; bytesReceived?: number };
    if (s.type === "inbound-rtp" && typeof s.bytesReceived === "number") total += s.bytesReceived;
  });
  return total;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function log(line: string): void {
  const el = document.getElementById("log");
  if (el) el.textContent += `${line}\n`;
  console.info("[probe]", line);
}

export async function runProbe(): Promise<Record<string, number | string>> {
  const publisher = new Room();
  // The SAME options the desktop room uses (see packages/media/src/livekit.ts).
  const subscriber = new Room({ adaptiveStream: { pixelDensity: "screen" }, dynacast: true });

  await publisher.connect(LIVEKIT_URL, await mintToken("publisher", true));
  await subscriber.connect(LIVEKIT_URL, await mintToken("subscriber", false));
  log(`connected to ${ROOM}`);

  const local = new LocalVideoTrack(canvasTrack());
  await publisher.localParticipant.publishTrack(local, { source: Track.Source.Camera });
  log("published a camera track");

  const remote = await new Promise<RemoteVideoTrack>((resolve) => {
    for (const p of subscriber.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) {
        if (pub.track instanceof RemoteVideoTrack) resolve(pub.track);
      }
    }
    subscriber.on(RoomEvent.TrackSubscribed, (track) => {
      if (track instanceof RemoteVideoTrack) resolve(track);
    });
  });
  log("subscribed");

  // ── MOUNTED: the tile is on screen, exactly like a filmstrip tile ──────────
  const host = document.getElementById("stage") as HTMLElement;
  const el = remote.attach();
  el.style.width = "320px";
  host.appendChild(el);
  await sleep(6000); // let the encoder ramp
  const mountedStart = await bytesReceived(remote);
  await sleep(5000);
  const mountedEnd = await bytesReceived(remote);
  const mountedBps = Math.round(((mountedEnd - mountedStart) * 8) / 5);
  log(`MOUNTED   : ${mountedBps} bps over 5 s`);

  // ── UNMOUNTED: what resolveStage does to a quiet participant ───────────────
  remote.detach(el);
  el.remove();
  await sleep(6000); // adaptiveStream needs a beat to pause the stream
  const pausedStart = await bytesReceived(remote);
  await sleep(5000);
  const pausedEnd = await bytesReceived(remote);
  const pausedBps = Math.round(((pausedEnd - pausedStart) * 8) / 5);
  log(`UNMOUNTED : ${pausedBps} bps over 5 s`);

  // ── REMOUNTED: it must come back, or the rule would be a one-way trap ──────
  const el2 = remote.attach();
  el2.style.width = "320px";
  host.appendChild(el2);
  await sleep(6000);
  const backStart = await bytesReceived(remote);
  await sleep(5000);
  const backEnd = await bytesReceived(remote);
  const backBps = Math.round(((backEnd - backStart) * 8) / 5);
  log(`REMOUNTED : ${backBps} bps over 5 s`);

  const result = {
    room: ROOM,
    mountedBps,
    unmountedBps: pausedBps,
    remountedBps: backBps,
    verdict:
      pausedBps < mountedBps * 0.1 && backBps > mountedBps * 0.3
        ? "PASS — unmounting a tile stops the stream, remounting resumes it"
        : "FAIL — see numbers",
  };
  log(JSON.stringify(result, null, 2));
  await publisher.disconnect();
  await subscriber.disconnect();
  return result;
}

declare global {
  interface Window {
    __probe?: Record<string, number | string> | { error: string };
  }
}

void runProbe().then(
  (r) => {
    window.__probe = r;
  },
  (err: unknown) => {
    window.__probe = { error: String(err) };
    log(`ERROR ${String(err)}`);
  },
);
