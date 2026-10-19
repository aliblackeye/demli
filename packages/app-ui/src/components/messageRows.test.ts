/**
 * Row model tests — the ignored-author fold (ADR 0019 §4) and the grouping /
 * divider rules it has to keep working around.
 *
 * The fold is the piece most likely to break silently: it changes how many rows
 * the virtualizer is told about, so a bug here shows up as a scroll jump or a
 * message that quietly never renders, not as an exception.
 */

import { describe, expect, it } from "vitest";
import type { ChatMessageView } from "../data/chat-data";
import {
  buildRows,
  firstUnreadMessageId,
  tailSentinel,
  toggleIgnoredRun,
  type ListRow,
} from "./messageRows";

const BASE = Date.parse("2026-07-27T12:00:00.000Z");

/** A confirmed message `secondsAfterBase` into the fixture timeline. */
function msg(
  id: string,
  authorId: string,
  secondsAfterBase = 0,
  overrides: Partial<ChatMessageView> = {},
): ChatMessageView {
  return {
    id,
    channelId: "chan-1",
    authorId,
    content: id,
    createdAt: new Date(BASE + secondsAfterBase * 1000).toISOString(),
    updatedAt: null,
    deletedAt: null,
    deliveryState: "sent",
    errorKey: null,
    nonce: null,
    ...overrides,
  } as ChatMessageView;
}

const OPTIONS = { atChannelStart: false, loadingOlder: false, dividerBeforeId: null };

/** Just the message ids the list would actually render, in order. */
function renderedMessageIds(rows: ListRow[]): string[] {
  return rows.flatMap((row) => (row.kind === "message" ? [row.message.id] : []));
}

function runs(rows: ListRow[]): Extract<ListRow, { kind: "ignored-run" }>[] {
  return rows.filter((row): row is Extract<ListRow, { kind: "ignored-run" }> =>
    row.kind === "ignored-run",
  );
}

describe("buildRows — grouping without ignores", () => {
  it("marks same-author messages inside the window as continuations", () => {
    const rows = buildRows([msg("m1", "a", 0), msg("m2", "a", 30)], OPTIONS);
    expect(rows.map((r) => r.kind)).toEqual(["message", "message"]);
    expect(rows[1]).toMatchObject({ kind: "message", isContinuation: true });
  });

  it("breaks the group after the 5-minute window", () => {
    const rows = buildRows([msg("m1", "a", 0), msg("m2", "a", 301)], OPTIONS);
    expect(rows[1]).toMatchObject({ isContinuation: false });
  });

  it("never continues across a different author or a system notice", () => {
    const rows = buildRows(
      [msg("m1", "a", 0), msg("sys", "a", 10, { kind: "system" }), msg("m2", "a", 20)],
      OPTIONS,
    );
    expect(rows.map((r) => (r.kind === "message" ? r.isContinuation : null))).toEqual([
      false,
      false,
      false,
    ]);
  });
});

describe("buildRows — ignored-author fold", () => {
  const ignored = new Set(["troll"]);

  it("replaces a single ignored message with one placeholder", () => {
    const rows = buildRows([msg("m1", "a"), msg("m2", "troll", 10)], {
      ...OPTIONS,
      ignoredAuthorIds: ignored,
    });

    expect(rows.map((r) => r.kind)).toEqual(["message", "ignored-run"]);
    expect(renderedMessageIds(rows)).toEqual(["m1"]);
    expect(runs(rows)[0]).toMatchObject({ count: 1, authorCount: 1, expanded: false });
  });

  it("folds a CONSECUTIVE run into ONE placeholder, not one per message", () => {
    const messages = Array.from({ length: 100 }, (_, i) => msg(`t${i}`, "troll", i));
    const rows = buildRows(messages, { ...OPTIONS, ignoredAuthorIds: ignored });

    expect(rows).toHaveLength(1);
    expect(runs(rows)[0]).toMatchObject({ count: 100, runId: "t0" });
  });

  it("starts a new run after every non-ignored message", () => {
    const rows = buildRows(
      [
        msg("t1", "troll", 0),
        msg("t2", "troll", 1),
        msg("m1", "a", 2),
        msg("t3", "troll", 3),
        msg("m2", "a", 4),
      ],
      { ...OPTIONS, ignoredAuthorIds: ignored },
    );

    expect(rows.map((r) => r.kind)).toEqual([
      "ignored-run",
      "message",
      "ignored-run",
      "message",
    ]);
    expect(runs(rows).map((r) => [r.runId, r.count])).toEqual([
      ["t1", 2],
      ["t3", 1],
    ]);
  });

  it("counts distinct authors so the copy can say 'people' vs 'someone'", () => {
    const rows = buildRows(
      [msg("t1", "troll", 0), msg("t2", "spammer", 1), msg("t3", "troll", 2)],
      { ...OPTIONS, ignoredAuthorIds: new Set(["troll", "spammer"]) },
    );
    expect(runs(rows)[0]).toMatchObject({ count: 3, authorCount: 2 });
  });

  it("never folds system notices, and they split a run", () => {
    const rows = buildRows(
      [msg("t1", "troll", 0), msg("sys", "troll", 1, { kind: "system" }), msg("t2", "troll", 2)],
      { ...OPTIONS, ignoredAuthorIds: ignored },
    );
    expect(rows.map((r) => r.kind)).toEqual(["ignored-run", "message", "ignored-run"]);
    expect(renderedMessageIds(rows)).toEqual(["sys"]);
  });

  it("is inert when the viewer ignores nobody", () => {
    const messages = [msg("m1", "a"), msg("m2", "troll", 10)];
    expect(buildRows(messages, { ...OPTIONS, ignoredAuthorIds: new Set() })).toEqual(
      buildRows(messages, OPTIONS),
    );
  });

  it("keeps the unread divider in place, splitting a run around it", () => {
    const rows = buildRows(
      [msg("t1", "troll", 0), msg("t2", "troll", 1), msg("t3", "troll", 2)],
      { ...OPTIONS, dividerBeforeId: "t2", ignoredAuthorIds: ignored },
    );

    expect(rows.map((r) => r.kind)).toEqual(["ignored-run", "unread-divider", "ignored-run"]);
    expect(runs(rows).map((r) => [r.runId, r.count])).toEqual([
      ["t1", 1],
      ["t2", 2],
    ]);
  });

  it("does not let a collapsed run leave the next message headerless", () => {
    // Without the reset, `previous` would still point at a folded message and a
    // following message from that same author would render with no header at all.
    const rows = buildRows([msg("t1", "troll", 0), msg("m1", "a", 10)], {
      ...OPTIONS,
      ignoredAuthorIds: ignored,
    });
    expect(rows[1]).toMatchObject({ kind: "message", isContinuation: false });
  });
});

describe("buildRows — expanding a folded run", () => {
  const ignored = new Set(["troll"]);
  const messages = [msg("m1", "a", 0), msg("t1", "troll", 10), msg("t2", "troll", 20)];

  it("keeps the placeholder AND appends the real rows after it", () => {
    const rows = buildRows(messages, {
      ...OPTIONS,
      ignoredAuthorIds: ignored,
      expandedIgnoredRuns: new Set(["t1"]),
    });

    expect(rows.map((r) => r.kind)).toEqual(["message", "ignored-run", "message", "message"]);
    expect(renderedMessageIds(rows)).toEqual(["m1", "t1", "t2"]);
    expect(runs(rows)[0]).toMatchObject({ expanded: true, count: 2 });
  });

  it("keeps the placeholder's virtualizer key stable across the toggle", () => {
    const collapsed = buildRows(messages, { ...OPTIONS, ignoredAuthorIds: ignored });
    const expanded = buildRows(messages, {
      ...OPTIONS,
      ignoredAuthorIds: ignored,
      expandedIgnoredRuns: new Set(["t1"]),
    });

    // The virtualizer caches a measured height PER ITEM KEY. A key that changed
    // on expand would throw that measurement away and jump the scroll.
    expect(runs(collapsed)[0]?.key).toBe(runs(expanded)[0]?.key);
    // …and every row key stays unique, or two rows would share one measurement.
    const keys = expanded.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("groups revealed messages normally, starting with a header", () => {
    const rows = buildRows(messages, {
      ...OPTIONS,
      ignoredAuthorIds: ignored,
      expandedIgnoredRuns: new Set(["t1"]),
    });
    const revealed = rows.filter((r) => r.kind === "message" && r.message.authorId === "troll");
    expect(revealed.map((r) => (r.kind === "message" ? r.isContinuation : null))).toEqual([
      false,
      true,
    ]);
  });

  it("ignores an expanded id that no longer names a run", () => {
    const rows = buildRows(messages, {
      ...OPTIONS,
      ignoredAuthorIds: ignored,
      expandedIgnoredRuns: new Set(["gone"]),
    });
    expect(runs(rows)[0]).toMatchObject({ expanded: false });
    expect(renderedMessageIds(rows)).toEqual(["m1"]);
  });

  it("keeps the run id stable as the run grows, so a reveal survives new messages", () => {
    const grown = [...messages, msg("t3", "troll", 30)];
    const rows = buildRows(grown, {
      ...OPTIONS,
      ignoredAuthorIds: ignored,
      expandedIgnoredRuns: new Set(["t1"]),
    });
    expect(runs(rows)[0]).toMatchObject({ runId: "t1", count: 3, expanded: true });
    expect(renderedMessageIds(rows)).toEqual(["m1", "t1", "t2", "t3"]);
  });
});

describe("tailSentinel — 'the thread gained content'", () => {
  const ignored = new Set(["troll"]);
  const opts = { ...OPTIONS, ignoredAuthorIds: ignored };

  it("is the last message id in an ordinary thread", () => {
    expect(tailSentinel(buildRows([msg("m1", "a"), msg("m2", "b", 5)], OPTIONS))).toBe("m2");
  });

  it("does NOT change when the last fold is revealed", () => {
    const messages = [msg("m1", "a"), msg("t1", "troll", 5), msg("t2", "troll", 6)];
    const collapsed = tailSentinel(buildRows(messages, opts));
    const expanded = tailSentinel(
      buildRows(messages, { ...opts, expandedIgnoredRuns: new Set(["t1"]) }),
    );
    // Otherwise expanding would look like new content and raise the
    // "jump to present" pill for something the user just did.
    expect(expanded).toBe(collapsed);
  });

  it("does NOT change when an ignored author posts again", () => {
    // Nothing is inserted — only the placeholder's count moves — so alerting
    // would put the ignored person in front of the viewer (ADR 0019 §4).
    const before = tailSentinel(buildRows([msg("m1", "a"), msg("t1", "troll", 5)], opts));
    const after = tailSentinel(
      buildRows([msg("m1", "a"), msg("t1", "troll", 5), msg("t2", "troll", 6)], opts),
    );
    expect(after).toBe(before);
  });

  it("DOES change when anyone else posts", () => {
    const before = tailSentinel(buildRows([msg("m1", "a"), msg("t1", "troll", 5)], opts));
    const after = tailSentinel(
      buildRows([msg("m1", "a"), msg("t1", "troll", 5), msg("m2", "b", 6)], opts),
    );
    expect(after).not.toBe(before);
    expect(after).toBe("m2");
  });

  it("is undefined for an empty thread", () => {
    expect(tailSentinel([])).toBeUndefined();
  });
});

describe("toggleIgnoredRun", () => {
  it("adds, then removes, without mutating the previous set", () => {
    const empty: ReadonlySet<string> = new Set();
    const opened = toggleIgnoredRun(empty, "r1");
    expect([...opened]).toEqual(["r1"]);
    expect(empty.size).toBe(0);

    const closed = toggleIgnoredRun(opened, "r1");
    expect(closed.size).toBe(0);
    expect(opened.has("r1")).toBe(true);
  });

  it("tracks runs independently", () => {
    const set = toggleIgnoredRun(toggleIgnoredRun(new Set(), "r1"), "r2");
    expect([...set].sort()).toEqual(["r1", "r2"]);
  });
});

describe("firstUnreadMessageId", () => {
  it("returns the message after the watermark", () => {
    expect(firstUnreadMessageId(["a", "b", "c"], "a")).toBe("b");
  });

  it("returns null when caught up, or with no watermark, or with no messages", () => {
    expect(firstUnreadMessageId(["a", "b"], "b")).toBeNull();
    expect(firstUnreadMessageId(["a"], null)).toBeNull();
    expect(firstUnreadMessageId([], "a")).toBeNull();
  });

  it("falls back to the top when the watermark predates the loaded window", () => {
    expect(firstUnreadMessageId(["b", "c"], "a")).toBe("b");
  });

  it("never anchors on an own optimistic send", () => {
    expect(firstUnreadMessageId(["a", "outbox-1"], "a")).toBeNull();
    expect(firstUnreadMessageId(["outbox-1"], "zzz")).toBeNull();
  });
});

describe("buildRows — date dividers (M16)", () => {
  /** A message at a LOCAL wall-clock time, so the day boundary is the viewer's. */
  function at(id: string, authorId: string, day: number, hour: number, minute = 0): ChatMessageView {
    return msg(id, authorId, 0, {
      createdAt: new Date(2026, 6, day, hour, minute).toISOString(),
    });
  }
  const WITH_DATES = { ...OPTIONS, dateDividers: true };

  it("is off unless asked for — existing callers get the rows they always got", () => {
    const rows = buildRows([at("m1", "a", 27, 23, 58), at("m2", "a", 28, 0, 1)], OPTIONS);
    expect(rows.map((r) => r.kind)).toEqual(["message", "message"]);
  });

  it("opens the window with the first day, then one divider per new local day", () => {
    const rows = buildRows(
      [at("m1", "a", 27, 10), at("m2", "b", 27, 11), at("m3", "a", 28, 9), at("m4", "a", 30, 9)],
      WITH_DATES,
    );
    expect(rows.map((r) => r.kind)).toEqual([
      "date-divider",
      "message",
      "message",
      "date-divider",
      "message",
      "date-divider",
      "message",
    ]);
    const days = rows.flatMap((r) => (r.kind === "date-divider" ? [r.dayStart] : []));
    expect(days).toEqual([
      new Date(2026, 6, 27).getTime(),
      new Date(2026, 6, 28).getTime(),
      new Date(2026, 6, 30).getTime(),
    ]);
  });

  it("breaks author grouping across midnight even inside the 5-minute window", () => {
    const rows = buildRows([at("m1", "a", 27, 23, 58), at("m2", "a", 28, 0, 1)], WITH_DATES);
    const messages = rows.filter(
      (r): r is Extract<ListRow, { kind: "message" }> => r.kind === "message",
    );
    expect(messages.map((r) => r.isContinuation)).toEqual([false, false]);
  });

  it("never emits a second divider (or a duplicate key) for an out-of-order earlier day", () => {
    const rows = buildRows([at("m1", "a", 28, 9), at("outbox-x", "a", 27, 23)], WITH_DATES);
    const keys = rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(rows.filter((r) => r.kind === "date-divider")).toHaveLength(1);
  });

  it("puts the date divider ABOVE the unread divider when both land on one message", () => {
    const rows = buildRows([at("m1", "a", 27, 10), at("m2", "b", 28, 9)], {
      ...WITH_DATES,
      dividerBeforeId: "m2",
    });
    expect(rows.map((r) => r.kind)).toEqual([
      "date-divider",
      "message",
      "date-divider",
      "unread-divider",
      "message",
    ]);
  });

  it("splits an ignored fold at midnight so the next day's divider still renders", () => {
    const rows = buildRows(
      [at("m1", "x", 27, 23, 50), at("m2", "x", 27, 23, 55), at("m3", "x", 28, 0, 5)],
      { ...WITH_DATES, ignoredAuthorIds: new Set(["x"]) },
    );
    expect(rows.map((r) => r.kind)).toEqual([
      "date-divider",
      "ignored-run",
      "date-divider",
      "ignored-run",
    ]);
    expect(runs(rows).map((r) => r.count)).toEqual([2, 1]);
  });

  it("keeps the tail sentinel on the last message, never on a divider", () => {
    const rows = buildRows([at("m1", "a", 27, 10), at("m2", "a", 28, 10)], WITH_DATES);
    expect(tailSentinel(rows)).toBe("m2");
  });
});
