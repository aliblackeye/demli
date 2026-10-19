/**
 * Real MOVING media for the voice harness, with no camera, no screen and no
 * LiveKit room: canvas-drawn frames captured as genuine MediaStreamTracks.
 *
 * Each "source" paints a distinct scene (a fake film, a fake camera) at 30 fps,
 * so a screenshot of a tile shows actual decoded video — the tiles' own
 * `<video>` elements, `track.attach` and `videoHeight` measurement all run for
 * real. Nothing here is imported by the product.
 */

import type { RemoteCamera, RemoteScreenShare } from "@demli/media";
import type { UserId } from "@demli/types";

interface CanvasSource {
  stream: MediaStream;
  track: MediaStreamTrack;
}

const sources = new Map<string, CanvasSource>();

/**
 * One looping canvas scene. Deliberately NOT palette colours: this stands in
 * for somebody's camera or film, i.e. arbitrary third-party content.
 */
export function canvasSource(
  key: string,
  opts: { width: number; height: number; label: string; hue: number; kind: "film" | "camera" },
): CanvasSource {
  const existing = sources.get(key);
  if (existing) return existing;
  const canvas = document.createElement("canvas");
  canvas.width = opts.width;
  canvas.height = opts.height;
  const ctx = canvas.getContext("2d");
  let frame = 0;
  const paint = (): void => {
    if (!ctx) return;
    frame += 1;
    const { width: w, height: h } = canvas;
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, `hsl(${(opts.hue + frame / 6) % 360} 45% 30%)`);
    grad.addColorStop(1, `hsl(${(opts.hue + 60 + frame / 6) % 360} 50% 12%)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    if (opts.kind === "film") {
      // A "film": drifting bars + a title card.
      for (let i = 0; i < 6; i += 1) {
        ctx.fillStyle = `hsla(${(opts.hue + i * 40) % 360} 70% 60% / 0.25)`;
        const x = ((frame * (1 + i * 0.4)) % (w + 200)) - 200;
        ctx.fillRect(x, (h / 6) * i, 180, h / 8);
      }
    } else {
      // A "camera": a soft head-and-shoulders silhouette that breathes.
      ctx.fillStyle = "hsla(30 30% 80% / 0.35)";
      const r = h * 0.16 + Math.sin(frame / 18) * 2;
      ctx.beginPath();
      ctx.arc(w / 2, h * 0.42, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(w / 2, h * 0.98, w * 0.28, h * 0.32, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.font = `600 ${Math.round(h / 12)}px sans-serif`;
    ctx.fillText(opts.label, Math.round(w * 0.05), Math.round(h * 0.14));
    requestAnimationFrame(paint);
  };
  paint();
  const stream = (canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }).captureStream(30);
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error("canvas captureStream produced no video track");
  const source = { stream, track };
  sources.set(key, source);
  return source;
}

/**
 * A livekit-shaped remote track over a canvas stream: `attach(el)` binds the
 * stream and starts playback (what livekit does), `detach(el)` unbinds it.
 */
function remoteTrack(source: CanvasSource): RemoteScreenShare["track"] {
  const track = {
    sid: `fake-${source.track.id}`,
    kind: "video",
    mediaStreamTrack: source.track,
    attach(el: HTMLMediaElement): HTMLMediaElement {
      el.srcObject = source.stream;
      void el.play().catch(() => undefined);
      return el;
    },
    detach(el?: HTMLMediaElement): HTMLMediaElement[] {
      if (el) el.srcObject = null;
      return el ? [el] : [];
    },
  };
  return track as unknown as RemoteScreenShare["track"];
}

export function fakeRemoteShare(userId: string, label: string): RemoteScreenShare {
  const source = canvasSource(`share-${userId}`, { width: 1920, height: 1080, label, hue: 18, kind: "film" });
  return { identity: userId, userId: userId as UserId, track: remoteTrack(source) };
}

export function fakeRemoteCamera(userId: string, label: string, hue: number): RemoteCamera {
  const source = canvasSource(`cam-${userId}`, { width: 1280, height: 720, label, hue, kind: "camera" });
  return { identity: userId, userId: userId as UserId, track: remoteTrack(source) };
}

/** The local "screen capture" the self-preview tile renders (raw track). */
export function fakeLocalScreenTrack(): MediaStreamTrack {
  return canvasSource("local-screen", { width: 1920, height: 1080, label: "PAYLAŞILAN EKRAN", hue: 200, kind: "film" })
    .track;
}

/**
 * `getUserMedia` / `enumerateDevices` over the canvas sources, so the local
 * camera tile, the camera preview dialog and the device settings list all have
 * something real to show. `?nocam=1` makes getUserMedia fail with
 * NotAllowedError (the permission-denied state of the preview dialog).
 */
export function installFakeMediaDevices(opts: { denyCamera: boolean; noDevices: boolean }): void {
  const cam = canvasSource("self-cam", { width: 1280, height: 720, label: "KENDİ KAMERAN", hue: 140, kind: "camera" });
  const devices: MediaDeviceInfo[] = opts.noDevices
    ? []
    : ([
        { deviceId: "default", kind: "audioinput", label: "Varsayılan — Mikrofon (Shure MV7)", groupId: "g1" },
        { deviceId: "mic-2", kind: "audioinput", label: "Kulaklık Mikrofonu (HyperX Cloud II)", groupId: "g2" },
        { deviceId: "default", kind: "audiooutput", label: "Varsayılan — Hoparlör (Realtek)", groupId: "g3" },
        { deviceId: "out-2", kind: "audiooutput", label: "Kulaklık (HyperX Cloud II)", groupId: "g2" },
        { deviceId: "cam-1", kind: "videoinput", label: "Logitech C920 HD Pro", groupId: "g4" },
        { deviceId: "cam-2", kind: "videoinput", label: "OBS Virtual Camera", groupId: "g5" },
      ].map((d) => ({ ...d, toJSON: () => d })) as unknown as MediaDeviceInfo[]);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async (): Promise<MediaStream> => {
        if (opts.denyCamera) throw new DOMException("denied", "NotAllowedError");
        // A CLONE per call: tiles stop every track they were handed on unmount.
        return cam.stream.clone();
      },
      // Present so the web bridge offers its three display surfaces (it lists
      // them only when the browser can capture); answers with the fake film.
      getDisplayMedia: async (): Promise<MediaStream> =>
        canvasSource("local-screen", { width: 1920, height: 1080, label: "PAYLAŞILAN EKRAN", hue: 200, kind: "film" }).stream.clone(),
      enumerateDevices: async () => devices,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  });
}

/** A small generated "photo" avatar (data URL), so photo avatars render too. */
export function photoAvatar(hue: number): string {
  const c = document.createElement("canvas");
  c.width = 96;
  c.height = 96;
  const ctx = c.getContext("2d");
  if (!ctx) return "";
  const g = ctx.createRadialGradient(40, 30, 6, 48, 48, 70);
  g.addColorStop(0, `hsl(${hue} 60% 70%)`);
  g.addColorStop(1, `hsl(${(hue + 40) % 360} 45% 25%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 96, 96);
  ctx.fillStyle = "hsla(0 0% 100% / 0.35)";
  ctx.beginPath();
  ctx.arc(48, 40, 18, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(48, 96, 32, 26, 0, 0, Math.PI * 2);
  ctx.fill();
  return c.toDataURL("image/png");
}
