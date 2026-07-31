import { describe, expect, it } from "vitest";
import { resources } from "@demli/i18n";
import { ApiClientError } from "@demli/client-core";
import { blockedErrorKey, errorKey, localizeBlockedError } from "./errors";
import type { AppTFunction } from "./i18n";

/** A `t` that returns the key itself, so assertions read as key expectations. */
const echoT = ((key: string) => key) as unknown as AppTFunction;

const enErrors = resources.en.common.errors as Record<string, string>;
const trErrors = resources.tr.common.errors as Record<string, string>;

function blocked(): ApiClientError {
  return new ApiClientError("BLOCKED", "You can't do that because of a block.", 403);
}

describe("BLOCKED error mapping", () => {
  it("maps the code to a neutral generic key by default", () => {
    expect(errorKey(blocked())).toBe("errors.blocked");
  });

  it("maps each action to its own key", () => {
    expect(localizeBlockedError(blocked(), echoT, "message")).toBe("errors.blockedMessage");
    expect(localizeBlockedError(blocked(), echoT, "friendRequest")).toBe(
      "errors.blockedFriendRequest",
    );
    expect(localizeBlockedError(blocked(), echoT, "call")).toBe("errors.blockedCall");
    expect(localizeBlockedError(blocked(), echoT, "addMember")).toBe("errors.blockedAddMember");
  });

  it("leaves every other error alone", () => {
    const notFound = new ApiClientError("NOT_FOUND", "nope", 404);
    expect(localizeBlockedError(notFound, echoT, "message")).toBe("errors.notFound");
    expect(localizeBlockedError(new Error("boom"), echoT, "call")).toBe("errors.generic");
    expect(blockedErrorKey(notFound, "message")).toBeNull();
    expect(blockedErrorKey(new Error("boom"), "message")).toBeNull();
  });

  it("blockedErrorKey agrees with localizeBlockedError", () => {
    expect(blockedErrorKey(blocked(), "call")).toBe("errors.blockedCall");
  });

  // The one rule that must never regress: the API answers a single `BLOCKED`
  // code whether the VIEWER blocked the other party or the other party blocked
  // the viewer, precisely so a block cannot be detected. Copy that named a party
  // or a direction would leak exactly what the code is designed to hide (§28,
  // ADR 0017) — so the strings themselves are asserted, in both languages.
  describe("copy never discloses which side blocked", () => {
    const KEYS = [
      "blocked",
      "blockedMessage",
      "blockedFriendRequest",
      "blockedCall",
      "blockedAddMember",
    ] as const;

    // Phrases that would attribute the block to one side or the other.
    const LEAKS = [
      /blocked you/i,
      /you (?:are|were|have been) blocked/i,
      /they blocked/i,
      /has blocked/i,
      /blocked by/i,
      /seni engelle/i,
      /engellenmişsin/i,
      /engellendin/i,
      /seni engelledi/i,
      /tarafından engellen/i,
    ];

    it.each(KEYS)("en.errors.%s stays neutral", (key) => {
      const text = enErrors[key];
      expect(text, `en.errors.${key} is missing`).toBeTruthy();
      for (const leak of LEAKS) expect(text).not.toMatch(leak);
    });

    it.each(KEYS)("tr.errors.%s stays neutral", (key) => {
      const text = trErrors[key];
      expect(text, `tr.errors.${key} is missing`).toBeTruthy();
      for (const leak of LEAKS) expect(text).not.toMatch(leak);
    });

    it("has the same set of blocked keys in both languages", () => {
      const en = Object.keys(enErrors).filter((k) => k.startsWith("blocked"));
      const tr = Object.keys(trErrors).filter((k) => k.startsWith("blocked"));
      expect(new Set(en)).toEqual(new Set(tr));
    });
  });
});
