import { describe, expect, it } from "vitest";
import { charsLeft, mentionMatchLength } from "./composer-math";

describe("charsLeft", () => {
  it("counts down to zero and never below", () => {
    expect(charsLeft("", 10)).toBe(10);
    expect(charsLeft("abc", 10)).toBe(7);
    expect(charsLeft("x".repeat(12), 10)).toBe(0);
  });
  it("counts UTF-16 units, like maxLength does", () => {
    expect(charsLeft("😀", 10)).toBe(8);
  });
});

describe("mentionMatchLength", () => {
  it("matches a case-insensitive prefix", () => {
    expect(mentionMatchLength("Burak", "bu")).toBe(2);
    expect(mentionMatchLength("Burak", "BURAK")).toBe(5);
  });
  it("is Turkish-safe for I / İ / ı", () => {
    expect(mentionMatchLength("İsmail", "is")).toBe(2);
    expect(mentionMatchLength("Irmak", "ır")).toBe(2);
    expect(mentionMatchLength("ılgaz", "IL")).toBe(2);
  });
  it("returns 0 for no prefix match or an empty query", () => {
    expect(mentionMatchLength("Mert", "er")).toBe(0);
    expect(mentionMatchLength("Can", "")).toBe(0);
    expect(mentionMatchLength("Al", "Alper")).toBe(0);
  });
});
