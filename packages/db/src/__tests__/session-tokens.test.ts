import { describe, expect, it } from "vitest";
import {
  generateSessionToken,
  hashSessionToken,
  isSessionExpired,
  sessionExpiresAt,
  tokenHashesEqual,
} from "../session-tokens.js";

describe("session tokens", () => {
  it("generates url-safe tokens with 256 bits of entropy", () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url
    expect(generateSessionToken()).not.toBe(token);
  });

  it("hashes deterministically and irreversibly (sha256 hex)", () => {
    const token = generateSessionToken();
    const hash = hashSessionToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(token)).toBe(hash);
    expect(hashSessionToken(`${token}x`)).not.toBe(hash);
    expect(hash).not.toContain(token);
  });

  it("computes expiry from a ttl in hours", () => {
    const now = new Date("2026-07-02T00:00:00.000Z");
    expect(sessionExpiresAt(now, 24).toISOString()).toBe("2026-07-03T00:00:00.000Z");
  });

  it("validates expiry boundaries", () => {
    const now = new Date("2026-07-02T12:00:00.000Z");
    expect(isSessionExpired("2026-07-02T11:59:59.999Z", now)).toBe(true);
    expect(isSessionExpired(now, now)).toBe(true); // exact instant counts as expired
    expect(isSessionExpired("2026-07-02T12:00:00.001Z", now)).toBe(false);
    expect(isSessionExpired(new Date(now.getTime() + 1), now)).toBe(false);
  });

  it("compares token hashes in constant time semantics", () => {
    const a = hashSessionToken("token-a");
    expect(tokenHashesEqual(a, a)).toBe(true);
    expect(tokenHashesEqual(a, hashSessionToken("token-b"))).toBe(false);
    expect(tokenHashesEqual(a, a.slice(0, 10))).toBe(false);
  });
});
