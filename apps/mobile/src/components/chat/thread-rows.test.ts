import { describe, expect, it } from "vitest";
import type { Message } from "@demli/types";
import type { OutboxMessage } from "../../stores/chat-store";
import {
  buildThreadRows,
  countNewerThan,
  dayLabel,
  isContinuationRow,
  localDayStart,
  type ChatItem,
} from "./thread-rows";

function server(id: string, authorId: string, createdAt: string, extra: Partial<Message> = {}): ChatItem {
  return {
    kind: "server",
    message: {
      id,
      channelId: "c1",
      authorId,
      content: id,
      createdAt,
      updatedAt: null,
      deletedAt: null,
      kind: "user",
      ...extra,
    } as unknown as Message,
  };
}

function outbox(nonce: string, authorId: string, createdAt: string, deliveryState: OutboxMessage["deliveryState"] = "sending"): ChatItem {
  return {
    kind: "outbox",
    message: {
      nonce,
      channelId: "c1",
      authorId,
      content: nonce,
      createdAt,
      deliveryState,
      errorKey: null,
    } as unknown as OutboxMessage,
  };
}

/** Local wall-clock ISO so the day maths is timezone-independent in CI. */
function at(y: number, m: number, d: number, h: number, min = 0): string {
  return new Date(y, m - 1, d, h, min).toISOString();
}

describe("isContinuationRow", () => {
  it("groups the same author inside the window", () => {
    const older = server("a", "u1", at(2026, 10, 20, 10, 0));
    const newer = server("b", "u1", at(2026, 10, 20, 10, 3));
    expect(isContinuationRow(newer, older)).toBe(true);
  });

  it("never groups across local midnight, even a minute apart", () => {
    const older = server("a", "u1", at(2026, 10, 19, 23, 59));
    const newer = server("b", "u1", at(2026, 10, 20, 0, 0));
    expect(isContinuationRow(newer, older)).toBe(false);
  });

  it("keeps a reply standalone and breaks after a failed send", () => {
    const older = server("a", "u1", at(2026, 10, 20, 10, 0));
    const reply = server("b", "u1", at(2026, 10, 20, 10, 1), {
      replyTo: { id: "a", authorId: "u1", content: "a", kind: "user", deleted: false },
    } as Partial<Message>);
    expect(isContinuationRow(reply, older)).toBe(false);
    const failed = outbox("n1", "u1", at(2026, 10, 20, 10, 0), "failed");
    expect(isContinuationRow(server("c", "u1", at(2026, 10, 20, 10, 1)), failed)).toBe(false);
  });

  it("never groups system notices or different authors", () => {
    const sys = server("s", "u1", at(2026, 10, 20, 10, 0), { kind: "system" } as Partial<Message>);
    expect(isContinuationRow(server("a", "u1", at(2026, 10, 20, 10, 1)), sys)).toBe(false);
    expect(
      isContinuationRow(server("a", "u2", at(2026, 10, 20, 10, 1)), server("b", "u1", at(2026, 10, 20, 10, 0))),
    ).toBe(false);
  });
});

describe("buildThreadRows", () => {
  // newest-first, as ChatThread feeds the inverted list
  const items: ChatItem[] = [
    outbox("n1", "me", at(2026, 10, 20, 9, 2)),
    server("m4", "me", at(2026, 10, 20, 9, 1)),
    server("m3", "u1", at(2026, 10, 20, 9, 0)),
    server("m2", "u1", at(2026, 10, 19, 22, 0)),
    server("m1", "u1", at(2026, 10, 19, 21, 58)),
  ];

  it("puts a day separator above the first message of each day", () => {
    const rows = buildThreadRows(items, null, true);
    expect(rows.map((r) => r.dayStart !== null)).toEqual([false, false, true, false, true]);
    expect(rows[2]!.dayStart).toBe(localDayStart(at(2026, 10, 20, 9, 0)));
  });

  it("no separator on the oldest LOADED message while older pages exist", () => {
    const rows = buildThreadRows(items, null, false);
    expect(rows[4]!.dayStart).toBeNull();
    expect(rows[2]!.dayStart).not.toBeNull();
  });

  it("a separator or the unread line restarts the author group", () => {
    const rows = buildThreadRows(items, null, true);
    // m3 follows m2 (same author) across midnight → keeps its header.
    expect(rows[2]!.grouped).toBe(false);
    // m2 continues m1 (same day, 2 min)
    expect(rows[3]!.grouped).toBe(true);
    // the optimistic send continues my own m4
    expect(rows[0]!.grouped).toBe(true);
    const withUnread = buildThreadRows(items, "m2", true);
    expect(withUnread[3]).toEqual({ grouped: false, dayStart: null, unread: true });
  });

  it("the unread anchor never matches an outbox row", () => {
    const rows = buildThreadRows([outbox("m4", "me", at(2026, 10, 20, 9, 2))], "m4", true);
    expect(rows[0]!.unread).toBe(false);
  });
});

describe("countNewerThan", () => {
  const msgs = [{ id: "c" }, { id: "b" }, { id: "a" }] as unknown as Message[];
  it("counts what arrived after the remembered newest id", () => {
    expect(countNewerThan(msgs, "a")).toBe(2);
    expect(countNewerThan(msgs, "c")).toBe(0);
  });
  it("is zero for an unknown or missing id", () => {
    expect(countNewerThan(msgs, "zz")).toBe(0);
    expect(countNewerThan(msgs, null)).toBe(0);
  });
});

describe("dayLabel", () => {
  const words = { today: "Bugün", yesterday: "Dün" };
  const now = new Date(2026, 9, 20, 15, 0);
  it("says today / yesterday", () => {
    expect(dayLabel(new Date(2026, 9, 20).getTime(), now, "tr", words)).toBe("Bugün");
    expect(dayLabel(new Date(2026, 9, 19).getTime(), now, "tr", words)).toBe("Dün");
  });
  it("spells older days in the app language, year only when it differs", () => {
    const thisYear = dayLabel(new Date(2026, 9, 12).getTime(), now, "tr", words);
    expect(thisYear).toContain("12");
    expect(thisYear).toContain("Ekim");
    expect(thisYear).not.toContain("2026");
    const lastYear = dayLabel(new Date(2025, 0, 3).getTime(), now, "en", words);
    expect(lastYear).toContain("2025");
    expect(lastYear).toContain("January");
  });
});
