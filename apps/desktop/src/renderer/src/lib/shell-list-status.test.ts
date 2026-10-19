import { describe, expect, it } from "vitest";
import { listStatus } from "./shell-list-status";

/**
 * The shell sidebars render exactly one of skeleton / retry band / empty state /
 * rows from this status. The failure it guards: a failed or still-loading fetch
 * rendered as the designed EMPTY state ("Henüz kanal yok", "Üyeler — 0",
 * "Henüz sohbet yok") — a lie about the user's servers and conversations.
 */
describe("listStatus", () => {
  it("is pending on the first fetch (no data, no error)", () => {
    expect(listStatus({ data: undefined, isError: false, isFetching: true })).toBe("pending");
  });

  it("is pending while the query is paused offline before its first fetch", () => {
    expect(listStatus({ data: undefined, isError: false, isFetching: false })).toBe("pending");
  });

  it("is error when the first fetch failed and nothing is cached", () => {
    expect(listStatus({ data: undefined, isError: true, isFetching: false })).toBe("error");
  });

  it("goes back to pending while a retry of a failed first fetch is in flight", () => {
    expect(listStatus({ data: undefined, isError: true, isFetching: true })).toBe("pending");
  });

  it("is ready for a genuinely empty list — only a successful fetch may read as empty", () => {
    expect(listStatus({ data: [], isError: false, isFetching: false })).toBe("ready");
  });

  it("keeps the real rows when a BACKGROUND refetch fails", () => {
    expect(listStatus({ data: [{ id: "x" }], isError: true, isFetching: false })).toBe("ready");
  });
});
