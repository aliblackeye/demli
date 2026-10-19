/**
 * The profile save bar's honesty rule (§26). The bug this pins: changing only
 * the display name offline and pressing Save showed "Some changes didn't save.
 * What saved is kept." when nothing had been saved at all.
 */
import { describe, expect, it } from "vitest";
import { summarizeProfileSave } from "../profile-save";

describe("summarizeProfileSave", () => {
  it("a single failed PATCH is a total failure, not a partial one", () => {
    expect(summarizeProfileSave([{ id: "profile", ok: false }])).toEqual({ kind: "total", failed: ["profile"] });
  });

  it("every step failing is a total failure", () => {
    expect(
      summarizeProfileSave([
        { id: "avatar", ok: false },
        { id: "banner", ok: false },
        { id: "profile", ok: false },
      ]),
    ).toEqual({ kind: "total", failed: ["avatar", "banner", "profile"] });
  });

  it("names what landed and what did not, in Save order", () => {
    expect(
      summarizeProfileSave([
        { id: "avatar", ok: true },
        { id: "banner", ok: false },
        { id: "profile", ok: true },
      ]),
    ).toEqual({ kind: "partial", saved: ["avatar", "profile"], failed: ["banner"] });
  });

  it("everything landing is ok", () => {
    expect(
      summarizeProfileSave([
        { id: "avatar", ok: true },
        { id: "profile", ok: true },
      ]),
    ).toEqual({ kind: "ok" });
    expect(summarizeProfileSave([])).toEqual({ kind: "ok" });
  });
});
