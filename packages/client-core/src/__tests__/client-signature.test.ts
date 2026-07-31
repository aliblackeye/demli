import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_SIGNATURE_HEADER,
  CLIENT_SIGNATURE_QUERY_PARAM,
  formatClientSignature,
  isValidClientSignature,
} from "@demli/config";
import { createApiClient } from "../api-client.js";
import { RealtimeClient, type RealtimeHandlers } from "../realtime-client.js";

/**
 * THE MARK MUST ACTUALLY GO OUT — on BOTH transports.
 *
 * The server's client gate tells a current build from a retired one purely by
 * the presence of this value (packages/config/src/client-gate.ts). Everything
 * else about the migration can be right and the product still goes dark for
 * every user the moment the gate is armed, if the clients do not send it.
 *
 * The gate's own unit tests prove the SERVER refuses an unmarked request. This
 * file proves the other half: that a real client emits one. Neither is worth
 * anything alone — a green gate suite over clients that send nothing is exactly
 * the "tests pass, product dead" shape.
 */

const BASE = "http://api.test:4000";
const SIGNATURE = "demli-desktop/0.0.81";

describe("formatClientSignature", () => {
  it("produces a mark the gate accepts, for every surface", () => {
    for (const app of ["desktop", "web", "mobile"] as const) {
      const mark = formatClientSignature(app, "2.0.0");
      expect(mark).toBe(`demli-${app}/2.0.0`);
      expect(isValidClientSignature(mark)).toBe(true);
    }
  });

  it("still produces a VALID mark when the version is unreadable", () => {
    // A surface that cannot read its own version must not end up unmarked —
    // the gate would refuse it as an old build. Degrading the version is
    // survivable; degrading the mark is not.
    for (const version of [undefined, null, "", "   ", 42, {}]) {
      const mark = formatClientSignature("mobile", version);
      expect(isValidClientSignature(mark), String(version)).toBe(true);
      expect(mark.startsWith("demli-mobile/")).toBe(true);
    }
  });

  it("never emits whitespace or an over-long tail the gate would reject", () => {
    expect(isValidClientSignature(formatClientSignature("web", "1.0 beta build"))).toBe(true);
    expect(isValidClientSignature(formatClientSignature("web", "v".repeat(500)))).toBe(true);
  });
});

describe("api client — REST mark", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function headersOf(call: number): Record<string, string> {
    return (fetchMock.mock.calls[call]?.[1] as { headers: Record<string, string> }).headers;
  }

  it("sends the mark on an AUTHENTICATED request", async () => {
    const { api, setAuthToken } = createApiClient({ baseUrl: BASE, clientSignature: SIGNATURE });
    setAuthToken("session-token");

    await api.listGroups();

    expect(headersOf(0)[CLIENT_SIGNATURE_HEADER]).toBe(SIGNATURE);
  });

  it("sends the mark on an UNAUTHENTICATED request too", async () => {
    // The gate runs AHEAD of auth on the server — an old build must not even be
    // able to log in. So login/register/version calls, which carry no bearer,
    // still have to carry the mark or they 426.
    const { api } = createApiClient({ baseUrl: BASE, clientSignature: SIGNATURE });

    await api.getMobileVersion();

    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers["Authorization"]).toBeUndefined();
    expect(init.headers[CLIENT_SIGNATURE_HEADER]).toBe(SIGNATURE);
    expect(url).toBe(`${BASE}/mobile/version`);
  });

  it("sends it on every request, not just the first", async () => {
    const { api } = createApiClient({ baseUrl: BASE, clientSignature: SIGNATURE });

    await api.listGroups();
    await api.listGroups();
    await api.listGroups();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 3; i += 1) {
      expect(headersOf(i)[CLIENT_SIGNATURE_HEADER], `call ${i}`).toBe(SIGNATURE);
    }
  });

  it("refuses to build a client with a mark the gate would reject", () => {
    // A malformed mark reads to the gate exactly like no mark at all, so it
    // must not be constructible — otherwise the build looks healthy everywhere
    // the gate is off and is dead the moment it is armed.
    for (const bad of ["", "   ", "demli-desktop", "other-desktop/1.0.0", "Demli-Desktop/1"]) {
      expect(
        () => createApiClient({ baseUrl: BASE, clientSignature: bad }),
        JSON.stringify(bad),
      ).toThrow(/clientSignature/);
    }
  });
});

describe("realtime client — websocket mark", () => {
  class FakeWebSocket {
    static readonly OPEN = 1;
    static instances: FakeWebSocket[] = [];
    readyState = FakeWebSocket.OPEN;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: ((ev: { code: number }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly url: string) {
      FakeWebSocket.instances.push(this);
    }
    send(): void {}
    close(): void {}
  }

  const handlers: RealtimeHandlers = {
    onEvent: vi.fn(),
    onStatus: vi.fn(),
    onGap: vi.fn(),
    onAuthExpired: vi.fn(),
  };

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("puts the mark in the handshake query string", () => {
    // A browser cannot set a custom header on a WS handshake, so the mark has
    // to ride the URL.
    const client = new RealtimeClient(
      { realtimeUrl: "ws://gw.test:4001", platform: "desktop", clientSignature: SIGNATURE },
      handlers,
    );
    client.connect("session-token");

    const url = new URL(FakeWebSocket.instances[0]!.url);
    expect(url.searchParams.get(CLIENT_SIGNATURE_QUERY_PARAM)).toBe(SIGNATURE);
    // The pre-existing params must survive the addition.
    expect(url.searchParams.get("token")).toBe("session-token");
    expect(url.searchParams.get("platform")).toBe("desktop");
  });

  it("keeps the mark on RECONNECT handshakes", () => {
    // The gateway re-checks every handshake. Dropping the mark on a retry would
    // retire a live build mid-session, and reconnects are the common case.
    const client = new RealtimeClient(
      { realtimeUrl: "ws://gw.test:4001", clientSignature: SIGNATURE },
      handlers,
    );
    client.connect("session-token");
    client.reconnectNow();

    expect(FakeWebSocket.instances).toHaveLength(2);
    for (const socket of FakeWebSocket.instances) {
      expect(new URL(socket.url).searchParams.get(CLIENT_SIGNATURE_QUERY_PARAM)).toBe(SIGNATURE);
    }
  });

  it("encodes the mark so the `/` cannot break the query string", () => {
    const client = new RealtimeClient(
      { realtimeUrl: "ws://gw.test:4001", clientSignature: SIGNATURE },
      handlers,
    );
    client.connect("session-token");

    expect(FakeWebSocket.instances[0]!.url).toContain("client=demli-desktop%2F0.0.81");
  });

  it("refuses to build a client with a mark the gate would reject", () => {
    for (const bad of ["", "demli-desktop", "other-desktop/1.0.0"]) {
      expect(
        () => new RealtimeClient({ realtimeUrl: "ws://gw.test:4001", clientSignature: bad }, handlers),
        JSON.stringify(bad),
      ).toThrow(/clientSignature/);
    }
  });
});
