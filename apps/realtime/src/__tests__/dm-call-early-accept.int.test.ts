/**
 * The founder's DM-call bug, reproduced end-to-end: "when I call someone
 * privately, sometimes the connection is never established even though they
 * accept — I have to leave the room and call them again."
 *
 * Real Postgres, the real WS gateway, the real HTTP API. Skipped (with a notice)
 * when the database is down, like every other integration suite here.
 *
 * ## What the race actually is
 *
 * The call control plane is two independent transports (ADR 0012 §4): the callee
 * is rung over its WebSocket, the caller learns its own call id from the
 * `POST /dm-calls` response. Nothing orders those two, so the callee can ACCEPT
 * before the caller's own response has landed — and in production it routinely
 * did, because the start handler used to `await` the Expo push before replying,
 * putting seconds of third-party latency in front of the caller's 201.
 *
 * The caller's FSM then received `call.accepted` for a call it did not know it
 * had, dropped it as out-of-phase, and the row sat `active` with nobody joining.
 * The periodic sweeper reaps that after 3-6 minutes, which is exactly why leaving
 * the room and calling again was the only escape.
 *
 * ## How the ordering is FORCED here (no sleeps, no luck)
 *
 * The API is given a mutation publisher that forwards every event to the real bus
 * and then HOLDS the `call.invite` publish open until the test releases it. Since
 * the start handler publishes the ring before it replies, this makes the sequence
 * deterministic:
 *
 *   1. the ring reaches the callee over a real socket,
 *   2. the callee accepts over real HTTP and gets its 200,
 *   3. the CALLER's `call.accepted` arrives on its real socket,
 *   4. only THEN does `POST /dm-calls` return 201.
 *
 * The gate stands in for the push latency the fix removed — the point is not how
 * the delay is produced, it is that the caller can be last to know and must still
 * end up in the call. Recovery is `GET /dm-calls/active` (call-UX plan K2.2): the
 * caller asks what call it is really in and gets the live row plus fresh join
 * credentials. Without that endpoint there is no way back into the room, which is
 * the whole reason it exists.
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
  type RealtimeMutation,
  type RealtimeMutationPublisher,
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
}

interface CallRow {
  id: string;
  status: string;
}

const dbUp = await isDbUp();
if (!dbUp) {
  refuseToSkipIfRequired("postgres");
  console.warn("[dm-call-early-accept.int.test] DATABASE unreachable — skipping");
}

describe.skipIf(!dbUp)("DM call: the callee accepts before the caller's own response", () => {
  let client: DbClient;
  let repos: Repositories;
  let gateway: Gateway;
  let app: FastifyInstance;
  let port: number;

  /** Set while a `call.invite` publish must be held open; null otherwise. */
  let ringGate: Promise<void> | null = null;
  let releaseRing: (() => void) | null = null;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async function makeActor(label: string): Promise<Actor> {
    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const user = await repos.users.create({
      username: `${label}_${suffix}`,
      displayName: label,
      passwordHash: "not-used-in-this-test",
    });
    const token = generateSessionToken();
    await repos.sessions.create({
      userId: user.id,
      tokenHash: hashSessionToken(token),
      expiresAt: sessionExpiresAt(new Date(), 1),
    });
    return { id: user.id, token };
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

    // Every event goes to the real bus (and therefore to the real sockets); the
    // ring publish additionally waits on the gate when one is armed.
    const gatedBus: RealtimeMutationPublisher = {
      async publish(mutation: RealtimeMutation): Promise<void> {
        await bus.publish(mutation);
        if (mutation.event.type === SERVER_EVENT.callInvite && ringGate) {
          await ringGate;
        }
      },
    };
    app = await buildApp({
      repos,
      env: loadEnv({ DATABASE_URL }),
      mutationBus: gatedBus,
      logger: false,
    });
  });

  afterAll(async () => {
    releaseRing?.();
    await app?.close();
    await gateway?.close();
    await client?.close();
  });

  it("the caller resyncs onto the ACTIVE call instead of being stranded", async () => {
    const caller = await makeActor("earlyCaller");
    const callee = await makeActor("earlyCallee");

    // Mutual friends + an open DM — the gate every call endpoint re-checks.
    await app.inject({
      method: "POST",
      url: "/friends/requests",
      headers: auth(caller.token),
      payload: { userId: callee.id },
    });
    await app.inject({
      method: "POST",
      url: `/friends/requests/${caller.id}/accept`,
      headers: auth(callee.token),
    });
    const dmRes = await app.inject({
      method: "POST",
      url: "/dms",
      headers: auth(caller.token),
      payload: { userId: callee.id },
    });
    const dm = (dmRes.json() as { dm: { id: string } }).dm;

    // Both sides hold a REAL gateway socket, as they do in production.
    const callerSock = await TestClient.connect(port, caller.token);
    const calleeSock = await TestClient.connect(port, callee.token);
    await callerSock.waitFor(SERVER_EVENT.authSucceeded);
    await calleeSock.waitFor(SERVER_EVENT.authSucceeded);

    // Arm the gate: the ring is delivered, then the caller's response is stuck
    // behind it until this test says otherwise.
    ringGate = new Promise<void>((resolve) => {
      releaseRing = resolve;
    });

    let startSettled = false;
    const startPromise = app
      .inject({
        method: "POST",
        url: "/dm-calls",
        headers: auth(caller.token),
        payload: { dmId: dm.id, media: "audio" },
      })
      .then((res) => {
        startSettled = true;
        return res;
      });

    // 1) The ring arrives on the callee's real socket.
    const invite = await calleeSock.waitFor(SERVER_EVENT.callInvite);
    const callId = invite.payload.callId;
    expect(invite.payload.target).toEqual({ kind: "dm", dmId: dm.id });
    // The caller still has no idea what its own call id is.
    expect(startSettled).toBe(false);

    // 2) The callee accepts — successfully, over real HTTP, ahead of the caller.
    const accept = await app.inject({
      method: "POST",
      url: `/dm-calls/${callId}/accept`,
      headers: auth(callee.token),
    });
    expect(accept.statusCode).toBe(200);
    expect((accept.json() as { call: CallRow }).call.status).toBe("active");

    // 3) `call.accepted` lands on the CALLER's socket for a call the caller has
    //    never been told about — the out-of-phase event that used to be dropped.
    const accepted = await callerSock.waitFor(
      SERVER_EVENT.callAccepted,
      (event) => event.payload.callId === callId,
    );
    expect(accepted.payload.callee.id).toBe(callee.id);
    // Proof the ordering under test really happened, not a lucky interleaving.
    expect(startSettled).toBe(false);

    // 4) Only now does the caller's own start response arrive.
    releaseRing?.();
    const started = await startPromise;
    expect(started.statusCode).toBe(201);
    expect((started.json() as { call: CallRow }).call.id).toBe(callId);

    // ── RECOVERY ────────────────────────────────────────────────────────────
    // The caller asks the server what call it is actually in. Before K2.2 there
    // was nothing to ask: the row was `active`, the accept was gone, and the only
    // exit was the 3-6 minute sweeper.
    const resyncRes = await app.inject({
      method: "GET",
      url: "/dm-calls/active",
      headers: auth(caller.token),
    });
    expect(resyncRes.statusCode).toBe(200);
    const resync = resyncRes.json() as DmCallActiveResponse;
    expect(resync.call?.id).toBe(callId);
    expect(resync.call?.status).toBe("active");
    expect(resync.side).toBe("caller");
    expect(resync.peer?.id).toBe(callee.id);
    // …and it can JOIN: fresh credentials for this call's room, so a caller whose
    // token expired during the gap does not need a second request either.
    expect(resync.media?.roomName).toBe(`dmcall:${callId}`);
    expect(resync.media?.identity).toBe(caller.id);
    expect(resync.media?.token).toBeTruthy();

    // The callee's own resync agrees — one call, one room, both sides in it.
    const calleeResync = (
      await app.inject({
        method: "GET",
        url: "/dm-calls/active",
        headers: auth(callee.token),
      })
    ).json() as DmCallActiveResponse;
    expect(calleeResync.call?.id).toBe(callId);
    expect(calleeResync.side).toBe("callee");
    expect(calleeResync.media?.roomName).toBe(`dmcall:${callId}`);

    // Clean up so this suite leaves no live row behind for the sweeper suite.
    ringGate = null;
    await app.inject({
      method: "POST",
      url: `/dm-calls/${callId}/hangup`,
      headers: auth(caller.token),
    });
    callerSock.close();
    calleeSock.close();
  });
});
