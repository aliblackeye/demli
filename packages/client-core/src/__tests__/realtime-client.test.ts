import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeEnvelope, serverEvent, type ServerToClientEvent } from "@demli/protocol";
import type { UserId } from "@demli/types";
import {
  RealtimeClient,
  type RealtimeHandlers,
  type RealtimeStatus,
} from "../realtime-client.js";

/**
 * Minimal WebSocket stand-in. Each instance registers itself so the test can
 * drive `onmessage`/`onclose` as if frames arrived from the gateway.
 */
class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.OPEN;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }

  /** Deliver a raw frame to the client. */
  emit(data: unknown): void {
    this.onmessage?.({ data });
  }
}

/** A well-formed client mark; the constructor rejects a malformed one. */
const TEST_SIGNATURE = "demli-test/1";

function presenceEnvelope(seq: number): string {
  const event = serverEvent.presenceUpdated({ userId: "u1" as UserId, status: "online" });
  return JSON.stringify(makeEnvelope(event, seq));
}

function makeClient() {
  const statuses: RealtimeStatus[] = [];
  const events: ServerToClientEvent[] = [];
  const handlers: RealtimeHandlers = {
    onEvent: (e) => events.push(e),
    onStatus: (s) => statuses.push(s),
    onGap: vi.fn(),
    onAuthExpired: vi.fn(),
  };
  const client = new RealtimeClient({ realtimeUrl: "ws://gw.test:4001", clientSignature: TEST_SIGNATURE }, handlers);
  return { client, handlers, statuses, events };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("RealtimeClient — handshake + connection", () => {
  it("opens the socket with the injected url and token query param", () => {
    const { client } = makeClient();
    client.connect("sess-token");

    const socket = FakeWebSocket.instances[0]!;
    expect(socket.url).toBe(
      "ws://gw.test:4001/?token=sess-token&client=demli-test%2F1",
    );
  });

  it("appends the platform query param when configured (task #47)", () => {
    const client = new RealtimeClient(
      { realtimeUrl: "ws://gw.test:4001", platform: "mobile", clientSignature: TEST_SIGNATURE },
      {
        onEvent: vi.fn(),
        onStatus: vi.fn(),
        onGap: vi.fn(),
        onAuthExpired: vi.fn(),
      },
    );
    client.connect("sess-token");

    const socket = FakeWebSocket.instances[0]!;
    expect(socket.url).toBe(
      "ws://gw.test:4001/?token=sess-token&platform=mobile&client=demli-test%2F1",
    );
  });

  it("omits the platform param entirely when not configured", () => {
    const { client } = makeClient();
    client.connect("sess-token");

    const socket = FakeWebSocket.instances[0]!;
    // `client` is NOT optional the way `platform` is — see client-signature.test.ts.
    expect(socket.url).toBe("ws://gw.test:4001/?token=sess-token&client=demli-test%2F1");
    expect(socket.url).not.toContain("platform");
  });

  it("goes connecting → online and dispatches the first valid envelope", () => {
    const { client, statuses, events } = makeClient();
    client.connect("t");
    expect(statuses).toEqual(["connecting"]);
    expect(client.getStatus()).toBe("connecting");

    FakeWebSocket.instances[0]!.emit(presenceEnvelope(1));

    expect(client.getStatus()).toBe("online");
    expect(statuses).toEqual(["connecting", "online"]);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("presence.updated");
  });
});

describe("RealtimeClient — envelope validation + seq gap", () => {
  it("drops an invalid envelope without dispatching", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { client, events } = makeClient();
    client.connect("t");

    FakeWebSocket.instances[0]!.emit(JSON.stringify({ not: "an envelope" }));
    FakeWebSocket.instances[0]!.emit("this is not even json {");

    expect(events).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });

  it("calls onGap when the seq is non-contiguous", () => {
    const { client, handlers } = makeClient();
    client.connect("t");
    const socket = FakeWebSocket.instances[0]!;

    socket.emit(presenceEnvelope(1)); // establishes lastSeq = 1
    expect(handlers.onGap).not.toHaveBeenCalled();

    socket.emit(presenceEnvelope(3)); // skipped 2 → gap
    expect(handlers.onGap).toHaveBeenCalledTimes(1);
  });

  it("does not flag a gap on contiguous sequences", () => {
    const { client, handlers } = makeClient();
    client.connect("t");
    const socket = FakeWebSocket.instances[0]!;

    socket.emit(presenceEnvelope(1));
    socket.emit(presenceEnvelope(2));
    socket.emit(presenceEnvelope(3));

    expect(handlers.onGap).not.toHaveBeenCalled();
  });
});

describe("RealtimeClient — reconnect backoff + jitter", () => {
  /**
   * Capture every scheduled reconnect delay without letting real timers run, and
   * expose the callbacks so a test can drive attempt N+1 by hand.
   */
  function captureSchedule() {
    const scheduled: Array<{ ms: number; fn: () => void }> = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      scheduled.push({ ms: ms ?? 0, fn });
      return scheduled.length as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);
    return scheduled;
  }

  /** Delays for the first `attempts` reconnects, with Math.random pinned. */
  function delaysWithRandom(random: number, attempts: number): number[] {
    vi.spyOn(Math, "random").mockReturnValue(random);
    const scheduled = captureSchedule();
    const { client } = makeClient();
    client.connect("t");

    for (let i = 0; i < attempts; i++) {
      FakeWebSocket.instances[i]!.onclose?.({ code: 1006 });
      scheduled[i]!.fn(); // runs openSocket → creates the next FakeWebSocket
    }
    return scheduled.map((s) => s.ms);
  }

  it("keeps the first retry fast so a blip heals immediately", () => {
    // Attempt 0 must stay in [1.0, 1.5) s — unchanged from before the widening.
    expect(delaysWithRandom(0, 1)[0]).toBe(1_000);
    vi.restoreAllMocks();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    FakeWebSocket.instances = [];
    expect(delaysWithRandom(0.999_999, 1)[0]).toBeLessThan(1_500);
  });

  it("grows the backoff exponentially and caps it at 30 s", () => {
    // Zero jitter isolates the backoff curve itself.
    expect(delaysWithRandom(0, 8)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
  });

  it("widens the jitter window on later attempts, capped at 5 s", () => {
    const low = delaysWithRandom(0, 8);
    vi.restoreAllMocks();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    FakeWebSocket.instances = [];
    const high = delaysWithRandom(0.999_999, 8);

    const windows = high.map((ms, i) => ms - low[i]!);
    // Attempt 0 keeps the original narrow spread; later attempts — the ones a
    // whole fleet hits simultaneously after a restart — spread over seconds.
    expect(windows[0]).toBeGreaterThan(499);
    expect(windows[0]).toBeLessThanOrEqual(500);
    expect(windows[1]).toBeGreaterThan(999);
    expect(windows[2]).toBeGreaterThan(1_999);
    expect(windows[3]).toBeGreaterThan(3_999);
    // From attempt 4 on, the window sits at its 5 s ceiling and never exceeds it.
    for (const window of windows.slice(4)) {
      expect(window).toBeGreaterThan(4_999);
      expect(window).toBeLessThanOrEqual(5_000);
    }
  });

  it("never schedules beyond the backoff cap plus the jitter ceiling", () => {
    for (const ms of delaysWithRandom(0.999_999, 10)) {
      expect(ms).toBeLessThanOrEqual(35_000);
    }
  });

  it("resets to the fast first retry once a frame arrives", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const scheduled = captureSchedule();
    const { client } = makeClient();
    client.connect("t");

    // Fail three times: the next delay would be 8 s.
    for (let i = 0; i < 3; i++) {
      FakeWebSocket.instances[i]!.onclose?.({ code: 1006 });
      scheduled[i]!.fn();
    }
    expect(scheduled[2]!.ms).toBe(4_000);

    // A successful handshake clears the attempt counter, so the NEXT drop is
    // back to the snappy first retry rather than inheriting the long backoff.
    FakeWebSocket.instances[3]!.emit(presenceEnvelope(1));
    FakeWebSocket.instances[3]!.onclose?.({ code: 1006 });
    expect(scheduled[3]!.ms).toBe(1_000);
  });
});

describe("RealtimeClient — auth expiry", () => {
  it("reports onAuthExpired and returns to idle on the 4401 close code", () => {
    const { client, handlers } = makeClient();
    client.connect("t");

    FakeWebSocket.instances[0]!.onclose?.({ code: 4401 });

    expect(handlers.onAuthExpired).toHaveBeenCalledTimes(1);
    expect(client.getStatus()).toBe("idle");
  });

  it("does not fire onAuthExpired after an intentional disconnect", () => {
    const { client, handlers } = makeClient();
    client.connect("t");
    const socket = FakeWebSocket.instances[0]!;

    client.disconnect();
    // A late close for the intentionally-closed socket must be ignored.
    socket.onclose?.({ code: 1000 });

    expect(handlers.onAuthExpired).not.toHaveBeenCalled();
    expect(client.getStatus()).toBe("idle");
  });
});
