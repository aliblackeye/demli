/**
 * Process-audio IPC gate (pre-release security audit).
 *
 * Drives the REAL `capture.ts` + `process-audio.ts` IPC handlers with electron,
 * the helper process and the filesystem mocked. What it pins:
 *  - a renderer that never picked a source cannot start a capture at all —
 *    `start({ mode: "system" })` used to record the whole PC silently;
 *  - a pick in the share picker (same webContents) allows it; another
 *    webContents cannot ride that pick;
 *  - one capture per webContents: a second start ends the first helper;
 *  - a reload / main-frame navigation or a renderer crash kills the helper and
 *    ends the right to capture, not only `destroyed`;
 *  - the end of a share (clearSelection) ends the right too.
 */

import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: { sender: FakeWebContents }, payload?: unknown) => unknown;

const handlers = new Map<string, Handler>();
const contentsById = new Map<number, FakeWebContents>();
let displayMediaHandler: ((req: unknown, cb: (s: unknown) => void) => void) | null = null;

class FakeWebContents extends EventEmitter {
  sent: Array<{ channel: string; payload: unknown }> = [];
  constructor(readonly id: number) {
    super();
    contentsById.set(id, this);
  }
  isDestroyed(): boolean {
    return false;
  }
  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload });
  }
}

class FakeChild extends EventEmitter {
  stdin = { end: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill = vi.fn(() => {
    this.killed = true;
  });
}

const children: FakeChild[] = [];

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => "C:/tmp" },
  ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) },
  webContents: { fromId: (id: number) => contentsById.get(id) ?? null },
  desktopCapturer: {
    getSources: async () => [
      { id: "screen:0:0", name: "Screen", thumbnail: { isEmpty: () => true, toDataURL: () => "" } },
      { id: "window:7:0", name: "Film", thumbnail: { isEmpty: () => true, toDataURL: () => "" } },
    ],
  },
  session: {
    defaultSession: {
      setDisplayMediaRequestHandler: (fn: typeof displayMediaHandler) => {
        displayMediaHandler = fn;
      },
    },
  },
}));
vi.mock("node:child_process", () => ({
  spawn: () => {
    const child = new FakeChild();
    children.push(child);
    // The helper reports ready once Windows accepted the capture.
    setTimeout(() => child.stderr.emit("data", Buffer.from("ready 48000 2\n")), 0);
    return child;
  },
  execFile: (
    _path: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    // --window-pid → the film's PID; --ancestors → Demli's parent chain.
    cb(null, args[0] === "--window-pid" ? "4242\n" : "1\n", "");
  },
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: () => true,
  appendFile: () => undefined,
}));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  release: () => "10.0.22631",
}));

const CH = {
  list: "demli:capture:list-sources",
  select: "demli:capture:select-source",
  clear: "demli:capture:clear-selection",
  start: "demli:process-audio:start",
};

const realPlatform = process.platform;

beforeAll(async () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  const capture = await import("./capture");
  const processAudio = await import("./process-audio");
  capture.registerScreenCapture();
  processAudio.registerProcessAudio();
}, 60_000);

let nextId = 100;
let wc: FakeWebContents;

beforeEach(() => {
  wc = new FakeWebContents(nextId++);
  children.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

async function invoke(channel: string, sender: FakeWebContents, payload?: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return handler({ sender }, payload);
}

async function pick(sender: FakeWebContents, sourceId: string): Promise<void> {
  await invoke(CH.list, sender, undefined);
  await invoke(CH.select, sender, { sourceId });
}

async function serve(): Promise<void> {
  await new Promise<void>((resolve) => displayMediaHandler?.({}, () => resolve()));
}

describe("process-audio start gate", () => {
  it("refuses a capture from a window that is not sharing anything", async () => {
    const result = await invoke(CH.start, wc, { mode: "system" });
    expect(result).toEqual({ ok: false, reason: "no_active_share" });
    expect(children).toHaveLength(0);
  });

  it("allows a capture right after the same window picked a source", async () => {
    await pick(wc, "screen:0:0");
    const result = (await invoke(CH.start, wc, { mode: "system" })) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(children).toHaveLength(1);
  });

  it("another window cannot ride someone else's pick", async () => {
    await pick(wc, "screen:0:0");
    const other = new FakeWebContents(nextId++);
    expect(await invoke(CH.start, other, { mode: "system" })).toEqual({
      ok: false,
      reason: "no_active_share",
    });
  });

  it("'app' must target the window being shared", async () => {
    await pick(wc, "screen:0:0");
    expect(await invoke(CH.start, wc, { mode: "app", sourceId: "window:7:0" })).toEqual({
      ok: false,
      reason: "no_active_share",
    });
  });

  it("a stale pick that never became a share no longer allows a capture", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await pick(wc, "screen:0:0");
    vi.setSystemTime(Date.now() + 60_000);
    expect(await invoke(CH.start, wc, { mode: "system" })).toEqual({
      ok: false,
      reason: "no_active_share",
    });
  });

  it("a served share keeps the right while it is live, and loses it when it ends", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await pick(wc, "screen:0:0");
    await serve();
    vi.setSystemTime(Date.now() + 10 * 60_000);
    const live = (await invoke(CH.start, wc, { mode: "system" })) as { ok: boolean };
    expect(live.ok).toBe(true);
    await invoke(CH.clear, wc);
    expect(await invoke(CH.start, wc, { mode: "system" })).toEqual({
      ok: false,
      reason: "no_active_share",
    });
  });

  it("keeps at most one capture per window: a new start ends the old helper", async () => {
    await pick(wc, "screen:0:0");
    await invoke(CH.start, wc, { mode: "system" });
    await invoke(CH.start, wc, { mode: "system" });
    expect(children).toHaveLength(2);
    expect(children[0]?.killed).toBe(true);
    expect(children[1]?.killed).toBe(false);
  });

  it.each([
    ["a reload / main-frame navigation", (c: FakeWebContents) =>
      c.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false })],
    ["a renderer crash", (c: FakeWebContents) => c.emit("render-process-gone", {}, { reason: "crashed" })],
  ])("%s kills the helper and ends the right to capture", async (_label, reset) => {
    await pick(wc, "screen:0:0");
    await serve();
    await invoke(CH.start, wc, { mode: "system" });
    expect(children[0]?.killed).toBe(false);

    reset(wc);

    expect(children[0]?.killed).toBe(true);
    expect(await invoke(CH.start, wc, { mode: "system" })).toEqual({
      ok: false,
      reason: "no_active_share",
    });
  });

  it("an in-page (same-document) or sub-frame navigation does not end the share", async () => {
    await pick(wc, "screen:0:0");
    await serve();
    await invoke(CH.start, wc, { mode: "system" });
    wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    wc.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
    expect(children[0]?.killed).toBe(false);
  });
});

afterAll(() => {
  Object.defineProperty(process, "platform", { value: realPlatform });
});
