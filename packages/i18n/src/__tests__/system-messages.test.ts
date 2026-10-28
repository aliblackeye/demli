import { describe, expect, it, vi } from "vitest";
import { createI18n } from "../create-i18n.js";
import {
  isSystemMessageToken,
  resolveSystemMessage,
  systemMessageContent,
  SYSTEM_MESSAGE_TOKENS,
  type TranslateFn,
} from "../system-messages.js";

/** Fake translator: echoes an interpolated English template for known keys. */
const fakeT: TranslateFn = (key, opts) => {
  const map: Record<string, string> = {
    "common:system.member_joined": `${opts?.name} joined the server`,
    "common:system.member_left": `${opts?.name} left the server`,
    "common:system.call_ended": `Call ended · ${opts?.duration}`,
    "common:system.call_missed": "Missed call",
    "common:system.call_declined": "Call declined",
    "common:system.call_canceled": "Call canceled",
    "common:system.game_started": `${opts?.name} started a game — Minesweeper Flags`,
    "common:system.game_ended": `Game over · ${opts?.score}`,
  };
  return map[key] ?? key;
};

describe("system message tokens", () => {
  it("builds the persisted content for each token", () => {
    expect(systemMessageContent("member_joined")).toBe("@sys:member_joined");
    expect(systemMessageContent("member_left")).toBe("@sys:member_left");
  });

  it("recognizes only known tokens", () => {
    expect(isSystemMessageToken("member_joined")).toBe(true);
    expect(isSystemMessageToken("member_left")).toBe(true);
    expect(isSystemMessageToken("member_promoted")).toBe(false);
    expect([...SYSTEM_MESSAGE_TOKENS]).toEqual([
      "member_joined",
      "member_left",
      "call_ended",
      "call_missed",
      "call_declined",
      "call_canceled",
      "game_started",
      "game_ended",
    ]);
  });
});

describe("DM-call system messages (ADR 0012)", () => {
  it("parses call_ended talk-time into m:ss", () => {
    expect(resolveSystemMessage("@sys:call_ended:272", "Ali", fakeT)).toBe("Call ended · 4:32");
    expect(resolveSystemMessage("@sys:call_ended:5", "Ali", fakeT)).toBe("Call ended · 0:05");
    expect(resolveSystemMessage("@sys:call_ended:3661", "Ali", fakeT)).toBe("Call ended · 1:01:01");
  });

  it("resolves the bare call tokens", () => {
    expect(resolveSystemMessage("@sys:call_missed", "Ali", fakeT)).toBe("Missed call");
    expect(resolveSystemMessage("@sys:call_declined", "Ali", fakeT)).toBe("Call declined");
    expect(resolveSystemMessage("@sys:call_canceled", "Ali", fakeT)).toBe("Call canceled");
  });
});

describe("Game system messages", () => {
  it("resolves game_started as a bare token", () => {
    expect(resolveSystemMessage("@sys:game_started", "Ali", fakeT)).toBe(
      "Ali started a game — Minesweeper Flags",
    );
  });

  it("resolves game_ended with score", () => {
    expect(resolveSystemMessage("@sys:game_ended:26-18", "Ali", fakeT)).toBe(
      "Game over · 26-18",
    );
  });
});

describe("resolveSystemMessage", () => {
  it("translates a known token with the resolved display name", () => {
    expect(resolveSystemMessage("@sys:member_joined", "Ali", fakeT)).toBe("Ali joined the server");
    expect(resolveSystemMessage("@sys:member_left", "Burak", fakeT)).toBe("Burak left the server");
  });

  it("returns an unknown @sys token verbatim without calling t", () => {
    const t = vi.fn(fakeT);
    expect(resolveSystemMessage("@sys:member_promoted", "Ali", t)).toBe("@sys:member_promoted");
    expect(t).not.toHaveBeenCalled();
  });

  it("returns legacy plain-text content verbatim (backward compat)", () => {
    const t = vi.fn(fakeT);
    // Old rows written before tokenization stay exactly as stored.
    expect(resolveSystemMessage("Ali sunucuya katıldı", "Ali", t)).toBe("Ali sunucuya katıldı");
    expect(resolveSystemMessage("hello world", "Ali", t)).toBe("hello world");
    expect(t).not.toHaveBeenCalled();
  });

  it("resolves through a real i18next instance in both languages", async () => {
    const en = await createI18n({ lng: "en" });
    const tr = await createI18n({ lng: "tr" });
    const tEn = en.t as unknown as TranslateFn;
    const tTr = tr.t as unknown as TranslateFn;

    expect(resolveSystemMessage("@sys:member_joined", "Ali", tEn)).toBe("Ali joined the server");
    expect(resolveSystemMessage("@sys:member_joined", "Ali", tTr)).toBe("Ali sunucuya katıldı");
    expect(resolveSystemMessage("@sys:member_left", "Ali", tTr)).toBe("Ali sunucudan ayrıldı");
  });
});
