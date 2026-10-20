import { beforeEach, describe, expect, it } from "vitest";
import type { Message } from "@demli/types";
import type { OutboxMessage } from "../stores/chat-store";
import { assembleThread } from "./thread-assembly";
import { CONFIRM_HANDOVER_MS, rememberConfirmedSend, resetConfirmedSends } from "./confirmed-sends";
import type { ChatMessage } from "./chat-message";

/**
 * The optimistic → confirmed hand-over of one of the viewer's own sends.
 *
 * Before: the optimistic row was keyed `outbox-<nonce>`, the confirmed one by
 * its server id, so the row remounted and the arrival motion played twice on
 * every message sent. And the echo removes the outbox entry one render before
 * the server copy reaches the cache, so the row vanished for that render.
 */

const T0 = Date.parse("2026-10-20T10:00:00.000Z");

function serverMessage(id: string, content: string): Message {
  return {
    id,
    channelId: "c1",
    authorId: "me",
    content,
    createdAt: new Date(T0).toISOString(),
    updatedAt: null,
    deletedAt: null,
  } as Message;
}

function pending(nonce: string, content: string): OutboxMessage {
  return {
    nonce,
    channelId: "c1",
    authorId: "me",
    content,
    createdAt: new Date(T0).toISOString(),
    deliveryState: "sending",
    errorKey: null,
  } as OutboxMessage;
}

/** What the virtualizer keys a message row by (buildRows: renderKey ?? id). */
const rowKey = (m: ChatMessage): string => m.renderKey ?? m.id;

beforeEach(() => resetConfirmedSends());

describe("assembleThread hand-over", () => {
  it("keeps one row key from optimistic send to confirmed message", () => {
    const sending = assembleThread([{ messages: [serverMessage("s0", "older")] }], [pending("n1", "hi")], new Map(), T0);
    expect(sending.messages.map(rowKey)).toEqual(["s0", "outbox-n1"]);

    // Echo: the pairing is recorded, then the outbox drops the entry. The cache
    // has not been updated yet — the row must still be there, same key.
    rememberConfirmedSend("s1", "n1", T0 + 100);
    const gap = assembleThread([{ messages: [serverMessage("s0", "older")] }], [], sending.snapshot, T0 + 110);
    expect(gap.messages.map(rowKey)).toEqual(["s0", "outbox-n1"]);

    // The server copy lands: same key, the server id and state underneath.
    const confirmed = assembleThread(
      [{ messages: [serverMessage("s1", "hi"), serverMessage("s0", "older")] }],
      [],
      gap.snapshot,
      T0 + 130,
    );
    expect(confirmed.messages.map(rowKey)).toEqual(["s0", "outbox-n1"]);
    const last = confirmed.messages[1];
    expect(last?.id).toBe("s1");
    expect(last?.deliveryState).toBe("sent");
    expect(confirmed.snapshot.size).toBe(0);
  });

  it("does not keep a ghost row when the server copy never reaches this cache", () => {
    const sending = assembleThread([], [pending("n2", "lost")], new Map(), T0);
    rememberConfirmedSend("s2", "n2", T0);
    const late = assembleThread([], [], sending.snapshot, T0 + CONFIRM_HANDOVER_MS + 1);
    expect(late.messages).toEqual([]);
  });

  it("drops a discarded (never confirmed) send at once", () => {
    const sending = assembleThread([], [pending("n3", "discard me")], new Map(), T0);
    const after = assembleThread([], [], sending.snapshot, T0 + 10);
    expect(after.messages).toEqual([]);
  });

  it("leaves other people's and history messages keyed by id", () => {
    const { messages } = assembleThread([{ messages: [serverMessage("x", "a")] }], [], new Map(), T0);
    expect(messages[0]?.renderKey).toBeUndefined();
  });
});
