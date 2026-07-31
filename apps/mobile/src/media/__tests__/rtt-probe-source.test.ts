/**
 * Source-level invariant: the mobile ping indicator must read the MEDIA path,
 * not the signal socket.
 *
 * No behavioural test can catch this regression. Both sources return "a number
 * of milliseconds" and both look correct in every unit test, because the thing
 * that separates them only exists at runtime on a loaded main thread. LiveKit's
 * `engine.client.rtt` is computed as `Date.now() - lastPingTimestamp` with BOTH
 * stamps taken in main-thread JS, so any long task landing between the ping
 * going out and the pong being handled is added to the reported value 1:1 — it
 * reports JS scheduling, not the network. Measured on desktop against a real
 * socket with the pong pinned at 40 ms: idle read 42 ms p95, and injecting
 * 350 ms of main-thread work pushed the SAME formula to 355 ms p95 while the
 * true round trip never moved.
 *
 * That is precisely the founder's "watch party → ping spikes" report, and the
 * phone is the worse case: it runs the film in a WebView on the same thread and
 * usually holds the room's weakest uplink, so a spurious reading is likeliest
 * exactly where a real one would matter most.
 *
 * `candidate-pair.currentRoundTripTime` is measured by libwebrtc's own network
 * thread from the STUN binding request/response, so a busy JS thread delays WHEN
 * we read the value, never WHAT it says.
 *
 * The signal RTT is still allowed as a FALLBACK — it is the only reading
 * available before WebRTC has nominated a pair — so this pins the ordering
 * rather than banning the string.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const ADAPTER = join(dirname(fileURLToPath(import.meta.url)), "..", "livekit-room.ts");
const source = readFileSync(ADAPTER, "utf8");

describe("mobile connection-quality probe reads the media path", () => {
  it("samples candidate-pair RTT from getStats()", () => {
    expect(source).toContain('stat.type === "candidate-pair"');
    expect(source).toContain("currentRoundTripTime");
    expect(source).toContain("getStats()");
  });

  it("prefers the publisher transport, which carries our uplink", () => {
    expect(source).toMatch(/pcManager\?\.publisher \?\? pcManager\?\.subscriber/);
  });

  it("only accepts a nominated or succeeded pair", () => {
    expect(source).toMatch(/stat\.nominated === true \|\| stat\.state === "succeeded"/);
  });

  it("keeps engine.client.rtt strictly BELOW the media reading, never above it", () => {
    const mediaAt = source.indexOf("mediaRttMs !== null");
    const signalAt = source.indexOf("room.engine.client.rtt");
    expect(mediaAt).toBeGreaterThan(-1);
    expect(signalAt).toBeGreaterThan(-1);
    // The media sample must be returned first; the signal RTT is reachable only
    // when there is no pair yet. Reversing these silently restores the bug.
    expect(mediaAt).toBeLessThan(signalAt);
  });

  it("guards against overlapping getStats() calls and releases on close", () => {
    // Without the in-flight guard a slow getStats() on a loaded phone would pile
    // up one call per 1 Hz tick; without `closed` the sampler keeps writing after
    // the room is gone.
    expect(source).toContain("if (sampling || closed) return;");
    expect(source).toMatch(/close\(\) \{\s*closed = true;/);
  });
});
