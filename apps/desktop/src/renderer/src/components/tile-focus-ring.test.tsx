// @vitest-environment jsdom
/**
 * A stage tile's keyboard focus must be VISIBLE above its picture.
 *
 * The tiles are role=button with tabIndex 0, and their focus used to be a
 * `focus-visible:ring-inset` on the tile box. A ring is a box-shadow, and an
 * inset box-shadow paints UNDER the tile's children — so on a camera or a
 * screen-share tile the full-bleed <video> covered it and a keyboard user saw
 * nothing (M16 audit). On a speaking avatar tile the ring was the same coral
 * 2px edge as the speaking light, so focus could not be told apart there either.
 *
 * The fix draws focus as its own overlay (TileFocusRing), after the <video> and
 * the speaking light in paint order, in a different colour from the speaking
 * light. jsdom cannot paint, so this pins the structure that makes it paint;
 * the voice harness (apps/web/src/harness/voice/verify.mjs) samples the real
 * pixels in Chrome.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createI18n, createMemoryStorage, type i18n as I18n } from "@demli/i18n";
import { TooltipProvider } from "@demli/ui";
import type { RemoteCamera, RemoteScreenShare, VoiceParticipant } from "@demli/media";
import type * as AvatarTileModule from "./AvatarTile";
import type * as CameraTileModule from "./CameraTile";
import type * as LocalCameraTileModule from "./LocalCameraTile";
import type * as ScreenShareTileModule from "./ScreenShareTile";
import type * as LocalScreenShareTileModule from "./LocalScreenShareTile";

// lucide-react ships its own nested React copy that escapes the test aliases;
// icons are not what this test checks.
vi.mock("lucide-react", async (importOriginal) => {
  const icons = await importOriginal<Record<string, unknown>>();
  const Icon = (): JSX.Element => <svg />;
  return Object.fromEntries(Object.keys(icons).map((name) => [name, Icon]));
});
// The per-user volume menu wraps the tile in a Radix context menu; it is not
// what this test checks and it pulls the whole voice store in.
vi.mock("./ParticipantVolumeMenu", () => ({
  ParticipantVolumeMenu: ({ children }: { children: JSX.Element }) => children,
}));
vi.mock("../lib/video-playback", () => ({ startLocalPreviewPlayback: () => undefined }));
// The real voice store boots the audio engine (AudioWorklet), which jsdom lacks;
// the share tile only reads two fields from it, for its volume slider.
vi.mock("../stores/voice-store", async () => {
  const { create } = await import("zustand");
  return { useVoiceStore: create(() => ({ deafened: false, setScreenShareVolume: () => undefined })) };
});

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let i18n: I18n;
let Avatar: typeof AvatarTileModule;
let Camera: typeof CameraTileModule;
let LocalCamera: typeof LocalCameraTileModule;
let Share: typeof ScreenShareTileModule;
let LocalShare: typeof LocalScreenShareTileModule;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has neither MediaStream nor getUserMedia; the local tiles only hand
  // them to the <video>, which jsdom never plays.
  class FakeMediaStream {
    constructor(readonly tracks: unknown[] = []) {}
    getTracks(): unknown[] {
      return this.tracks;
    }
  }
  (globalThis as { MediaStream?: unknown }).MediaStream = FakeMediaStream;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: () => new Promise(() => undefined) },
  });
  i18n = await createI18n({ lng: "tr", storage: createMemoryStorage() });
  Avatar = await import("./AvatarTile");
  Camera = await import("./CameraTile");
  LocalCamera = await import("./LocalCameraTile");
  Share = await import("./ScreenShareTile");
  LocalShare = await import("./LocalScreenShareTile");
}, 60_000);

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(node: JSX.Element): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <TooltipProvider>{node}</TooltipProvider>
      </I18nextProvider>,
    );
  });
  return host;
}

const track = { attach: () => undefined, detach: () => undefined };
const participant = {
  userId: "u2",
  identity: "u2",
  isLocal: false,
  speaking: true,
  micEnabled: true,
  deafened: false,
  screenSharing: false,
} as unknown as VoiceParticipant;

type Case = { name: string; testId: string; tile: (onSelect?: () => void) => JSX.Element; video: boolean };

const CASES: Case[] = [
  {
    name: "AvatarTile",
    testId: "avatar-tile",
    video: false,
    tile: (onSelect) => <Avatar.AvatarTile participant={participant} onSelect={onSelect} />,
  },
  {
    name: "CameraTile",
    testId: "camera-tile",
    video: true,
    tile: (onSelect) => (
      <Camera.CameraTile
        camera={{ identity: "u2", userId: "u2", track } as unknown as RemoteCamera}
        participant={participant}
        onSelect={onSelect}
      />
    ),
  },
  {
    name: "LocalCameraTile",
    testId: "local-camera-tile",
    video: true,
    tile: (onSelect) => <LocalCamera.LocalCameraTile deviceId={null} onSelect={onSelect} />,
  },
  {
    name: "ScreenShareTile",
    testId: "screen-share-tile",
    video: true,
    tile: (onSelect) => (
      <Share.ScreenShareTile
        share={{ identity: "u2", userId: "u2", track } as unknown as RemoteScreenShare}
        sharerName="Ayşe"
        onSelect={onSelect}
      />
    ),
  },
  {
    name: "LocalScreenShareTile",
    testId: "local-screen-tile",
    video: true,
    tile: (onSelect) => (
      <LocalShare.LocalScreenShareTile
        track={{ kind: "video" } as unknown as MediaStreamTrack}
        label="Yayının"
        onSelect={onSelect}
      />
    ),
  },
];

describe("stage tiles draw keyboard focus above their picture", () => {
  it.each(CASES)("$name: focus overlay is a direct child painted after the video", ({ testId, tile, video }) => {
    const el = render(tile(() => undefined));
    const root = el.querySelector(`[data-testid="${testId}"]`);
    expect(root?.getAttribute("role")).toBe("button");
    expect(root?.getAttribute("tabindex")).toBe("0");

    const ring = root?.querySelector(':scope > [data-testid="tile-focus-ring"]');
    expect(ring, "the tile has no focus overlay").not.toBeNull();
    const cls = ring?.getAttribute("class") ?? "";
    // Shown only while the tile itself is keyboard-focused…
    expect(cls).toContain("opacity-0");
    expect(cls).toContain("group-focus-visible/tile:opacity-100");
    // …covering the whole tile, above the picture and above the speaking light.
    expect(cls).toMatch(/\babsolute\b/);
    expect(cls).toContain("inset-0");
    expect(cls).toContain("z-20");
    expect(root?.getAttribute("class") ?? "").toContain("group/tile");

    const children = Array.from(root?.children ?? []);
    const ringIndex = children.indexOf(ring as Element);
    if (video) {
      const videoIndex = children.findIndex((c) => c.tagName === "VIDEO");
      expect(videoIndex).toBeGreaterThanOrEqual(0);
      expect(ringIndex).toBeGreaterThan(videoIndex);
    }
    const glow = root?.querySelector(':scope > [data-testid="speaking-glow"]');
    if (glow) expect(ringIndex).toBeGreaterThan(children.indexOf(glow));
  });

  it.each(CASES)("$name: no focus ring left on the tile box, where the picture covers it", ({ testId, tile }) => {
    const el = render(tile(() => undefined));
    const cls = el.querySelector(`[data-testid="${testId}"]`)?.getAttribute("class") ?? "";
    expect(cls).not.toMatch(/focus-visible:ring/);
    expect(cls).toContain("outline-none");
  });

  it.each(CASES)("$name: a non-interactive tile is not focusable and has no focus overlay", ({ testId, tile }) => {
    const el = render(tile(undefined));
    const root = el.querySelector(`[data-testid="${testId}"]`);
    expect(root?.hasAttribute("tabindex")).toBe(false);
    expect(root?.querySelector('[data-testid="tile-focus-ring"]')).toBeNull();
  });

  it("focus is a different light from the speaking light", () => {
    // Speaking = coral edge + coral halo. Focus = white edge with a black keyline
    // and no coral, so "focused" and "talking" never read as the same state.
    expect(Avatar.SPEAKING_GLOW).toContain("--color-accent");
    expect(Avatar.TILE_FOCUS_RING).not.toContain("--color-accent");
    expect(Avatar.TILE_FOCUS_RING).toContain("--color-fg-display");
    // Inset only, like every tile light (tile-glow-inset.test.ts).
    for (const layer of /shadow-\[([^\]]+)\]/.exec(Avatar.TILE_FOCUS_RING)?.[1]?.split(",") ?? []) {
      expect(layer.trim().startsWith("inset")).toBe(true);
    }
  });
});
