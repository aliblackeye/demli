import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The `external-link:open` IPC handler.
 *
 * This is the ONLY remaining path from the renderer to `shell.openExternal`, so
 * the test drives the real handler through a mocked Electron and asserts what
 * actually reaches the OS: the scheme gate, the top-frame sender check (the
 * thing that keeps the Watch Party embed out), and the rate limit.
 */

const openExternal = vi.fn(async (_url: string): Promise<void> => {});
const handlers = new Map<string, (event: unknown, raw: unknown) => Promise<boolean>>();
/** What `BrowserWindow.fromWebContents` should return for the next call. */
let windowForSender: object | null = { id: 1 };

vi.mock("electron", () => ({
  shell: {
    openExternal: (url: string) => openExternal(url),
  },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, raw: unknown) => Promise<boolean>) => {
      handlers.set(channel, handler);
    },
  },
  BrowserWindow: {
    fromWebContents: () => windowForSender,
  },
}));

const { registerExternalLinks, resetExternalLinkRateLimitForTests } = await import(
  "./external-link"
);
const { EXTERNAL_LINK_CHANNELS } = await import("./external-link-types");

/** A sender that looks like the TOP frame of one of our own windows. */
const topFrameEvent = { sender: {}, senderFrame: { parent: null } };
/** A sender that looks like a SUBFRAME — i.e. embedded third-party content. */
const subFrameEvent = { sender: {}, senderFrame: { parent: { parent: null } } };

function invoke(event: unknown, url: unknown): Promise<boolean> {
  const handler = handlers.get(EXTERNAL_LINK_CHANNELS.open);
  if (!handler) throw new Error("external-link:open was never registered");
  return handler(event, url);
}

describe("external-link IPC", () => {
  beforeEach(() => {
    openExternal.mockClear();
    windowForSender = { id: 1 };
    resetExternalLinkRateLimitForTests();
    registerExternalLinks();
  });

  it("registers exactly its own channels, idempotently", () => {
    registerExternalLinks();
    registerExternalLinks();
    expect([...handlers.keys()]).toEqual([EXTERNAL_LINK_CHANNELS.open]);
  });

  it("opens an http(s) url from the top frame", async () => {
    await expect(invoke(topFrameEvent, "https://example.test/page")).resolves.toBe(true);
    expect(openExternal).toHaveBeenCalledWith("https://example.test/page");
  });

  it("refuses non-http(s) schemes without touching the OS", async () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///C:/Windows/System32/calc.exe",
      "ms-msdt:/id PCWDiagnostic",
      "demli://join/abc",
    ]) {
      await expect(invoke(topFrameEvent, url)).resolves.toBe(false);
    }
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("refuses unparseable and non-string payloads", async () => {
    for (const url of ["", "not a url", "/relative", undefined, null, 42, { url: "https://x.test" }]) {
      await expect(invoke(topFrameEvent, url)).resolves.toBe(false);
    }
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("refuses a SUBFRAME sender — the embed must never reach the OS", async () => {
    await expect(invoke(subFrameEvent, "https://example.test/")).resolves.toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("refuses a sender that belongs to no window of ours", async () => {
    windowForSender = null;
    await expect(invoke(topFrameEvent, "https://example.test/")).resolves.toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("rate limits a renderer calling in a loop", async () => {
    const results: boolean[] = [];
    for (let i = 0; i < 20; i += 1) {
      results.push(await invoke(topFrameEvent, `https://example.test/${i}`));
    }
    const opened = results.filter(Boolean).length;
    expect(opened).toBeGreaterThan(0);
    expect(opened).toBeLessThan(20);
    expect(openExternal).toHaveBeenCalledTimes(opened);
  });

  it("reports false instead of throwing when the OS refuses", async () => {
    openExternal.mockRejectedValueOnce(new Error("no handler for protocol"));
    await expect(invoke(topFrameEvent, "https://example.test/")).resolves.toBe(false);
  });
});
