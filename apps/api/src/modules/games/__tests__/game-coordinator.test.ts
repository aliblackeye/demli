import { describe, it, expect, vi, beforeEach } from "vitest";
import { GameCoordinator } from "../game-coordinator.js";
import type { RealtimeMutationPublisher } from "@demli/db";
import type { ServerToClientEvent } from "@demli/protocol";

function mockBus() {
  const published: Array<{ userId?: string; event: ServerToClientEvent }> = [];
  const bus: RealtimeMutationPublisher = {
    publish: vi.fn(async (m) => {
      published.push(m as any);
    }),
  };
  return { bus, published };
}

describe("GameCoordinator", () => {
  let coord: GameCoordinator;
  let bus: ReturnType<typeof mockBus>;

  beforeEach(() => {
    bus = mockBus();
    coord = new GameCoordinator(bus.bus);
  });

  it("invite → accept → game starts for both players", async () => {
    const res = await coord.invite("user-a", "user-b", "chan-1");
    expect("gameId" in res).toBe(true);
    if (!("gameId" in res)) return;

    expect(bus.published.length).toBe(1);
    expect(bus.published[0]!.userId).toBe("user-b");
    expect(bus.published[0]!.event.type).toBe("game.invite_received");

    const accept = await coord.accept("user-b", res.gameId);
    expect("ok" in accept).toBe(true);

    const startEvents = bus.published.filter(
      (m) => m.event.type === "game.started",
    );
    expect(startEvents.length).toBe(2);
    const userIds = startEvents.map((m) => m.userId).sort();
    expect(userIds).toEqual(["user-a", "user-b"]);
  });

  it("cannot invite yourself", async () => {
    const res = await coord.invite("user-a", "user-a", "chan-1");
    expect("error" in res).toBe(true);
  });

  it("decline removes invite and notifies inviter", async () => {
    const res = await coord.invite("user-a", "user-b", "chan-1");
    if (!("gameId" in res)) return;

    const decline = await coord.decline("user-b", res.gameId);
    expect("ok" in decline).toBe(true);

    const declinedEvents = bus.published.filter(
      (m) => m.event.type === "game.declined",
    );
    expect(declinedEvents.length).toBe(1);
    expect(declinedEvents[0]!.userId).toBe("user-a");
  });

  it("move broadcasts result to both players", async () => {
    const res = await coord.invite("user-a", "user-b", "chan-1");
    if (!("gameId" in res)) return;
    await coord.accept("user-b", res.gameId);

    bus.published.length = 0;

    const move = await coord.move("user-a", res.gameId, {
      type: "reveal",
      row: 0,
      col: 0,
    });
    expect("ok" in move).toBe(true);

    const moveEvents = bus.published.filter(
      (m) => m.event.type === "game.move_result",
    );
    expect(moveEvents.length).toBe(2);
  });

  it("wrong player cannot move", async () => {
    const res = await coord.invite("user-a", "user-b", "chan-1");
    if (!("gameId" in res)) return;
    await coord.accept("user-b", res.gameId);

    const move = await coord.move("user-b", res.gameId, {
      type: "reveal",
      row: 0,
      col: 0,
    });
    expect("error" in move).toBe(true);
  });

  it("non-player cannot move", async () => {
    const res = await coord.invite("user-a", "user-b", "chan-1");
    if (!("gameId" in res)) return;
    await coord.accept("user-b", res.gameId);

    const move = await coord.move("user-c", res.gameId, {
      type: "reveal",
      row: 0,
      col: 0,
    });
    expect("error" in move).toBe(true);
  });

  it("accept on expired/unknown invite fails", async () => {
    const result = await coord.accept("user-b", "nonexistent-id");
    expect("error" in result).toBe(true);
  });

  it("already-in-game user cannot be invited again", async () => {
    const res1 = await coord.invite("user-a", "user-b", "chan-1");
    if (!("gameId" in res1)) return;
    await coord.accept("user-b", res1.gameId);

    const res2 = await coord.invite("user-a", "user-c", "chan-1");
    expect("error" in res2).toBe(true);
    if ("error" in res2) expect(res2.error).toBe("already_in_game");
  });
});
