/**
 * REAL-NETWORK test for the call resync path (call-UX plan K2.2).
 *
 * Everything on the wire here is genuine: a real `node:http` server answering
 * `GET /dm-calls/active` and `POST /dm-calls`, a real `ws` gateway pushing real
 * zod-validated envelopes, the real {@link createApiClient} (global `fetch`) and
 * the real {@link RealtimeClient} (global `WebSocket`) in front of the real call
 * controller. Only the LiveKit engine is a fake — there is no SFU in unit tests.
 *
 * WHY, and not just seam-mocks: the repo has already been bitten by a guard that
 * passed against a mocked seam and failed on a real socket (the unfurl
 * Node-lookup case). This fix's load-bearing new behavior is a NETWORK call made
 * from an event handler — wrong path, missing Authorization header, a JSON shape
 * the client cannot read, or an unhandled rejection inside the handler would all
 * be invisible to a mocked api and fatal in production, where the only symptom
 * the founder sees is "kabul etti ama bağlanmadı".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { makeEnvelope, serverEvent } from "@demli/protocol";
import type { DmCall, User, UserId } from "@demli/types";
import { createApiClient } from "../api-client.js";
import { RealtimeClient } from "../realtime-client.js";
import { createCallController, type CallVoiceEngine } from "../dm-calls/index.js";

const SESSION_TOKEN = "session-token-abc";
const LIVEKIT_URL = "ws://livekit.test";
const CALL_TOKEN = "livekit-jwt-for-me";

function user(id: string): User {
  return {
    id,
    username: id,
    displayName: id,
    avatarUrl: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function dmCall(overrides: Partial<DmCall> = {}): DmCall {
  return {
    id: "call-1",
    dmId: "dm-1",
    roomName: "dmcall:call-1",
    callerId: "me",
    calleeId: "friend",
    media: "audio",
    status: "ringing",
    upgradedToGroupId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    // A LIVE ring window relative to the real clock: these tests run on real
    // timers, and a fixture deadline in the past would let the caller's ring
    // timeout fire first and end the call before the resync it is testing.
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    startedAt: null,
    endedAt: null,
    ...overrides,
  };
}

/** One recorded HTTP request, so the test can assert the REAL wire call. */
interface Recorded {
  method: string;
  url: string;
  authorization: string | undefined;
}

interface Harness {
  apiBaseUrl: string;
  realtimeUrl: string;
  requests: Recorded[];
  /** What `GET /dm-calls/active` currently answers. */
  setActiveCall(body: unknown): void;
  /** Delay (ms) before `POST /dm-calls` answers — models the push round-trip. */
  setStartDelayMs(ms: number): void;
  /** Push an event to every connected gateway socket, as a real envelope frame. */
  push(event: Parameters<typeof makeEnvelope>[0]): void;
  /** Drop every gateway socket (a gateway restart / network blip). */
  dropSockets(): void;
  /** Sockets that have connected so far (each handshake pushes auth.succeeded). */
  connectionCount(): number;
  close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const requests: Recorded[] = [];
  let activeBody: unknown = { call: null };
  let startDelayMs = 0;

  const http: HttpServer = createServer((req, res) => {
    requests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      authorization: req.headers.authorization,
    });
    const respond = (status: number, body: unknown): void => {
      const json = JSON.stringify(body);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(json);
    };
    if (req.headers.authorization !== `Bearer ${SESSION_TOKEN}`) {
      respond(401, { error: { code: "UNAUTHORIZED", message: "no" } });
      return;
    }
    if (req.method === "GET" && req.url === "/dm-calls/active") {
      respond(200, activeBody);
      return;
    }
    if (req.method === "POST" && req.url === "/dm-calls") {
      // Consume the body, then answer after the configured delay — the real API
      // awaits an Expo push round-trip before its 201, which is what opens the
      // race this file is about.
      req.resume();
      setTimeout(() => {
        respond(201, {
          call: dmCall(),
          peer: null,
          side: null,
          media: {
            url: LIVEKIT_URL,
            token: CALL_TOKEN,
            roomName: "dmcall:call-1",
            identity: "me",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
          roomName: "dmcall:call-1",
          identity: "me",
          expiresAt: "2026-06-01T00:00:00.000Z",
        });
      }, startDelayMs);
      return;
    }
    if (req.method === "POST" && req.url === "/dm-calls/call-1/hangup") {
      req.resume();
      respond(200, { call: dmCall({ status: "ended" }) });
      return;
    }
    respond(404, { error: { code: "NOT_FOUND", message: "no route" } });
  });

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const httpPort = (http.address() as AddressInfo).port;

  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const sockets = new Set<WsSocket>();
  let seq = 0;
  let connections = 0;
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const wsPort = (wss.address() as AddressInfo).port;

  wss.on("connection", (socket, req) => {
    // The gateway contract: session token as a `token` query param.
    if (!req.url?.includes(`token=${SESSION_TOKEN}`)) {
      socket.close(4401, "unauthorized");
      return;
    }
    connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    seq += 1;
    socket.send(
      JSON.stringify(
        makeEnvelope(
          serverEvent.authSucceeded({ userId: "me" as UserId, presence: [] }),
          seq,
        ),
      ),
    );
  });

  return {
    apiBaseUrl: `http://127.0.0.1:${httpPort}`,
    realtimeUrl: `ws://127.0.0.1:${wsPort}`,
    requests,
    setActiveCall(body) {
      activeBody = body;
    },
    setStartDelayMs(ms) {
      startDelayMs = ms;
    },
    push(event) {
      seq += 1;
      const frame = JSON.stringify(makeEnvelope(event, seq));
      for (const socket of sockets) socket.send(frame);
    },
    dropSockets() {
      for (const socket of sockets) socket.terminate();
      sockets.clear();
    },
    connectionCount: () => connections,
    async close() {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

/** Wait until `predicate` holds, polling the real event loop (no fake timers). */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness();
});

afterEach(async () => {
  await harness.close();
});

/**
 * Wire the real transports to the real controller, the way the desktop glue does
 * (`realtime/connection.ts`): every server event is fed to the controller, and a
 * RECONNECT handshake triggers a call resync.
 */
/** A well-formed client mark; the factories reject a malformed one. */
const TEST_SIGNATURE = "demli-test/1";

function wireClient() {
  const joinedRooms = new Set<string>();
  const joins: { room: string; credential?: { url: string; token: string } }[] = [];
  const engine = {
    join: vi.fn(async (room: string, credential?: { url: string; token: string }) => {
      joins.push({ room, credential });
      joinedRooms.add(room);
    }),
    leave: vi.fn(async () => {
      joinedRooms.clear();
    }),
    isConnectedTo: (room: string) => joinedRooms.has(room),
  } satisfies CallVoiceEngine;

  const client = createApiClient({ baseUrl: harness.apiBaseUrl, clientSignature: TEST_SIGNATURE });
  client.setAuthToken(SESSION_TOKEN);

  const controller = createCallController({
    api: client.api,
    engine,
    currentUserId: "me" as UserId,
  });

  let handshakes = 0;
  const realtime = new RealtimeClient(
    { realtimeUrl: harness.realtimeUrl, clientSignature: TEST_SIGNATURE },
    {
      onEvent: (event) => {
        if (event.type === "auth.succeeded") {
          handshakes += 1;
          // Desktop parity: only a RE-connect resyncs (a first handshake must not
          // drag the user into a call left over from a previous process).
          if (handshakes > 1) void controller.resyncActiveCall("reconnect");
          return;
        }
        controller.applyServerEvent(event);
      },
      onStatus: () => undefined,
      onGap: () => undefined,
      onAuthExpired: () => undefined,
    },
  );
  realtime.connect(SESSION_TOKEN);

  return { controller, engine, joins, realtime, handshakeCount: () => handshakes };
}

describe("call resync over a real socket + real HTTP", () => {
  it("connects the caller when the accept frame arrives BEFORE the start response", async () => {
    // The server holds `POST /dm-calls` (its push round-trip) so the accept can
    // overtake it — production's exact ordering.
    harness.setStartDelayMs(300);
    harness.setActiveCall({
      call: dmCall({ status: "active", startedAt: "2026-01-01T00:00:05.000Z" }),
      peer: null,
      side: null,
      media: {
        url: LIVEKIT_URL,
        token: CALL_TOKEN,
        roomName: "dmcall:call-1",
        identity: "me",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      // The media plane holds NOBODY of ours: this client's engine is a spy that
      // never reached LiveKit, so the seat is genuinely free and the resync is
      // allowed to take it (ADR 0023 §3).
      inRoom: false,
      roomName: "dmcall:call-1",
      identity: "me",
      expiresAt: "2026-06-01T00:00:00.000Z",
    });

    const client = wireClient();
    await waitFor(() => client.handshakeCount() === 1);

    const startPromise = client.controller.startCall({ dmId: "dm-1", media: "audio" });
    // The FSM has not reached `outgoing` yet — there is nothing to place an accept
    // against, which is exactly why the frame used to be dropped for good.
    expect(client.controller.getState().phase).toBe("idle");

    harness.push(
      serverEvent.callAccepted({
        callId: "call-1",
        target: { kind: "dm", dmId: "dm-1" },
        callee: user("friend"),
      }),
    );

    await waitFor(() => client.controller.getState().phase === "active");
    await startPromise;

    // Media came up with the grant the SERVER handed back over real HTTP.
    expect(client.joins).toEqual([
      { room: "dmcall:call-1", credential: { url: LIVEKIT_URL, token: CALL_TOKEN } },
    ]);
    // The late 201 must not re-open the ring on a live call.
    expect(client.controller.getState().phase).toBe("active");

    // The resync really went over the wire, on the documented path, authenticated.
    const resyncRequests = harness.requests.filter((r) => r.url === "/dm-calls/active");
    expect(resyncRequests).toHaveLength(1);
    expect(resyncRequests[0]).toMatchObject({
      method: "GET",
      authorization: `Bearer ${SESSION_TOKEN}`,
    });

    client.realtime.disconnect();
    client.controller.dispose();
  });

  it("recovers the call after a real socket drop + reconnect", async () => {
    harness.setStartDelayMs(0);
    const client = wireClient();
    await waitFor(() => client.handshakeCount() === 1);

    await client.controller.startCall({ dmId: "dm-1", media: "audio" });
    expect(client.controller.getState().phase).toBe("outgoing");
    // The media session dies with the network blip.
    await client.engine.leave();

    // The peer accepts while we are disconnected: no queue, no replay — that frame
    // is gone for good. Only the resync can recover it.
    harness.setActiveCall({
      call: dmCall({ status: "active", startedAt: "2026-01-01T00:00:05.000Z" }),
      peer: null,
      side: null,
      media: {
        url: LIVEKIT_URL,
        token: CALL_TOKEN,
        roomName: "dmcall:call-1",
        identity: "me",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      // The media plane holds NOBODY of ours: this client's engine is a spy that
      // never reached LiveKit, so the seat is genuinely free and the resync is
      // allowed to take it (ADR 0023 §3).
      inRoom: false,
      roomName: "dmcall:call-1",
      identity: "me",
      expiresAt: "2026-06-01T00:00:00.000Z",
    });
    harness.dropSockets();

    await waitFor(() => client.handshakeCount() === 2, 8_000);
    await waitFor(() => client.controller.getState().phase === "active", 8_000);
    expect(client.engine.join).toHaveBeenLastCalledWith("dmcall:call-1", {
      url: LIVEKIT_URL,
      token: CALL_TOKEN,
    });

    client.realtime.disconnect();
    client.controller.dispose();
  }, 20_000);

  /**
   * THE DUPLICATE-IDENTITY KICK (ADR 0023 §3), over a real socket + real HTTP.
   *
   * The scenario is a normal two-device account: the ring reaches BOTH devices,
   * the phone answers, and `call.accepted` is fanned out to the whole account —
   * including the desktop, which never touched the call. The desktop stops
   * ringing (good) and resyncs (good) and then, before this gate existed, adopted
   * the live row and called `engine.join` with THE SAME LIVEKIT IDENTITY. LiveKit
   * permits one connection per identity, so the phone the user was talking on was
   * disconnected by a desktop nobody had touched.
   *
   * The assertion is therefore about what must NOT happen on the wire: this
   * device sees the whole call, and joins nothing.
   */
  it("does NOT join when the media plane says the seat is held (duplicate-identity kick)", async () => {
    harness.setStartDelayMs(0);
    // This is the OTHER device: the account's identity is already in the room —
    // on the phone that pressed Accept — so `inRoom` is true for us too (a
    // LiveKit identity is per USER, not per device).
    harness.setActiveCall({
      call: dmCall({ status: "active", startedAt: "2026-01-01T00:00:05.000Z" }),
      peer: user("friend"),
      side: "callee",
      media: {
        url: LIVEKIT_URL,
        token: CALL_TOKEN,
        roomName: "dmcall:call-1",
        identity: "me",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      inRoom: true,
      roomName: "dmcall:call-1",
      identity: "me",
      expiresAt: "2026-06-01T00:00:00.000Z",
    });

    const client = wireClient();
    await waitFor(() => client.handshakeCount() === 1);

    // The ring reaches this device too (user-scoped fan-out).
    harness.push(
      serverEvent.callInvite({
        callId: "call-1",
        target: { kind: "dm", dmId: "dm-1" },
        caller: user("friend"),
        media: "audio",
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      }),
    );
    await waitFor(() => client.controller.getState().phase === "incoming");

    // …and so does the accept, because the OTHER device answered.
    harness.push(
      serverEvent.callAccepted({
        callId: "call-1",
        target: { kind: "dm", dmId: "dm-1" },
        callee: user("me"),
      }),
    );

    // It lands on the call — visible, not silent (the founder's "pcde aramada
    // olduğum gözükmüyor") — but with the seat attributed to the other device.
    await waitFor(() => client.controller.getState().seat === "elsewhere", 5_000);
    const state = client.controller.getState();
    expect(state.phase).toBe("active");
    expect(state.callId).toBe("call-1");
    // THE POINT: no LiveKit join, so the phone keeps its connection.
    expect(client.joins).toEqual([]);
    expect(client.engine.join).not.toHaveBeenCalled();
    // It did ask — the gate is driven by a real answer over the real wire, not by
    // skipping the resync.
    expect(harness.requests.filter((r) => r.url === "/dm-calls/active").length).toBeGreaterThan(0);

    // And the user can still take the call over deliberately: THAT is what is
    // allowed to evict the other device.
    await client.controller.joinHere();
    expect(client.controller.getState().seat).toBe("here");
    expect(client.joins).toEqual([
      { room: "dmcall:call-1", credential: { url: LIVEKIT_URL, token: CALL_TOKEN } },
    ]);

    client.realtime.disconnect();
    client.controller.dispose();
  }, 20_000);

  it("ends a stuck call cleanly when the server says nothing is live", async () => {
    harness.setStartDelayMs(0);
    const client = wireClient();
    await waitFor(() => client.handshakeCount() === 1);

    await client.controller.startCall({ dmId: "dm-1", media: "audio" });
    harness.setActiveCall({ call: null });
    harness.dropSockets();

    await waitFor(() => client.handshakeCount() === 2, 8_000);
    await waitFor(() => client.controller.getState().phase === "ended", 8_000);
    // Slot free again — no waiting out the server sweeper to call back. The outcome
    // is the non-alarming "call ended": the server has no live call for us, which is
    // not evidence that anything broke (§26).
    expect(client.controller.getState().endedReason).toBe("hung_up");

    client.realtime.disconnect();
    client.controller.dispose();
  }, 20_000);
});
