import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_UPDATE_REQUIRED_CLOSE_CODE,
  CLIENT_UPDATE_REQUIRED_CODE,
  CLIENT_UPDATE_REQUIRED_STATUS,
  createClientGate,
  readClientUpdateDownloadUrl,
  readClientUpdateRequired,
  readClientUpdateRequiredClose,
} from "../client-gate.js";
import { createApiClient } from "../api-client.js";
import { RealtimeClient, type RealtimeHandlers } from "../realtime-client.js";

/**
 * The build-retirement gate: HTTP 426 and gateway close 4426 are ONE event with
 * two transports, so both have to arrive at the same recogniser. These tests
 * cover the recogniser, the two transports that feed it, and the latch the
 * migration screens read.
 */

const BASE = "http://api.test:4000";
/** A well-formed client mark; the factories reject a malformed one. */
const TEST_SIGNATURE = "demli-test/1";

function response(body: unknown, status: number): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed: { code?: number } | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(): void {}
  close(code?: number): void {
    this.closed = { code };
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("readClientUpdateRequired — HTTP", () => {
  it("recognises the status even when the body is missing or unparsed", () => {
    expect(
      readClientUpdateRequired({ code: "INTERNAL", status: CLIENT_UPDATE_REQUIRED_STATUS }),
    ).toEqual({ source: "http", downloadUrl: null });
  });

  it("recognises the code even when a proxy rewrote the status", () => {
    expect(readClientUpdateRequired({ code: CLIENT_UPDATE_REQUIRED_CODE, status: 502 })).toEqual({
      source: "http",
      downloadUrl: null,
    });
  });

  it("ignores every other error", () => {
    expect(readClientUpdateRequired({ code: "UNAUTHORIZED", status: 401 })).toBeNull();
    expect(readClientUpdateRequired(new Error("boom"))).toBeNull();
    expect(readClientUpdateRequired(null)).toBeNull();
    expect(readClientUpdateRequired("426")).toBeNull();
  });

  it("reads the download address from BOTH accepted body shapes", () => {
    expect(readClientUpdateDownloadUrl({ downloadUrl: "https://getdemli.com" })).toBe(
      "https://getdemli.com",
    );
    expect(
      readClientUpdateDownloadUrl({ error: { code: "X", downloadUrl: "https://getdemli.com/x" } }),
    ).toBe("https://getdemli.com/x");
  });

  it("refuses a download address that is not absolute https", () => {
    // It comes off the wire and ends up in "open this outside the app".
    for (const value of [
      "javascript:alert(1)",
      "http://getdemli.com",
      "//getdemli.com",
      "/download/windows",
      "",
      42,
    ]) {
      expect(readClientUpdateDownloadUrl({ downloadUrl: value })).toBeNull();
    }
  });
});

describe("readClientUpdateRequiredClose — websocket", () => {
  it("recognises 4426 and nothing else", () => {
    expect(readClientUpdateRequiredClose(CLIENT_UPDATE_REQUIRED_CLOSE_CODE)).toEqual({
      source: "websocket",
      downloadUrl: null,
    });
    expect(readClientUpdateRequiredClose(4401)).toBeNull();
    expect(readClientUpdateRequiredClose(1006)).toBeNull();
    expect(readClientUpdateRequiredClose(undefined)).toBeNull();
  });
});

describe("the api client reports a refusal", () => {
  it("throws CLIENT_UPDATE_REQUIRED and calls the hook on a 426", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response(
          { error: CLIENT_UPDATE_REQUIRED_CODE, downloadUrl: "https://getdemli.com/download/windows" },
          CLIENT_UPDATE_REQUIRED_STATUS,
        ),
      ),
    );
    const seen: unknown[] = [];
    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE, onClientUpdateRequired: (i) => seen.push(i) });

    await expect(api.listGroups()).rejects.toMatchObject({
      code: CLIENT_UPDATE_REQUIRED_CODE,
      status: CLIENT_UPDATE_REQUIRED_STATUS,
    });
    expect(seen).toEqual([
      { source: "http", downloadUrl: "https://getdemli.com/download/windows" },
    ]);
  });

  it("still reports when the gate answers with no usable body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: CLIENT_UPDATE_REQUIRED_STATUS,
        ok: false,
        json: async () => {
          throw new Error("not json");
        },
      })) as unknown as typeof fetch,
    );
    const seen: unknown[] = [];
    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE, onClientUpdateRequired: (i) => seen.push(i) });

    await expect(api.listGroups()).rejects.toMatchObject({
      code: CLIENT_UPDATE_REQUIRED_CODE,
    });
    expect(seen).toEqual([{ source: "http", downloadUrl: null }]);
  });

  it("leaves ordinary errors alone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ error: { code: "UNAUTHORIZED", message: "no" } }, 401)),
    );
    const onClientUpdateRequired = vi.fn();
    const { api } = createApiClient({ baseUrl: BASE, clientSignature: TEST_SIGNATURE, onClientUpdateRequired });

    await expect(api.listGroups()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(onClientUpdateRequired).not.toHaveBeenCalled();
  });
});

describe("the realtime client reports a refusal", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  function connected(): { handlers: RealtimeHandlers; socket: FakeWebSocket } {
    const handlers: RealtimeHandlers = {
      onEvent: vi.fn(),
      onStatus: vi.fn(),
      onGap: vi.fn(),
      onAuthExpired: vi.fn(),
      onClientUpdateRequired: vi.fn(),
    };
    const client = new RealtimeClient({ realtimeUrl: "ws://gw.test:4001", clientSignature: TEST_SIGNATURE }, handlers);
    client.connect("token-1");
    return { handlers, socket: FakeWebSocket.instances[0]! };
  }

  it("hands 4426 to the handler and stops reconnecting", () => {
    vi.useFakeTimers();
    const { handlers, socket } = connected();

    socket.onclose?.({ code: CLIENT_UPDATE_REQUIRED_CLOSE_CODE });

    expect(handlers.onClientUpdateRequired).toHaveBeenCalledWith({
      source: "websocket",
      downloadUrl: null,
    });
    expect(handlers.onAuthExpired).not.toHaveBeenCalled();
    // A retired build is refused on every future handshake — retrying is noise.
    vi.advanceTimersByTime(120_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("keeps reconnecting on an ordinary close", () => {
    vi.useFakeTimers();
    const { handlers, socket } = connected();

    socket.onclose?.({ code: 1006 });
    expect(handlers.onClientUpdateRequired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(120_000);
    expect(FakeWebSocket.instances.length).toBeGreaterThan(1);
  });
});

describe("the gate latch", () => {
  it("stays set and notifies subscribers once", () => {
    const gate = createClientGate();
    const seen: unknown[] = [];
    gate.subscribe((info) => seen.push(info));

    expect(gate.get()).toBeNull();
    gate.report({ source: "websocket", downloadUrl: null });
    gate.report({ source: "http", downloadUrl: null });

    expect(gate.get()).toEqual({ source: "websocket", downloadUrl: null });
    expect(seen).toHaveLength(1);
  });

  it("upgrades a latched refusal with a download address it did not have", () => {
    const gate = createClientGate();
    gate.report({ source: "websocket", downloadUrl: null });
    gate.report({ source: "http", downloadUrl: "https://getdemli.com" });

    expect(gate.get()).toEqual({ source: "websocket", downloadUrl: "https://getdemli.com" });
  });

  it("unsubscribes cleanly", () => {
    const gate = createClientGate();
    const listener = vi.fn();
    gate.subscribe(listener)();
    gate.report({ source: "http", downloadUrl: null });
    expect(listener).not.toHaveBeenCalled();
  });
});
