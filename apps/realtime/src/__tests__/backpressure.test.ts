import { describe, expect, it, vi } from "vitest";
import {
  dropIfOverBuffered,
  MAX_BUFFERED_BYTES,
  type BackpressureSocket,
} from "../backpressure.js";

function fakeSocket(bufferedAmount: number): BackpressureSocket & { terminated: number } {
  return {
    bufferedAmount,
    terminated: 0,
    terminate(): void {
      this.terminated += 1;
    },
  };
}

describe("dropIfOverBuffered", () => {
  it("leaves a socket alone while its queue is within budget", () => {
    const socket = fakeSocket(MAX_BUFFERED_BYTES - 1);
    expect(dropIfOverBuffered(socket)).toBe(false);
    expect(socket.terminated).toBe(0);
  });

  it("treats exactly-at-budget as healthy (the cap is a ceiling, not a trigger)", () => {
    const socket = fakeSocket(MAX_BUFFERED_BYTES);
    expect(dropIfOverBuffered(socket)).toBe(false);
    expect(socket.terminated).toBe(0);
  });

  it("terminates a socket whose queue passes the budget", () => {
    const socket = fakeSocket(MAX_BUFFERED_BYTES + 1);
    expect(dropIfOverBuffered(socket)).toBe(true);
    expect(socket.terminated).toBe(1);
  });

  it("reports the observed queue size to the caller's logger", () => {
    const socket = fakeSocket(5_000_000);
    const onDrop = vi.fn();
    dropIfOverBuffered(socket, MAX_BUFFERED_BYTES, onDrop);
    expect(onDrop).toHaveBeenCalledWith(5_000_000);
  });

  it("honors an overridden ceiling", () => {
    expect(dropIfOverBuffered(fakeSocket(2_048), 1_024)).toBe(true);
    expect(dropIfOverBuffered(fakeSocket(512), 1_024)).toBe(false);
  });

  it("keeps a normal client's queue far below the budget", () => {
    // ~26 KB is the largest single server frame this protocol can produce (a
    // full-length message with its attachment metadata). Even 30 of them queued
    // back to back must not look like an attacker.
    const thirtyLargestFrames = 30 * 26_000;
    expect(thirtyLargestFrames).toBeLessThan(MAX_BUFFERED_BYTES);
    expect(dropIfOverBuffered(fakeSocket(thirtyLargestFrames))).toBe(false);
  });
});
