/**
 * DM-call pushes that keep a backgrounded phone in sync — unit tests over
 * mocked repos and a recording notifier (no DB, no Expo).
 *
 * Before: the ring push was retracted ONLY when the caller cancelled. A callee
 * who answered or declined on the desktop kept "X is calling you." on the
 * phone, and a ring reaped inline (POST /dm-calls, GET /dm-calls/active) left
 * the ring, wrote no missed-call line and told no other device it was over.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  hashSessionToken,
  InMemoryMutationBus,
  type RealtimeMutation,
  type Repositories,
} from "@demli/db";
import type { OfflineNotifier, PushNotification } from "@demli/notifications";
import { callPushTag } from "@demli/notifications";
import { SERVER_EVENT } from "@demli/protocol";
import type { DmCall, User } from "@demli/types";
import { buildApp } from "../app.js";
import { loadEnv } from "../env.js";

const CALLER_TOKEN = "caller-token";
const CALLEE_TOKEN = "callee-token";
const DM_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const STREAM_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CALL_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const THIRD_ID = "33333333-3333-4333-8333-333333333333";

function user(id: string, name: string): User {
  return { id, username: name.toLowerCase(), displayName: name, avatarUrl: null, createdAt: "" };
}
const caller = user("11111111-1111-4111-8111-111111111111", "Ali");
const callee = user("22222222-2222-4222-8222-222222222222", "Burak");
const third = user(THIRD_ID, "Can");

let call: DmCall;
let upgradeImpl: () => Promise<unknown>;
const messages: Array<{ content: string; authorId: string }> = [];

function freshCall(overrides: Partial<DmCall> = {}): DmCall {
  return {
    id: CALL_ID,
    dmId: DM_ID,
    roomName: `dmcall:${CALL_ID}`,
    callerId: caller.id,
    calleeId: callee.id,
    media: "audio",
    status: "ringing",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    startedAt: null,
    endedAt: null,
    upgradedToGroupId: null,
    ...overrides,
  } as DmCall;
}

const repos = {
  sessions: {
    findActiveByTokenHash: async (hash: string) =>
      hash === hashSessionToken(CALLER_TOKEN)
        ? { session: { id: "s1" }, user: caller }
        : hash === hashSessionToken(CALLEE_TOKEN)
          ? { session: { id: "s2" }, user: callee }
          : null,
    touchLastSeen: async () => undefined,
  },
  calls: {
    findById: async () => call,
    findLiveForUser: async () => (call.status === "ringing" || call.status === "active" ? call : null),
    activateIfRinging: async () => {
      if (call.status !== "ringing") return null;
      call = { ...call, status: "active", startedAt: new Date().toISOString() };
      return call;
    },
    closeIfIn: async (_id: string, from: string[], status: DmCall["status"]) => {
      if (!from.includes(call.status)) return null;
      call = { ...call, status, endedAt: new Date().toISOString() };
      return call;
    },
  },
  callUpgrade: { upgradeDmToGroup: () => upgradeImpl() },
  friendships: { getFriendshipWith: async () => ({ status: "accepted" }) },
  userBlocks: { existsBetween: async () => false },
  users: {
    findById: async (id: string) => [caller, callee, third].find((u) => u.id === id) ?? null,
  },
  dms: {
    findById: async (_dmId: string, viewerId: string) => ({
      id: DM_ID,
      streamId: STREAM_ID,
      participant: viewerId === caller.id ? callee : caller,
    }),
    unhide: async () => undefined,
  },
  messages: {
    create: async (input: { content: string; authorId: string }) => {
      messages.push(input);
      return {
        id: "m1",
        channelId: STREAM_ID,
        authorId: input.authorId,
        content: input.content,
        kind: "system",
        createdAt: new Date().toISOString(),
        editedAt: null,
      };
    },
  },
} as unknown as Repositories;

describe("DM-call pushes reach every device of the callee", () => {
  let app: FastifyInstance;
  const pushes: Array<{ to: readonly string[]; push: PushNotification }> = [];
  const published: RealtimeMutation[] = [];

  const notifier: OfflineNotifier = {
    notify: async () => undefined,
    notifyAlways: async (to, push) => {
      pushes.push({ to, push });
    },
  };

  beforeAll(async () => {
    const bus = new InMemoryMutationBus();
    await bus.subscribe((m) => published.push(m));
    app = await buildApp({
      repos,
      env: loadEnv({ DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/demli" }),
      mutationBus: bus,
      notifier,
      callLiveness: null,
      logger: false,
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    call = freshCall();
    pushes.length = 0;
    published.length = 0;
    messages.length = 0;
  });

  const post = (url: string, token: string, payload: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload });

  /** Dispatch is fire-and-forget; let the microtask that records it run. */
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it("accepting sends the callee's other devices a silent ring-clear on the call's tag", async () => {
    const res = await post(`/dm-calls/${CALL_ID}/accept`, CALLEE_TOKEN);
    expect(res.statusCode).toBe(200);
    await settle();
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.to).toEqual([callee.id]);
    expect(pushes[0]!.push).toMatchObject({
      silent: true,
      collapseKey: callPushTag(CALL_ID),
      data: { type: "call_ended", callId: CALL_ID, reason: "answered" },
    });
  });

  it("declining does the same with reason declined", async () => {
    const res = await post(`/dm-calls/${CALL_ID}/reject`, CALLEE_TOKEN);
    expect(res.statusCode).toBe(200);
    await settle();
    expect(pushes.map((p) => p.push.data)).toEqual([
      { type: "call_ended", callId: CALL_ID, reason: "declined" },
    ]);
  });

  it("an expired ring reaped by the resync read is announced like the sweeper would", async () => {
    call = freshCall({
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const res = await app.inject({
      method: "GET",
      url: "/dm-calls/active",
      headers: { authorization: `Bearer ${CALLEE_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().call).toBeNull();
    await settle();

    expect(call.status).toBe("missed");
    expect(messages.map((m) => m.content)).toEqual(["@sys:call_missed"]);
    const ended = published.filter((m) => m.event.type === SERVER_EVENT.callEnded);
    expect(ended.map((m) => m.userId).sort()).toEqual([caller.id, callee.id].sort());
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.to).toEqual([callee.id]);
    expect(pushes[0]!.push).toMatchObject({
      title: caller.displayName,
      body: "Missed call",
      collapseKey: callPushTag(CALL_ID),
    });
  });

  it("losing a simultaneous upgrade is a 409, not a 500", async () => {
    call = freshCall({ status: "active", startedAt: new Date().toISOString() });
    upgradeImpl = async () => {
      throw new Error(`dm_call ${CALL_ID} is not live (status=upgraded)`);
    };
    const res = await post(`/dm-calls/${CALL_ID}/upgrade`, CALLER_TOKEN, { inviteeUserId: THIRD_ID });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
  });
});
