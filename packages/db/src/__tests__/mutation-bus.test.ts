import { describe, expect, it } from "vitest";
import { serverEvent } from "@demli/protocol";
import type { Message } from "@demli/types";
import {
  InMemoryMutationBus,
  parseMutation,
  serializeMutation,
  type RealtimeMutation,
} from "../redis/mutation-bus.js";

const sampleMessage: Message = {
  id: "11111111-1111-1111-1111-111111111111",
  channelId: "22222222-2222-2222-2222-222222222222",
  authorId: "33333333-3333-3333-3333-333333333333",
  content: "edited content",
  createdAt: "2026-07-04T10:00:00.000Z",
  updatedAt: "2026-07-04T10:05:00.000Z",
  deletedAt: null,
};

describe("mutation bus codec", () => {
  it("round-trips a message.updated mutation through the wire format", () => {
    const mutation: RealtimeMutation = {
      channelId: sampleMessage.channelId,
      event: serverEvent.messageUpdated(sampleMessage),
    };
    const decoded = parseMutation(serializeMutation(mutation));
    expect(decoded).toEqual(mutation);
  });

  it("round-trips a message.deleted mutation", () => {
    const mutation: RealtimeMutation = {
      channelId: sampleMessage.channelId,
      event: serverEvent.messageDeleted({
        channelId: sampleMessage.channelId,
        messageId: sampleMessage.id,
      }),
    };
    const decoded = parseMutation(serializeMutation(mutation));
    expect(decoded).toEqual(mutation);
  });

  it("rejects malformed JSON", () => {
    expect(parseMutation("not json {")).toBeNull();
  });

  it("rejects a payload whose event is not a known protocol event", () => {
    expect(
      parseMutation(JSON.stringify({ channelId: "c1", event: { type: "bogus.event", payload: {} } })),
    ).toBeNull();
  });

  it("rejects a payload missing every scope id", () => {
    expect(
      parseMutation(JSON.stringify({ event: serverEvent.messageDeleted({ channelId: "c1", messageId: "m1" }) })),
    ).toBeNull();
  });

  it("round-trips a userId-scoped social mutation (friend.removed)", () => {
    const mutation: RealtimeMutation = {
      userId: "44444444-4444-4444-4444-444444444444",
      event: serverEvent.friendRemoved({ userId: "55555555-5555-5555-5555-555555555555" }),
    };
    const decoded = parseMutation(serializeMutation(mutation));
    expect(decoded).toEqual(mutation);
  });

  it("rejects a payload that sets more than one scope id", () => {
    expect(
      parseMutation(
        JSON.stringify({
          channelId: "c1",
          userId: "u1",
          event: serverEvent.friendRemoved({ userId: "u2" }),
        }),
      ),
    ).toBeNull();
  });
});

describe("InMemoryMutationBus", () => {
  it("delivers published mutations to every subscriber via the codec", async () => {
    const bus = new InMemoryMutationBus();
    const received: RealtimeMutation[] = [];
    await bus.subscribe((m) => received.push(m));
    await bus.subscribe((m) => received.push(m));

    const mutation: RealtimeMutation = {
      channelId: sampleMessage.channelId,
      event: serverEvent.messageUpdated(sampleMessage),
    };
    await bus.publish(mutation);

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual(mutation);
    // Delivered value is decoded from the wire, not the same object reference.
    expect(received[0]).not.toBe(mutation);

    await bus.close();
  });

  it("stops delivering after close", async () => {
    const bus = new InMemoryMutationBus();
    const received: RealtimeMutation[] = [];
    await bus.subscribe((m) => received.push(m));
    await bus.close();
    await bus.publish({
      channelId: "c1",
      event: serverEvent.messageDeleted({ channelId: "c1", messageId: "m1" }),
    });
    expect(received).toHaveLength(0);
  });
});
