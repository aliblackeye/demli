/**
 * "A DM call is a ROOM" — the SERVER half (ADR 0023 W1), end-to-end.
 *
 * Real Postgres, the real WS gateway, the real HTTP API, real sockets. Only the
 * SFU is a fake: `callLiveness` is injected so the test can say exactly who the
 * media plane holds, which is the one thing that cannot be arranged without a
 * live LiveKit. Skipped (with a notice) when the database is down, like every
 * other integration suite here.
 *
 * Two server behaviors are pinned, and both exist because of the SAME shape of
 * bug — a user is signed in on more than one device, and the server tells only
 * one of them what happened:
 *
 * ## 1. `inRoom` — the auto-join gate
 *
 * `call.accepted` now reaches the answering user's OTHER devices too (so the
 * desktop stops ringing at a call the phone already took). Those devices then
 * resync, and before this field existed the resync answer was indistinguishable
 * from "you should be in this room" — so the desktop joined it, WITH THE SAME
 * LIVEKIT IDENTITY, and LiveKit's one-connection-per-identity rule disconnected
 * the phone the user was talking on.
 *
 * `GET /dm-calls/active` therefore reports whether this account's identity is
 * already in the room, read from the media plane. It has THREE values, and the
 * third is the point: an unreachable SFU answers `null`, never `false`, because
 * a wrong `false` kicks a device out of a live call while a wrong `null` costs
 * one button press.
 *
 * ## 2. `call.ended` reaches BOTH participants' every session
 *
 * The terminal used to go only to the OTHER side. Under the seat model the
 * actor's own other devices are showing an "in a call elsewhere" band, and with
 * no terminal of their own that band hangs there until the next resync.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  applyMigrations,
  createDb,
  createRepositories,
  generateSessionToken,
  hashSessionToken,
  InMemoryMutationBus,
  sessionExpiresAt,
  type DbClient,
  type Repositories,
} from "@demli/db";
import { buildApp } from "@demli/api/app";
import { loadEnv } from "@demli/api/env";
import { SERVER_EVENT, type DmCallActiveResponse } from "@demli/protocol";
import { createGateway, type Gateway } from "../gateway.js";
import { InMemoryPresenceStore } from "../presence.js";
import { DATABASE_URL, isDbUp, TestClient } from "./harness.js";
import { refuseToSkipIfRequired } from "@demli/db/testing";

interface Actor {
  id: string;
  token: string;
  /** A SECOND session for the same account — the two-device case. */
  secondToken: string;
}

/**
 * The injectable media plane. `rooms`/`participants` are set by each test;
 * `fail` makes both throw, which is how an unreachable SFU is modeled (the real
 * reader propagates its errors for exactly this reason).
 */
class FakeLiveness {
  occupants = new Map<string, string[]>();
  fail = false;

  async rooms(): Promise<Map<string, number>> {
    if (this.fail) throw new Error("livekit unreachable");
    const counts = new Map<string, number>();
    for (const [room, ids] of this.occupants) counts.set(room, ids.length);
    return counts;
  }

  async participants(roomName: string): Promise<string[]> {
    if (this.fail) throw new Error("livekit unreachable");
    return this.occupants.get(roomName) ?? [];
  }
}

const dbUp = await isDbUp();
if (!dbUp) {
  refuseToSkipIfRequired("postgres");
  console.warn("[dm-call-room-model.int.test] DATABASE unreachable — skipping");
}

describe.skipIf(!dbUp)("DM call as a room: inRoom + terminal fan-out", () => {
  let client: DbClient;
  let repos: Repositories;
  let gateway: Gateway;
  let app: FastifyInstance;
  let port: number;
  const liveness = new FakeLiveness();

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async function makeActor(label: string): Promise<Actor> {
    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const user = await repos.users.create({
      username: `${label}_${suffix}`,
      displayName: label,
      passwordHash: "not-used-in-this-test",
    });
    const tokens: string[] = [];
    for (let i = 0; i < 2; i++) {
      const token = generateSessionToken();
      await repos.sessions.create({
        userId: user.id,
        tokenHash: hashSessionToken(token),
        expiresAt: sessionExpiresAt(new Date(), 1),
      });
      tokens.push(token);
    }
    return { id: user.id, token: tokens[0] as string, secondToken: tokens[1] as string };
  }

  /** Mutual friends + an open DM — the gate every call endpoint re-checks. */
  async function befriendAndOpenDm(a: Actor, b: Actor): Promise<string> {
    await app.inject({
      method: "POST",
      url: "/friends/requests",
      headers: auth(a.token),
      payload: { userId: b.id },
    });
    await app.inject({
      method: "POST",
      url: `/friends/requests/${a.id}/accept`,
      headers: auth(b.token),
    });
    const dmRes = await app.inject({
      method: "POST",
      url: "/dms",
      headers: auth(a.token),
      payload: { userId: b.id },
    });
    return (dmRes.json() as { dm: { id: string } }).dm.id;
  }

  /** Start + accept a call, leaving the row `active`. Returns its id. */
  async function liveCall(caller: Actor, callee: Actor, dmId: string): Promise<string> {
    const started = await app.inject({
      method: "POST",
      url: "/dm-calls",
      headers: auth(caller.token),
      payload: { dmId, media: "audio" },
    });
    expect(started.statusCode).toBe(201);
    const callId = (started.json() as { call: { id: string } }).call.id;
    const accepted = await app.inject({
      method: "POST",
      url: `/dm-calls/${callId}/accept`,
      headers: auth(callee.token),
    });
    expect(accepted.statusCode).toBe(200);
    return callId;
  }

  async function resync(token: string): Promise<DmCallActiveResponse> {
    const res = await app.inject({
      method: "GET",
      url: "/dm-calls/active",
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    return res.json() as DmCallActiveResponse;
  }

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);

    const bus = new InMemoryMutationBus();
    gateway = createGateway(
      { repos, presence: new InMemoryPresenceStore(), mutationBus: bus },
      { port: 0 },
    );
    port = await gateway.ready;

    app = await buildApp({
      repos,
      env: loadEnv({ DATABASE_URL }),
      mutationBus: bus,
      logger: false,
      // The one seam that cannot be real here: no SFU runs in this suite.
      callLiveness: liveness,
    });
  });

  afterAll(async () => {
    await app?.close();
    await gateway?.close();
    await client?.close();
  });

  it("reports the seat honestly: held, free, and unknown", async () => {
    const caller = await makeActor("seatCaller");
    const callee = await makeActor("seatCallee");
    const dmId = await befriendAndOpenDm(caller, callee);
    const callId = await liveCall(caller, callee, dmId);
    const room = `dmcall:${callId}`;

    // ── HELD: both are genuinely in the room. The callee's SECOND device asks
    //    and is told the account is already seated — which is what stops it from
    //    joining and disconnecting the device that answered.
    liveness.occupants.set(room, [caller.id, callee.id]);
    const held = await resync(callee.secondToken);
    expect(held.call?.id).toBe(callId);
    expect(held.side).toBe("callee");
    expect(held.inRoom).toBe(true);
    // It is still handed credentials: taking the seat over is a legal, deliberate
    // action — the gate is about what happens WITHOUT the user asking.
    expect(held.media?.roomName).toBe(room);

    // ── FREE: the caller's media died and it is not in the room any more. The
    //    honest answer is `false`, which is what re-licenses the media repair
    //    path (K2.3) — this must not be conflated with "unknown".
    liveness.occupants.set(room, [callee.id]);
    expect((await resync(caller.token)).inRoom).toBe(false);

    // ── The SFU dropped the room entirely (it does that the moment it empties).
    //    A missing room is empty, not unreadable: reading occupancy from the room
    //    LIST is what keeps this `false` instead of an error.
    liveness.occupants.delete(room);
    expect((await resync(caller.token)).inRoom).toBe(false);

    // ── UNKNOWN: the media plane is unreachable. NOT `false` — a wrong `false`
    //    tells a device it is safe to join and kicks whoever is actually talking.
    liveness.fail = true;
    expect((await resync(caller.token)).inRoom).toBeNull();
    liveness.fail = false;

    await app.inject({
      method: "POST",
      url: `/dm-calls/${callId}/hangup`,
      headers: auth(caller.token),
    });
  });

  it("sends the ringing callee no seat reading at all", async () => {
    const caller = await makeActor("ringCaller");
    const callee = await makeActor("ringCallee");
    const dmId = await befriendAndOpenDm(caller, callee);

    const started = await app.inject({
      method: "POST",
      url: "/dm-calls",
      headers: auth(caller.token),
      payload: { dmId, media: "audio" },
    });
    const callId = (started.json() as { call: { id: string } }).call.id;
    liveness.occupants.set(`dmcall:${callId}`, [caller.id]);

    const ringing = await resync(callee.token);
    // A ringing callee has no grant and no seat — /accept is the only way in, so
    // there is nothing for a reading to gate and nothing is probed.
    expect(ringing.call?.status).toBe("ringing");
    expect(ringing.media).toBeNull();
    expect(ringing.inRoom).toBeNull();

    // …while the caller, who joined its own room at start, gets a real answer.
    expect((await resync(caller.token)).inRoom).toBe(true);

    await app.inject({
      method: "POST",
      url: `/dm-calls/${callId}/cancel`,
      headers: auth(caller.token),
    });
    liveness.occupants.clear();
  });

  it("delivers call.ended to BOTH participants' every session on hangup", async () => {
    const caller = await makeActor("endCaller");
    const callee = await makeActor("endCallee");
    const dmId = await befriendAndOpenDm(caller, callee);
    const callId = await liveCall(caller, callee, dmId);

    // Four real sockets: two devices each.
    const sockets = await Promise.all([
      TestClient.connect(port, caller.token),
      TestClient.connect(port, caller.secondToken),
      TestClient.connect(port, callee.token),
      TestClient.connect(port, callee.secondToken),
    ]);
    await Promise.all(sockets.map((s) => s.waitFor(SERVER_EVENT.authSucceeded)));

    const hangup = await app.inject({
      method: "POST",
      url: `/dm-calls/${callId}/hangup`,
      headers: auth(caller.token),
    });
    expect(hangup.statusCode).toBe(200);

    // Including the hanging-up device's OWN other session: it is the one holding
    // an "in a call elsewhere" band, and this is what clears it.
    for (const socket of sockets) {
      const ended = await socket.waitFor(
        SERVER_EVENT.callEnded,
        (event) => event.payload.callId === callId,
      );
      expect(ended.payload.reason).toBe("hung_up");
    }
    for (const socket of sockets) socket.close();
  });

  it("delivers call.ended to every session on decline and on cancel too", async () => {
    const caller = await makeActor("termCaller");
    const callee = await makeActor("termCallee");
    const dmId = await befriendAndOpenDm(caller, callee);

    const sockets = await Promise.all([
      TestClient.connect(port, caller.token),
      TestClient.connect(port, caller.secondToken),
      TestClient.connect(port, callee.token),
      TestClient.connect(port, callee.secondToken),
    ]);
    await Promise.all(sockets.map((s) => s.waitFor(SERVER_EVENT.authSucceeded)));

    // DECLINE — the decliner's other device is ringing too; only a fan-out
    // terminal silences it.
    const first = await app.inject({
      method: "POST",
      url: "/dm-calls",
      headers: auth(caller.token),
      payload: { dmId, media: "audio" },
    });
    const declinedId = (first.json() as { call: { id: string } }).call.id;
    await app.inject({
      method: "POST",
      url: `/dm-calls/${declinedId}/reject`,
      headers: auth(callee.token),
    });
    for (const socket of sockets) {
      const ended = await socket.waitFor(
        SERVER_EVENT.callEnded,
        (event) => event.payload.callId === declinedId,
      );
      expect(ended.payload.reason).toBe("declined");
    }

    // CANCEL — the mirror: the caller's other device shows an outgoing ring it
    // did not place, and this retracts it. The per-DM start cooldown only counts
    // the SAME caller, so the callee places this one.
    const second = await app.inject({
      method: "POST",
      url: "/dm-calls",
      headers: auth(callee.token),
      payload: { dmId, media: "audio" },
    });
    expect(second.statusCode).toBe(201);
    const canceledId = (second.json() as { call: { id: string } }).call.id;
    await app.inject({
      method: "POST",
      url: `/dm-calls/${canceledId}/cancel`,
      headers: auth(callee.token),
    });
    for (const socket of sockets) {
      const ended = await socket.waitFor(
        SERVER_EVENT.callEnded,
        (event) => event.payload.callId === canceledId,
      );
      expect(ended.payload.reason).toBe("canceled");
    }

    for (const socket of sockets) socket.close();
  });
});
