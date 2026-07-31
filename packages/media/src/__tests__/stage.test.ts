import { describe, expect, it } from "vitest";
import type { UserId } from "@demli/types";
import {
  createActiveSpeakerTracker,
  DEFAULT_ACTIVE_SPEAKER_ATTACK_MS,
  DEFAULT_ACTIVE_SPEAKER_RELEASE_MS,
} from "../active-speaker.js";
import type { RemoteCamera, RemoteScreenShare } from "../engine.js";
import type { VoiceParticipant } from "../state.js";
import {
  buildTiles,
  computeGridShape,
  resolveStage,
  SPEAKER_FILMSTRIP_MIN_OTHERS,
  type StageTile,
} from "../stage.js";

function participant(identity: string, isLocal = false): VoiceParticipant {
  return {
    userId: `user-${identity}` as UserId,
    identity,
    micEnabled: true,
    speaking: false,
    screenSharing: false,
    cameraEnabled: false,
    volume: 1,
    deafened: false,
    isLocal,
  };
}

/** A remote camera/share needs only its identity for these layout assertions. */
const track = { attach: () => undefined, detach: () => undefined } as unknown as RemoteCamera["track"];
const camera = (identity: string): RemoteCamera => ({
  identity,
  userId: `user-${identity}` as UserId,
  track,
});
const share = (identity: string): RemoteScreenShare => ({
  identity,
  userId: `user-${identity}` as UserId,
  track,
});

/** A room of `me` + the given remote identities, no cameras, no shares. */
function room(others: string[]): StageTile[] {
  return buildTiles({
    participants: [participant("me", true), ...others.map((o) => participant(o))],
    remoteCameras: [],
    shares: [],
    cameraEnabled: false,
    selectedVideoDeviceId: null,
    localScreenTrack: null,
  });
}

const keys = (tiles: StageTile[]): string[] => tiles.map((t) => t.key);

describe("resolveStage — grid vs focus", () => {
  it("is grid mode with no pin and no remote share", () => {
    const layout = resolveStage(room(["a", "b"]), { focusedKey: null });
    expect(layout.mode).toBe("grid");
    expect(layout.grid).toHaveLength(3);
    expect(layout.filmstrip).toEqual([]);
    expect(layout.hiddenBySpeakerRule).toEqual([]);
  });

  it("promotes a pinned tile and never applies the speaker rule to the grid", () => {
    const tiles = room(["a", "b", "c", "d"]);
    const grid = resolveStage(tiles, {
      focusedKey: null,
      speakerFilmstrip: { recentSpeakers: [], selfIdentity: "me" },
    });
    // No pin → grid, and a grid shows EVERYONE regardless of who is talking.
    expect(grid.mode).toBe("grid");
    expect(grid.grid).toHaveLength(5);
    expect(grid.hiddenBySpeakerRule).toEqual([]);

    const focus = resolveStage(tiles, {
      focusedKey: "participant:a",
      speakerFilmstrip: { recentSpeakers: [], selfIdentity: "me" },
    });
    expect(focus.mode).toBe("focus");
    expect(focus.stage?.key).toBe("participant:a");
  });

  it("auto-stages a remote screen share with no pin", () => {
    const tiles = buildTiles({
      participants: [participant("me", true), participant("a")],
      remoteCameras: [],
      shares: [share("a")],
      cameraEnabled: false,
      selectedVideoDeviceId: null,
      localScreenTrack: null,
    });
    const layout = resolveStage(tiles, { focusedKey: null });
    expect(layout.mode).toBe("focus");
    expect(layout.stage?.key).toBe("screen:a");
  });
});

describe("resolveStage — K3 speaker filmstrip", () => {
  it("keeps self, hides quiet others, and counts them", () => {
    const layout = resolveStage(room(["a", "b", "c", "d"]), {
      focusedKey: "participant:a",
      speakerFilmstrip: { recentSpeakers: [], selfIdentity: "me" },
    });
    // Stage = a. Of the remaining {me, b, c, d}: only ME survives silence.
    expect(keys(layout.filmstrip)).toEqual(["participant:me"]);
    expect(keys(layout.hiddenBySpeakerRule)).toEqual([
      "participant:b",
      "participant:c",
      "participant:d",
    ]);
  });

  it("admits a recent speaker and orders the strip by recency", () => {
    const tiles = room(["a", "b", "c", "d"]);
    const layout = resolveStage(tiles, {
      focusedKey: "participant:a",
      speakerFilmstrip: { recentSpeakers: ["d", "b"], selfIdentity: "me" },
    });
    expect(keys(layout.filmstrip)).toEqual([
      "participant:me",
      "participant:d",
      "participant:b",
    ]);
    expect(keys(layout.hiddenBySpeakerRule)).toEqual(["participant:c"]);
  });

  it("never hides screen shares or the watch party, whoever is quiet", () => {
    const tiles = buildTiles({
      participants: [
        participant("me", true),
        participant("a"),
        participant("b"),
        participant("c"),
        participant("d"),
      ],
      remoteCameras: [],
      shares: [share("d")],
      cameraEnabled: false,
      selectedVideoDeviceId: null,
      localScreenTrack: null,
    });
    const layout = resolveStage(tiles, {
      focusedKey: "participant:a",
      speakerFilmstrip: { recentSpeakers: [], selfIdentity: "me" },
    });
    expect(keys(layout.filmstrip)).toEqual(["screen:d", "participant:me"]);
    expect(layout.hiddenBySpeakerRule).toHaveLength(3);
  });

  it("shows everybody in a small call (the rule solves a crowd, not a duo)", () => {
    // 2 others < SPEAKER_FILMSTRIP_MIN_OTHERS: hiding the only other person in a
    // call until they make a noise would be disorienting and saves nothing.
    expect(SPEAKER_FILMSTRIP_MIN_OTHERS).toBe(3);
    const layout = resolveStage(room(["a", "b"]), {
      focusedKey: "participant:a",
      speakerFilmstrip: { recentSpeakers: [], selfIdentity: "me" },
    });
    expect(keys(layout.filmstrip)).toEqual(["participant:me", "participant:b"]);
    expect(layout.hiddenBySpeakerRule).toEqual([]);
  });

  it("shows every non-stage tile when no policy is passed", () => {
    const layout = resolveStage(room(["a", "b", "c"]), { focusedKey: "participant:a" });
    expect(layout.filmstrip).toHaveLength(3);
    expect(layout.hiddenBySpeakerRule).toEqual([]);
  });

  it("keeps a cameraless speaker — they enter as an avatar tile", () => {
    const tiles = buildTiles({
      participants: [
        participant("me", true),
        participant("a"),
        participant("b"),
        participant("c"),
        participant("d"),
      ],
      // Only `d` has a camera; `b` speaks without one.
      remoteCameras: [camera("d")],
      shares: [],
      cameraEnabled: false,
      selectedVideoDeviceId: null,
      localScreenTrack: null,
    });
    const layout = resolveStage(tiles, {
      focusedKey: "participant:a",
      speakerFilmstrip: { recentSpeakers: ["b"], selfIdentity: "me" },
    });
    const b = layout.filmstrip.find((t) => t.key === "participant:b");
    expect(b).toBeDefined();
    expect(b?.kind === "participant" && b.camera).toBeNull();
  });
});

describe("resolveStage + ActiveSpeakerTracker — hysteresis at the strip (fake clock)", () => {
  const tiles = room(["a", "b", "c", "d"]);
  const strip = (recentSpeakers: readonly string[]): string[] =>
    keys(
      resolveStage(tiles, {
        focusedKey: "participant:a",
        speakerFilmstrip: { recentSpeakers, selfIdentity: "me" },
      }).filmstrip,
    );

  it("a sub-300 ms blip never puts anyone in the strip", () => {
    const tracker = createActiveSpeakerTracker();
    tracker.push([{ identity: "b", speaking: true }], 0);
    // 299 ms of noise — a cough, a chair, one syllable.
    expect(strip(tracker.tick(DEFAULT_ACTIVE_SPEAKER_ATTACK_MS - 1).recent)).toEqual([
      "participant:me",
    ]);
    tracker.push([{ identity: "b", speaking: false }], DEFAULT_ACTIVE_SPEAKER_ATTACK_MS - 1);
    expect(strip(tracker.tick(60_000).recent)).toEqual(["participant:me"]);
  });

  it("300 ms of sustained speech admits the tile, and 5 s of silence removes it", () => {
    const tracker = createActiveSpeakerTracker();
    tracker.push([{ identity: "b", speaking: true }], 0);
    expect(strip(tracker.tick(DEFAULT_ACTIVE_SPEAKER_ATTACK_MS).recent)).toEqual([
      "participant:me",
      "participant:b",
    ]);

    const quietAt = DEFAULT_ACTIVE_SPEAKER_ATTACK_MS;
    tracker.push([{ identity: "b", speaking: false }], quietAt);
    // A sentence gap must NOT evict the tile.
    expect(strip(tracker.tick(quietAt + DEFAULT_ACTIVE_SPEAKER_RELEASE_MS - 1).recent)).toEqual([
      "participant:me",
      "participant:b",
    ]);
    // 5 s later it goes, and its <video> unmounts with it.
    expect(strip(tracker.tick(quietAt + DEFAULT_ACTIVE_SPEAKER_RELEASE_MS).recent)).toEqual([
      "participant:me",
    ]);
  });

  it("caps the conditional tiles at the tracker's ceiling", () => {
    const many = room(["a", "b", "c", "d", "e", "f", "g"]);
    const tracker = createActiveSpeakerTracker();
    const talkers = ["b", "c", "d", "e", "f", "g"];
    tracker.push(
      talkers.map((identity) => ({ identity, speaking: true })),
      0,
    );
    const recent = tracker.tick(DEFAULT_ACTIVE_SPEAKER_ATTACK_MS).recent;
    expect(recent).toHaveLength(5); // DEFAULT_ACTIVE_SPEAKER_MAX_RECENT
    const layout = resolveStage(many, {
      focusedKey: "participant:a",
      speakerFilmstrip: { recentSpeakers: recent, selfIdentity: "me" },
    });
    // me + at most 5 speakers on screen; the 6th stays counted, not rendered.
    expect(layout.filmstrip).toHaveLength(6);
    expect(layout.hiddenBySpeakerRule).toHaveLength(1);
  });
});

describe("computeGridShape", () => {
  it("puts two tiles side by side on a wide stage and stacks them on a tall one", () => {
    expect(computeGridShape(2, { width: 1200, height: 500 }).cols).toBe(2);
    expect(computeGridShape(2, { width: 500, height: 1200 }).cols).toBe(1);
  });

  it("falls back to a fixed-column scrolling grid when tiles would go below minTile", () => {
    const shape = computeGridShape(24, { width: 900, height: 500 });
    expect(shape.scroll).toBe(true);
    expect(shape.cols).toBeGreaterThan(0);
  });
});
