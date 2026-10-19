import { describe, expect, it } from "vitest";
import type { PresenceStatus, UserId } from "@demli/types";
import { isStaleSelfPresence, withoutSelfPresence } from "../self-presence.js";

const ME = "user-me" as UserId;
const PEER = "user-peer" as UserId;

const ALL_STATUSES: PresenceStatus[] = ["online", "idle", "dnd", "invisible", "offline"];

describe("isStaleSelfPresence", () => {
  it("drops a self `offline` — the masked value a pre-M16 gateway sent an invisible user", () => {
    expect(isStaleSelfPresence({ userId: ME, status: "offline" }, ME)).toBe(true);
  });

  it.each(["online", "idle", "dnd", "invisible"] as const)(
    "paints a self `%s` — the server's real, derived account status",
    (status) => {
      expect(isStaleSelfPresence({ userId: ME, status }, ME)).toBe(false);
    },
  );

  it.each(ALL_STATUSES)("never drops a PEER frame (%s), offline included", (status) => {
    expect(isStaleSelfPresence({ userId: PEER, status }, ME)).toBe(false);
  });

  it("drops nothing when there is no signed-in user", () => {
    expect(isStaleSelfPresence({ userId: ME, status: "offline" }, null)).toBe(false);
    expect(isStaleSelfPresence({ userId: ME, status: "offline" }, undefined)).toBe(false);
  });
});

describe("withoutSelfPresence", () => {
  it("removes the self entry a pre-M16 snapshot carried (masked to offline), keeps peers in order", () => {
    const peer2 = "user-peer-2" as UserId;
    const snapshot = [
      { userId: PEER, status: "online" as const },
      { userId: ME, status: "offline" as const },
      { userId: peer2, status: "dnd" as const, platform: "mobile" as const },
    ];
    expect(withoutSelfPresence(snapshot, ME)).toEqual([
      { userId: PEER, status: "online" },
      { userId: peer2, status: "dnd", platform: "mobile" },
    ]);
  });

  it("does not mutate its input", () => {
    const snapshot = [{ userId: ME, status: "offline" as const }];
    withoutSelfPresence(snapshot, ME);
    expect(snapshot).toEqual([{ userId: ME, status: "offline" }]);
  });

  it("is a copy-through for a contract-conforming (peers-only) snapshot and for no user", () => {
    const snapshot = [{ userId: PEER, status: "idle" as const }];
    const kept = withoutSelfPresence(snapshot, ME);
    expect(kept).toEqual(snapshot);
    expect(kept).not.toBe(snapshot);
    expect(withoutSelfPresence(snapshot, null)).toEqual(snapshot);
  });
});
