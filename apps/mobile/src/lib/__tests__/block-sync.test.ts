import { describe, expect, it } from "vitest";
import type { UserId } from "@demli/types";
import { blockChangeQueryKeys } from "../block-sync";
import { queryKeys } from "../query-client";

const TARGET = "u-target" as UserId;

/** Serialize keys so `toContainEqual` comparisons read clearly on failure. */
function keys(): string[] {
  return blockChangeQueryKeys(TARGET).map((k) => JSON.stringify(k));
}

describe("blockChangeQueryKeys", () => {
  it("refreshes the Blocked users list — an unblock must update the settings screen", () => {
    expect(keys()).toContain(JSON.stringify(queryKeys.blocks));
  });

  it("refreshes the target's profile card, which carries the `blocked` flag", () => {
    expect(keys()).toContain(JSON.stringify(["profile", TARGET]));
  });

  it("refreshes both friend-request directions — a block severs either one", () => {
    expect(keys()).toContain(JSON.stringify(queryKeys.friendRequests("incoming")));
    expect(keys()).toContain(JSON.stringify(queryKeys.friendRequests("outgoing")));
  });

  it("refreshes friends, DMs and message history (all server-filtered)", () => {
    expect(keys()).toContain(JSON.stringify(queryKeys.friends));
    expect(keys()).toContain(JSON.stringify(queryKeys.dms));
    expect(keys()).toContain(JSON.stringify(queryKeys.allMessages));
  });

  it("is the same set regardless of direction — block and unblock share one path", () => {
    expect(blockChangeQueryKeys(TARGET)).toEqual(blockChangeQueryKeys(TARGET));
  });
});
