/**
 * "The caller vanished" ring reaper — real Postgres + real WebSockets. Skipped
 * automatically (with a console notice) when the database is down.
 *
 * Founder P0 (2026-07-27): a `dm_calls` row left `ringing`/`active` with
 * `ended_at IS NULL` re-seeds the client call FSM and rings forever. One of the
 * ways a ring is orphaned is the caller's app simply going away mid-ring — so
 * when a user's LAST socket closes, their OUTGOING rings are withdrawn.
 *
 * The three guarantees under test are as much about what the reaper must NOT do:
 *  - a CALLEE going offline does not stop the ring (mobile is rung by PUSH and
 *    may hold no socket at all);
 *  - an ACCEPTED call is never hung up on a socket close (media is a separate
 *    LiveKit transport — a tunnel drops the WS while the call keeps running);
 *  - a reconnect inside the grace window costs the caller nothing (every deploy
 *    disconnects everyone at once).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  type Repositories,
} from "@demli/db";
import { SERVER_EVENT } from "@demli/protocol";
import { createGateway, type Gateway } from "../gateway.js";
import { InMemoryPresenceStore } from "../presence.js";
import { DATABASE_URL, isDbUp, TestClient } from "./harness.js";
import { refuseToSkipIfRequired } from "@demli/db/testing";

/** Long enough to observe the "not yet" state, short enough to keep tests fast. */
const GRACE_MS = 250;

interface Actor {
  id: string;
  token: string;
}

async function makeActor(repos: Repositories, label: string): Promise<Actor> {
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const dbUp = await isDbUp();
if (!dbUp) {
  refuseToSkipIfRequired("postgres");
  console.warn("[gateway.dm-call-disconnect.int.test] DATABASE unreachable — skipping");
}

describe.skipIf(!dbUp)("gateway — withdraw an outgoing ring when the caller drops", () => {
  let client: DbClient;
  let repos: Repositories;
  let gateway: Gateway;
  let mutationBus: InMemoryMutationBus;
  let port: number;
  const published: RealtimeMutation[] = [];

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);
    mutationBus = new InMemoryMutationBus();
    await mutationBus.subscribe((m) => published.push(m));
    gateway = createGateway(
      { repos, presence: new InMemoryPresenceStore(), mutationBus },
      { port: 0, callerDropGraceMs: GRACE_MS },
    );
    port = await gateway.ready;
  });

  afterAll(async () => {
    await gateway?.close();
    await client?.close();
  });

  /** A fresh DM plus a ringing call from `caller` to `callee`. */
  async function ringingCall(
    caller: Actor,
    callee: Actor,
  ): Promise<{ id: string; dmId: string }> {
    const { dm } = await repos.dms.getOrCreate(caller.id, callee.id);
    const call = await repos.calls.create({
      dmId: dm.id,
      callerId: caller.id,
      calleeId: callee.id,
      media: "audio",
      expiresAt: new Date(Date.now() + 30_000),
    });
    return { id: call.id, dmId: dm.id };
  }

  it("withdraws the ring once the caller's LAST socket is gone, and tells both sides", async () => {
    const caller = await makeActor(repos, "dropCaller");
    const callee = await makeActor(repos, "dropCallee");
    const call = await ringingCall(caller, callee);

    const sock = await TestClient.connect(port, caller.token);
    await sock.waitFor(SERVER_EVENT.authSucceeded);
    published.length = 0;
    sock.close();
    await sock.closed;

    // Nothing happens instantly — the grace window is the whole point.
    expect((await repos.calls.findById(call.id))?.status).toBe("ringing");

    await sleep(GRACE_MS * 4);
    const after = await repos.calls.findById(call.id);
    expect(after?.status).toBe("missed");
    expect(after?.endedAt).not.toBeNull();

    // Both the callee (stop ringing) and the caller's other devices get the end.
    const ends = published.filter((m) => m.event.type === SERVER_EVENT.callEnded);
    expect(ends.map((m) => m.userId).sort()).toEqual([caller.id, callee.id].sort());
  });

  it("keeps the ring while the caller still has another socket open", async () => {
    const caller = await makeActor(repos, "twoDevCaller");
    const callee = await makeActor(repos, "twoDevCallee");
    const call = await ringingCall(caller, callee);

    const desktop = await TestClient.connect(port, caller.token);
    const phone = await TestClient.connect(port, caller.token);
    await desktop.waitFor(SERVER_EVENT.authSucceeded);
    await phone.waitFor(SERVER_EVENT.authSucceeded);

    desktop.close();
    await desktop.closed;
    await sleep(GRACE_MS * 4);

    // The user never went offline, so the ring is untouched.
    expect((await repos.calls.findById(call.id))?.status).toBe("ringing");
    phone.close();
    await phone.closed;
  });

  it("does NOT withdraw the ring when the caller reconnects inside the grace window", async () => {
    // This is every deploy: the gateway restarts, everyone's socket closes, and
    // everyone reconnects a moment later. Nobody's call may be collateral.
    const caller = await makeActor(repos, "flapCaller");
    const callee = await makeActor(repos, "flapCallee");
    const call = await ringingCall(caller, callee);

    const first = await TestClient.connect(port, caller.token);
    await first.waitFor(SERVER_EVENT.authSucceeded);
    first.close();
    await first.closed;

    const second = await TestClient.connect(port, caller.token);
    await second.waitFor(SERVER_EVENT.authSucceeded);
    await sleep(GRACE_MS * 4);

    expect((await repos.calls.findById(call.id))?.status).toBe("ringing");
    second.close();
    await second.closed;
  });

  it("does NOT withdraw the ring when the CALLEE goes offline (push still rings them)", async () => {
    const caller = await makeActor(repos, "pushCaller");
    const callee = await makeActor(repos, "pushCallee");
    const call = await ringingCall(caller, callee);

    const sock = await TestClient.connect(port, callee.token);
    await sock.waitFor(SERVER_EVENT.authSucceeded);
    sock.close();
    await sock.closed;
    await sleep(GRACE_MS * 4);

    expect((await repos.calls.findById(call.id))?.status).toBe("ringing");
  });

  it("does NOT hang up an ACCEPTED call when a participant's socket drops", async () => {
    // Media rides LiveKit, not this socket. Losing the WebSocket in a tunnel must
    // never end a conversation that is still audibly running.
    const caller = await makeActor(repos, "activeCaller");
    const callee = await makeActor(repos, "activeCallee");
    const call = await ringingCall(caller, callee);
    await repos.calls.setStatus(call.id, "active", { startedAt: new Date() });

    const sock = await TestClient.connect(port, caller.token);
    await sock.waitFor(SERVER_EVENT.authSucceeded);
    sock.close();
    await sock.closed;
    await sleep(GRACE_MS * 4);

    const after = await repos.calls.findById(call.id);
    expect(after?.status).toBe("active");
    expect(after?.endedAt).toBeNull();
  });
});
