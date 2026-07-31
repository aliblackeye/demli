/**
 * M10-7 QA gap-fill — unit tests for the boot-time orphan-sweep job
 * (`startAttachmentSweep`). The db-level `sweepStalePending` selection is
 * already pinned in packages/db; this covers the interval wiring the API owns:
 * purge of the swept storage objects, resilience to storage/db failures
 * (logged, never thrown — a broken sweep must not kill the API), no storage
 * call on an empty sweep, and a clean stop. Fake timers, mocked repos/storage.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Repositories } from "@demli/db";
import { startAttachmentSweep } from "../modules/attachments/index.js";
import type {
  AttachmentStorage,
  ObjectProbe,
  SignedRead,
  SignedUpload,
} from "../lib/storage.js";

const HOUR_MS = 60 * 60 * 1000;

interface SweptRow {
  id: string;
  storagePath: string;
}

function makeRepos(sweep: () => Promise<SweptRow[]>): {
  repos: Repositories;
  sweepMock: ReturnType<typeof vi.fn>;
} {
  const sweepMock = vi.fn(sweep);
  return {
    repos: { attachments: { sweepStalePending: sweepMock } } as unknown as Repositories,
    sweepMock,
  };
}

class SweepMockStorage implements AttachmentStorage {
  removeCalls: string[][] = [];
  failRemove = false;

  async createSignedUploadUrl(): Promise<SignedUpload> {
    throw new Error("not used by the sweep");
  }
  async createSignedReadUrl(): Promise<SignedRead> {
    throw new Error("not used by the sweep");
  }
  async probeObject(): Promise<ObjectProbe> {
    throw new Error("not used by the sweep");
  }
  async upload(): Promise<void> {
    throw new Error("not used by the sweep");
  }
  async remove(paths: string[]): Promise<void> {
    if (this.failRemove) throw new Error("storage down");
    this.removeCalls.push(paths);
  }
}

describe("startAttachmentSweep", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("purges the swept rows' storage objects on each tick", async () => {
    const rows: SweptRow[] = [
      { id: "a1", storagePath: "attachments/c1/a1.png" },
      { id: "a2", storagePath: "attachments/c1/a2.mp4" },
    ];
    const { repos, sweepMock } = makeRepos(async () => rows);
    const storage = new SweepMockStorage();

    const stop = startAttachmentSweep({ repos, storage, olderThanHours: 24 });
    await vi.advanceTimersByTimeAsync(HOUR_MS);

    expect(sweepMock).toHaveBeenCalledWith(24);
    expect(storage.removeCalls).toEqual([
      ["attachments/c1/a1.png", "attachments/c1/a2.mp4"],
    ]);
    stop();
  });

  it("does not touch storage when the sweep finds nothing", async () => {
    const { repos } = makeRepos(async () => []);
    const storage = new SweepMockStorage();

    const stop = startAttachmentSweep({ repos, storage });
    await vi.advanceTimersByTimeAsync(HOUR_MS);

    expect(storage.removeCalls).toEqual([]);
    stop();
  });

  it("survives a storage failure — logged, not thrown, next tick still runs", async () => {
    const { repos, sweepMock } = makeRepos(async () => [
      { id: "a1", storagePath: "attachments/c1/a1.png" },
    ]);
    const storage = new SweepMockStorage();
    storage.failRemove = true;
    const logs: string[] = [];

    const stop = startAttachmentSweep({ repos, storage, log: (m) => logs.push(m) });
    await vi.advanceTimersByTimeAsync(HOUR_MS);

    expect(logs.some((m) => m.includes("storage remove failed"))).toBe(true);

    // The job keeps ticking after the failure.
    storage.failRemove = false;
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(sweepMock).toHaveBeenCalledTimes(2);
    expect(storage.removeCalls).toHaveLength(1);
    stop();
  });

  it("survives a db sweep failure — logged, not thrown", async () => {
    const { repos, sweepMock } = makeRepos(async () => {
      throw new Error("db down");
    });
    const storage = new SweepMockStorage();
    const logs: string[] = [];

    const stop = startAttachmentSweep({ repos, storage, log: (m) => logs.push(m) });
    await vi.advanceTimersByTimeAsync(2 * HOUR_MS);

    expect(sweepMock).toHaveBeenCalledTimes(2);
    expect(logs.filter((m) => m.includes("db sweep failed"))).toHaveLength(2);
    expect(storage.removeCalls).toEqual([]);
    stop();
  });

  it("stops cleanly — no ticks after the returned stop() is called", async () => {
    const { repos, sweepMock } = makeRepos(async () => []);
    const storage = new SweepMockStorage();

    const stop = startAttachmentSweep({ repos, storage, intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sweepMock).toHaveBeenCalledTimes(1);

    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sweepMock).toHaveBeenCalledTimes(1);
  });
});
