/**
 * Watch-party client model (M20, ADR 0016).
 *
 * The four things that are genuinely easy to get wrong and impossible to eyeball
 * in a running app: who sees controls, what counts as a YouTube link, when a
 * drift becomes a seek, and — the one that bites — when a seek must NOT happen
 * because we just did one.
 */

import { describe, expect, it } from "vitest";
import { WATCH_DRIFT_TOLERANCE_SECONDS } from "@demli/config";
import type { WatchSessionStatePayload } from "@demli/protocol";
import type { ChannelId, UserId } from "@demli/types";
import {
  buildEmbedUrl,
  detectHostControl,
  expectedPositionSec,
  initialSeekHysteresis,
  nextSeekDecision,
  sessionFromPayload,
  validateWatchLink,
  watchControlMode,
  MAX_LATENCY_COMPENSATION_SEC,
  SEEK_COOLDOWN_MS,
  YOUTUBE_EMBED_ORIGIN,
  type SeekHysteresis,
  type WatchSession,
} from "../watch-party.js";

const CHANNEL = "chan-1" as ChannelId;
const HOST = "user-host" as UserId;
const VIEWER = "user-viewer" as UserId;
const VIDEO = "dQw4w9WgXcQ";

function payload(over: Partial<WatchSessionStatePayload> = {}): WatchSessionStatePayload {
  return {
    channelId: CHANNEL,
    hostId: HOST,
    source: "youtube",
    videoId: VIDEO,
    positionSec: 100,
    playing: true,
    serverTime: new Date(1_000_000).toISOString(),
    ...over,
  };
}

function session(over: Partial<WatchSession> = {}): WatchSession {
  return {
    channelId: CHANNEL,
    hostId: HOST,
    source: "youtube",
    videoId: VIDEO,
    positionSec: 100,
    playing: true,
    receivedAtMs: 1_000_000,
    latencySec: 0,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Who may control
// ---------------------------------------------------------------------------

describe("watchControlMode", () => {
  it("gives the host control", () => {
    expect(watchControlMode({ session: session(), userId: HOST, isOwner: false })).toBe("host");
  });

  it("does NOT give a non-host control — the core rule of the feature", () => {
    expect(watchControlMode({ session: session(), userId: VIEWER, isOwner: false })).toBe(
      "viewer",
    );
  });

  it("gives the server owner control even when someone else hosts (ADR 0016 override)", () => {
    expect(watchControlMode({ session: session(), userId: VIEWER, isOwner: true })).toBe("host");
  });

  it("is viewer when there is no session or no signed-in user", () => {
    expect(watchControlMode({ session: null, userId: HOST, isOwner: true })).toBe("viewer");
    expect(watchControlMode({ session: session(), userId: null, isOwner: false })).toBe("viewer");
  });

  it("follows a host handoff without anything else changing", () => {
    const handed = session({ hostId: VIEWER });
    expect(watchControlMode({ session: handed, userId: VIEWER, isOwner: false })).toBe("host");
    expect(watchControlMode({ session: handed, userId: HOST, isOwner: false })).toBe("viewer");
  });
});

// ---------------------------------------------------------------------------
// Link grammar
// ---------------------------------------------------------------------------

describe("validateWatchLink", () => {
  it("accepts the shapes a person actually pastes", () => {
    for (const link of [
      VIDEO,
      `https://www.youtube.com/watch?v=${VIDEO}`,
      `https://youtu.be/${VIDEO}`,
      `https://www.youtube.com/embed/${VIDEO}`,
      `https://www.youtube.com/shorts/${VIDEO}`,
      `youtube.com/watch?v=${VIDEO}&t=42s`,
      `  https://m.youtube.com/watch?v=${VIDEO}  `,
    ]) {
      expect(validateWatchLink(link)).toEqual({ ok: true, videoId: VIDEO });
    }
  });

  it("refuses anything that is not a YouTube video link", () => {
    for (const link of [
      "https://vimeo.com/123456",
      // Lookalike domain — the exact case the shared parser exists to refuse.
      `https://youtube.com.evil.test/watch?v=${VIDEO}`,
      "javascript:alert(1)",
      "https://www.youtube.com/watch?v=tooshort",
      "https://www.youtube.com/watch",
      "not a link",
    ]) {
      expect(validateWatchLink(link)).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("separates 'empty' from 'invalid' so a blank field is not an error", () => {
    expect(validateWatchLink("")).toEqual({ ok: false, reason: "empty" });
    expect(validateWatchLink("   ")).toEqual({ ok: false, reason: "empty" });
  });
});

// ---------------------------------------------------------------------------
// Embed URL
// ---------------------------------------------------------------------------

describe("buildEmbedUrl", () => {
  it("builds a nocookie embed with the jsapi enabled and no external script", () => {
    const url = buildEmbedUrl({ videoId: VIDEO, startSec: 42.7, controls: true });
    expect(url).not.toBeNull();
    const parsed = new URL(url as string);
    expect(parsed.origin).toBe(YOUTUBE_EMBED_ORIGIN);
    expect(parsed.pathname).toBe(`/embed/${VIDEO}`);
    expect(parsed.searchParams.get("enablejsapi")).toBe("1");
    expect(parsed.searchParams.get("start")).toBe("42");
    expect(parsed.searchParams.get("controls")).toBe("1");
  });

  it("hands viewers a player with no transport controls", () => {
    const url = new URL(
      buildEmbedUrl({ videoId: VIDEO, startSec: 0, controls: false }) as string,
    );
    expect(url.searchParams.get("controls")).toBe("0");
    expect(url.searchParams.get("disablekb")).toBe("1");
  });

  it("returns null rather than a half-built URL for a non-id", () => {
    // Unreachable from the server (it stores only normalized ids), but this
    // string ends up in an iframe src, so it is re-checked regardless.
    expect(buildEmbedUrl({ videoId: "../../evil", startSec: 0, controls: true })).toBeNull();
    expect(buildEmbedUrl({ videoId: "", startSec: 0, controls: true })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Position projection
// ---------------------------------------------------------------------------

describe("expectedPositionSec", () => {
  it("runs a playing session forward from the local instant the frame landed", () => {
    const s = session({ positionSec: 100, receivedAtMs: 1_000_000 });
    expect(expectedPositionSec(s, 1_000_000)).toBeCloseTo(100, 5);
    expect(expectedPositionSec(s, 1_004_000)).toBeCloseTo(104, 5);
  });

  it("freezes a paused session", () => {
    const s = session({ positionSec: 100, playing: false });
    expect(expectedPositionSec(s, 1_060_000)).toBe(100);
  });

  it("bounds the serverTime-derived latency so a skewed clock cannot force seeks", () => {
    // A client whose clock is an hour fast would otherwise compute an hour of
    // "travel time" and seek the whole room's playhead into next week.
    const skewed = sessionFromPayload(payload(), 1_000_000 + 3_600_000);
    expect(skewed.latencySec).toBe(MAX_LATENCY_COMPENSATION_SEC);
    expect(MAX_LATENCY_COMPENSATION_SEC).toBeLessThan(WATCH_DRIFT_TOLERANCE_SECONDS);
    // A clock that is BEHIND the server produces a negative raw difference,
    // which must not rewind anyone either.
    const behind = sessionFromPayload(payload(), 1_000_000 - 3_600_000);
    expect(behind.latencySec).toBe(0);
  });

  it("compensates a realistic one-way latency", () => {
    const s = sessionFromPayload(payload({ positionSec: 100 }), 1_000_000 + 120);
    expect(s.latencySec).toBeCloseTo(0.12, 5);
    expect(expectedPositionSec(s, 1_000_120)).toBeCloseTo(100.12, 5);
  });
});

// ---------------------------------------------------------------------------
// Drift + hysteresis — the seek-loop guard
// ---------------------------------------------------------------------------

describe("nextSeekDecision", () => {
  const base = { nowMs: 10_000, hysteresis: initialSeekHysteresis };

  it("does NOT seek while the drift is inside tolerance", () => {
    const decision = nextSeekDecision({
      ...base,
      expectedSec: 100,
      actualSec: 100 + WATCH_DRIFT_TOLERANCE_SECONDS - 0.01,
    });
    expect(decision.seekToSec).toBeNull();
  });

  it("does NOT seek exactly AT the tolerance (the threshold must be exceeded)", () => {
    const decision = nextSeekDecision({
      ...base,
      expectedSec: 100,
      actualSec: 100 + WATCH_DRIFT_TOLERANCE_SECONDS,
    });
    expect(decision.seekToSec).toBeNull();
  });

  it("seeks once the drift exceeds the tolerance, in either direction", () => {
    const ahead = nextSeekDecision({ ...base, expectedSec: 100, actualSec: 130 });
    expect(ahead.seekToSec).toBe(100);
    const behind = nextSeekDecision({ ...base, expectedSec: 100, actualSec: 70 });
    expect(behind.seekToSec).toBe(100);
  });

  it("stays quiet for the cooldown after a seek — the seek-loop guard", () => {
    // A seek is not instant: the player keeps reporting the OLD position while
    // it buffers, so an unguarded checker would re-seek every tick forever.
    const first = nextSeekDecision({ ...base, expectedSec: 100, actualSec: 130 });
    expect(first.seekToSec).toBe(100);

    // The player has not caught up yet and still reports the pre-seek position.
    const during = nextSeekDecision({
      expectedSec: 101,
      actualSec: 130,
      nowMs: base.nowMs + SEEK_COOLDOWN_MS - 1,
      hysteresis: first.hysteresis,
    });
    expect(during.seekToSec).toBeNull();
    // A check inside the quiet period is not evidence: it must not escalate the
    // backoff either, or a slow player would push the cooldown up on its own.
    expect(during.hysteresis).toBe(first.hysteresis);
  });

  it("corrects again once the cooldown has elapsed and the drift persists", () => {
    const first = nextSeekDecision({ ...base, expectedSec: 100, actualSec: 130 });
    const after = nextSeekDecision({
      expectedSec: 104,
      actualSec: 130,
      nowMs: base.nowMs + SEEK_COOLDOWN_MS + 1,
      hysteresis: first.hysteresis,
    });
    expect(after.seekToSec).toBe(104);
  });

  it("backs off while a drift refuses to converge (an ad break), then re-converges", () => {
    // During an ad the player reports the AD's timeline, so the measured drift
    // stays large no matter how often we seek. The cooldown must grow instead of
    // firing a correction every heartbeat for the length of the ad.
    let hysteresis: SeekHysteresis = initialSeekHysteresis;
    let nowMs = 0;
    const seekTimes: number[] = [];
    for (let i = 0; i < 40; i++) {
      nowMs += 1_000; // the client's 1 s sync tick
      const decision = nextSeekDecision({
        expectedSec: nowMs / 1000,
        actualSec: 0, // an ad: the reported time never approaches the video's
        nowMs,
        hysteresis,
      });
      hysteresis = decision.hysteresis;
      if (decision.seekToSec !== null) seekTimes.push(nowMs);
    }
    // 40 seconds of unresolvable drift, at a 1 s tick, with a 3 s base cooldown:
    // an unguarded checker would have fired ~40 times. The backoff keeps it in
    // single digits.
    expect(seekTimes.length).toBeLessThanOrEqual(6);
    expect(seekTimes.length).toBeGreaterThanOrEqual(3);
    // …and the gaps grow rather than staying flat.
    const gaps = seekTimes.slice(1).map((at, i) => at - (seekTimes[i] as number));
    expect(gaps[gaps.length - 1] as number).toBeGreaterThan(gaps[0] as number);

    // The ad ends and the player lands back in sync: the backoff clears, so the
    // NEXT genuine drift is corrected at the normal cadence, not the throttled one.
    const converged = nextSeekDecision({
      expectedSec: 100,
      actualSec: 100,
      nowMs: nowMs + 60_000,
      hysteresis,
    });
    expect(converged.seekToSec).toBeNull();
    expect(converged.hysteresis.consecutiveSeeks).toBe(0);

    const afterAd = nextSeekDecision({
      expectedSec: 200,
      actualSec: 150,
      nowMs: nowMs + 60_000 + SEEK_COOLDOWN_MS + 1,
      hysteresis: converged.hysteresis,
    });
    expect(afterAd.seekToSec).toBe(200);
  });

  it("seeks on the very first check with no prior state", () => {
    const decision = nextSeekDecision({ ...base, expectedSec: 500, actualSec: 0 });
    expect(decision.seekToSec).toBe(500);
    expect(decision.hysteresis.lastSeekAtMs).toBe(base.nowMs);
  });
});

// ---------------------------------------------------------------------------
// Reading the host's own player
// ---------------------------------------------------------------------------

describe("detectHostControl", () => {
  it("says nothing on the first reading (it only seeds the baseline)", () => {
    expect(
      detectHostControl({
        previous: null,
        current: { playing: true, currentTime: 10, atMs: 0 },
      }),
    ).toBeNull();
  });

  it("reports play and pause transitions at the host's own position", () => {
    expect(
      detectHostControl({
        previous: { playing: true, currentTime: 30, atMs: 0 },
        current: { playing: false, currentTime: 30.2, atMs: 200 },
      }),
    ).toEqual({ action: "pause", positionSec: 30.2 });

    expect(
      detectHostControl({
        previous: { playing: false, currentTime: 30, atMs: 0 },
        current: { playing: true, currentTime: 30, atMs: 5_000 },
      }),
    ).toEqual({ action: "play", positionSec: 30 });
  });

  it("says nothing while playback simply runs forward", () => {
    expect(
      detectHostControl({
        previous: { playing: true, currentTime: 30, atMs: 0 },
        current: { playing: true, currentTime: 31, atMs: 1_000 },
      }),
    ).toBeNull();
  });

  it("tolerates a stall without mistaking it for a seek", () => {
    // Real time moved 1 s, playback moved 0 — buffering, not a scrub.
    expect(
      detectHostControl({
        previous: { playing: true, currentTime: 30, atMs: 0 },
        current: { playing: true, currentTime: 30, atMs: 1_000 },
      }),
    ).toBeNull();
  });

  it("reports a scrub, forwards or backwards, playing or paused", () => {
    expect(
      detectHostControl({
        previous: { playing: true, currentTime: 30, atMs: 0 },
        current: { playing: true, currentTime: 600, atMs: 1_000 },
      }),
    ).toEqual({ action: "seek", positionSec: 600 });

    expect(
      detectHostControl({
        previous: { playing: false, currentTime: 600, atMs: 0 },
        current: { playing: false, currentTime: 12, atMs: 800 },
      }),
    ).toEqual({ action: "seek", positionSec: 12 });
  });
});
