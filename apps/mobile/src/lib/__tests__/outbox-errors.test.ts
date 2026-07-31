/**
 * Queue-failure → catalog-key mapping (M17).
 *
 * The offline queue stores a machine KEY (`OutboxErrorKey`), never a sentence,
 * so the ONE place a user ever learns why their message is stuck is this mapper.
 * A key that falls through to the generic "failed" copy is a silent regression:
 * the user is told "message failed" when the truth was "you're offline, it will
 * send when you reconnect" — a completely different action.
 *
 * The `t` here is a stub that echoes its key, so this asserts the ROUTING (which
 * catalog entry is chosen) and not the wording; the wording itself is covered by
 * the TR⇄EN parity test in packages/i18n.
 */

import { describe, expect, it } from "vitest";
import type { OutboxErrorKey } from "@demli/client-core";
import { outboxErrorText } from "../outbox-errors";
import type { AppTFunction } from "../i18n";

/** Echoes the key it is asked for — makes the mapping directly assertable. */
const t = ((key: string) => key) as unknown as AppTFunction;

describe("outboxErrorText", () => {
  it("maps every queue error key to its OWN catalog entry", () => {
    const cases: [OutboxErrorKey, string][] = [
      ["offline", "mobile:message.queueOffline"],
      ["timeout", "mobile:message.queueTimeout"],
      ["rejected", "mobile:message.queueRejected"],
      ["channel_gone", "mobile:message.queueChannelGone"],
      ["attempts_exhausted", "mobile:message.queueExhausted"],
    ];
    for (const [key, expected] of cases) {
      expect(outboxErrorText(key, t)).toBe(expected);
    }
  });

  it("gives distinct copy for every key (no two collapse together)", () => {
    const keys: OutboxErrorKey[] = [
      "offline",
      "timeout",
      "rejected",
      "channel_gone",
      "attempts_exhausted",
    ];
    const resolved = keys.map((key) => outboxErrorText(key, t));
    expect(new Set(resolved).size).toBe(keys.length);
  });

  it("falls back to the generic failure copy when there is no key", () => {
    // A `failed` item with a null reason is possible (a legacy persisted blob);
    // it must still say SOMETHING rather than render an empty line.
    expect(outboxErrorText(null, t)).toBe("mobile:message.failed");
  });
});
